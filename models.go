package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// 模型配置：Profile 本地存储 + 各智能体写入器（对应 src/main/models/{store,appliers}.ts）。
// 写入原则与 hooks 一致：解析失败拒写、写前备份、写后回读校验、失败自动回滚。

type ModelDef struct {
	ID            string `json:"id"`
	Name          string `json:"name,omitempty"`
	ContextWindow int    `json:"contextWindow,omitempty"`
	MaxTokens     int    `json:"maxTokens,omitempty"`
}

type ModelProfile struct {
	ID           string     `json:"id"`
	Name         string     `json:"name"`
	Kind         string     `json:"kind"` // anthropic | openai-compatible
	BaseURL      string     `json:"baseURL"`
	APIKey       string     `json:"apiKey"`
	Models       []ModelDef `json:"models"`
	DefaultModel string     `json:"defaultModel,omitempty"`
	UpdatedAt    string     `json:"updatedAt"`
}

type ModelProfileView struct {
	ID           string     `json:"id"`
	Name         string     `json:"name"`
	Kind         string     `json:"kind"`
	BaseURL      string     `json:"baseURL"`
	Models       []ModelDef `json:"models"`
	DefaultModel string     `json:"defaultModel,omitempty"`
	UpdatedAt    string     `json:"updatedAt"`
	APIKeyMasked string     `json:"apiKeyMasked"`
	HasAPIKey    bool       `json:"hasApiKey"`
}

type ApplierInfo struct {
	AgentID   string `json:"agentId"`
	AgentName string `json:"agentName"`
	Color     string `json:"color"`
	Support   string `json:"support"` // full | partial | none
	Note      string `json:"note,omitempty"`
	Current   string `json:"current"`
}

type ApplyOptions struct {
	SetDefault bool `json:"setDefault"`
}

type ApplyResult struct {
	AgentID    string `json:"agentId"`
	AgentName  string `json:"agentName"`
	OK         bool   `json:"ok"`
	Message    string `json:"message"`
	BackupPath string `json:"backupPath,omitempty"`
}

func modelProfilesPath() string { return filepath.Join(configDir(), "model-profiles.json") }

func loadModelProfiles() []ModelProfile {
	var raw struct {
		Profiles []ModelProfile `json:"profiles"`
	}
	b, err := os.ReadFile(modelProfilesPath())
	if err != nil {
		return []ModelProfile{}
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return []ModelProfile{}
	}
	if raw.Profiles == nil {
		return []ModelProfile{}
	}
	return raw.Profiles
}

func saveModelProfiles(profiles []ModelProfile) error {
	if err := os.MkdirAll(configDir(), 0700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(map[string]any{"profiles": profiles}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(modelProfilesPath(), b, 0600)
}

func maskProfileKey(key string) string {
	if key == "" {
		return ""
	}
	if len(key) <= 8 {
		return "••••••••"
	}
	return key[:4] + "••••••••" + key[len(key)-4:]
}

func toProfileView(p ModelProfile) ModelProfileView {
	return ModelProfileView{
		ID: p.ID, Name: p.Name, Kind: p.Kind, BaseURL: p.BaseURL, Models: p.Models,
		DefaultModel: p.DefaultModel, UpdatedAt: p.UpdatedAt,
		APIKeyMasked: maskProfileKey(p.APIKey), HasAPIKey: p.APIKey != "",
	}
}

func (a *App) ListModelProfiles() string {
	profiles := loadModelProfiles()
	sort.SliceStable(profiles, func(i, j int) bool { return profiles[i].UpdatedAt > profiles[j].UpdatedAt })
	out := make([]ModelProfileView, 0, len(profiles))
	for _, p := range profiles {
		out = append(out, toProfileView(p))
	}
	return toJSON(out)
}

// SaveModelProfile 落库；前端回传的 apiKey 若为空或已脱敏，保留原值。
func (a *App) SaveModelProfile(raw string) string {
	var incoming ModelProfile
	if err := json.Unmarshal([]byte(raw), &incoming); err != nil {
		return toJSON(map[string]any{"ok": false, "error": err.Error()})
	}
	if strings.TrimSpace(incoming.ID) == "" {
		return toJSON(map[string]any{"ok": false, "error": "缺少 profile id"})
	}
	profiles := loadModelProfiles()
	replaced := false
	for i := range profiles {
		if profiles[i].ID != incoming.ID {
			continue
		}
		if incoming.APIKey == "" || strings.Contains(incoming.APIKey, "••") {
			incoming.APIKey = profiles[i].APIKey
		}
		incoming.UpdatedAt = time.Now().Format(time.RFC3339)
		profiles[i] = incoming
		replaced = true
	}
	if !replaced {
		incoming.UpdatedAt = time.Now().Format(time.RFC3339)
		profiles = append(profiles, incoming)
	}
	if err := saveModelProfiles(profiles); err != nil {
		return toJSON(map[string]any{"ok": false, "error": err.Error()})
	}
	return toJSON(map[string]any{"ok": true})
}

func (a *App) DeleteModelProfile(id string) string {
	profiles := loadModelProfiles()
	kept := make([]ModelProfile, 0, len(profiles))
	for _, p := range profiles {
		if p.ID != id {
			kept = append(kept, p)
		}
	}
	if err := saveModelProfiles(kept); err != nil {
		return toJSON(map[string]any{"ok": false, "error": err.Error()})
	}
	return toJSON(map[string]any{"ok": true})
}

// ---------- 写入器 ----------

type applier struct {
	agentID    string
	agentName  string
	color      string
	support    string
	note       string
	configPath string
	read       func(string) map[string]any
	write      func(string, map[string]any) error
	current    func(map[string]any) string
	apply      func(a *applier, cfg map[string]any, profile ModelProfile, opts ApplyOptions) string
}

func writeJSONFile(path string, data map[string]any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(b, '\n'), 0600)
}

func writeYAMLFile(path string, data map[string]any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	b, err := yaml.Marshal(data)
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0600)
}

func appliers() []*applier {
	home := homeDir()
	return []*applier{
		{
			agentID: "zcode", agentName: "ZCode", color: "#6366f1", support: "full",
			configPath: filepath.Join(home, ".zcode/v2/config.json"),
			read:       readJSON, write: writeJSONFile,
			current: func(cfg map[string]any) string {
				providers, _ := cfg["provider"].(map[string]any)
				if len(providers) == 0 {
					return "未配置自定义供应商"
				}
				names := make([]string, 0, len(providers))
				for k, raw := range providers {
					entry, _ := raw.(map[string]any)
					if on, ok := entry["enabled"].(bool); ok && !on {
						k += "（停用）"
					}
					names = append(names, k)
				}
				sort.Strings(names)
				return strings.Join(names, "、")
			},
			apply: func(ap *applier, cfg map[string]any, profile ModelProfile, opts ApplyOptions) string {
				providers, _ := cfg["provider"].(map[string]any)
				if providers == nil {
					providers = map[string]any{}
				}
				key := "agentmgr:" + profile.ID
				kind := "openai"
				if profile.Kind == "anthropic" {
					kind = "anthropic"
				}
				models := map[string]any{}
				for _, m := range profile.Models {
					entry := map[string]any{}
					if m.Name != "" && m.Name != m.ID {
						entry["name"] = m.Name
					}
					if m.ContextWindow > 0 {
						output := m.MaxTokens
						if output == 0 {
							output = 8192
						}
						entry["limit"] = map[string]any{"context": m.ContextWindow, "output": output}
					}
					models[m.ID] = entry
				}
				providers[key] = map[string]any{
					"name":    profile.Name,
					"kind":    kind,
					"options": map[string]any{"baseURL": profile.BaseURL, "apiKey": profile.APIKey},
					"enabled": true,
					"source":  "custom",
					"models":  models,
				}
				cfg["provider"] = providers
				msg := "已写入供应商 " + key
				if opts.SetDefault && profile.DefaultModel != "" {
					msg += "，默认模型设为 " + profile.DefaultModel + "（请在 ZCode 设置中选择该供应商）"
				}
				return msg
			},
		},
		{
			agentID: "opencode", agentName: "OpenCode", color: "#f97316", support: "full",
			note:       "写入时整文件按标准 JSON 序列化，原文件中的注释会被移除（写前自动备份）",
			configPath: filepath.Join(home, ".config/opencode/opencode.jsonc"),
			read:       readJSONC, write: writeJSONFile,
			current: opencodeCurrent,
			apply:   opencodeApply,
		},
		{
			agentID: "loomy", agentName: "Loomy OpenCode", color: "#06b6d4", support: "full",
			configPath: filepath.Join(home, ".config/loomy-opencode/opencode.json"),
			read:       readJSON, write: writeJSONFile,
			current: opencodeCurrent,
			apply:   opencodeApply,
		},
		{
			agentID: "ycli", agentName: "ycli", color: "#64748b", support: "full",
			note:       "单供应商配置，写入会替换当前 provider/model/api_key/base_url（已自动备份）",
			configPath: filepath.Join(home, ".ycli/config.yaml"),
			read:       readYAML, write: writeYAMLFile,
			current: func(cfg map[string]any) string {
				provider := strOf(cfg["provider"])
				if provider == "" {
					return "未配置"
				}
				return provider + " / " + firstNonEmpty(strOf(cfg["model"]), "?") +
					"（" + firstNonEmpty(strOf(cfg["base_url"]), "?") + "）"
			},
			apply: func(ap *applier, cfg map[string]any, profile ModelProfile, opts ApplyOptions) string {
				model := profile.DefaultModel
				if model == "" && len(profile.Models) > 0 {
					model = profile.Models[0].ID
				}
				cfg["provider"] = "openai"
				cfg["model"] = model
				cfg["api_key"] = profile.APIKey
				cfg["base_url"] = profile.BaseURL
				return "已写入 provider=openai, model=" + model
			},
		},
		dshApplier("dsh-web", "DSH Web", filepath.Join(home, ".dsh/settings.yaml")),
		dshApplier("dsh-desktop", "DSH Desktop", filepath.Join(home, ".dsh-desktop/settings.yaml")),
	}
}

func opencodeCurrent(cfg map[string]any) string {
	providers, _ := cfg["provider"].(map[string]any)
	ids := make([]string, 0, len(providers))
	for k := range providers {
		ids = append(ids, k)
	}
	if len(ids) == 0 {
		return "未配置自定义供应商"
	}
	sort.Strings(ids)
	text := strings.Join(ids, "、")
	if model := strOf(cfg["model"]); model != "" {
		text += "（默认 " + model + "）"
	}
	return text
}

func opencodeApply(ap *applier, cfg map[string]any, profile ModelProfile, opts ApplyOptions) string {
	providers, _ := cfg["provider"].(map[string]any)
	if providers == nil {
		providers = map[string]any{}
	}
	npm := "@ai-sdk/openai-compatible"
	if profile.Kind == "anthropic" {
		npm = "@ai-sdk/anthropic"
	}
	models := map[string]any{}
	for _, m := range profile.Models {
		entry := map[string]any{}
		if m.Name != "" && m.Name != m.ID {
			entry["name"] = m.Name
		}
		models[m.ID] = entry
	}
	providers[profile.ID] = map[string]any{
		"npm": npm, "name": profile.Name,
		"options": map[string]any{"baseURL": profile.BaseURL, "apiKey": profile.APIKey},
		"models":  models,
	}
	cfg["provider"] = providers
	msg := "已写入供应商 " + profile.ID
	if opts.SetDefault && profile.DefaultModel != "" {
		cfg["model"] = profile.ID + "/" + profile.DefaultModel
		msg += "，默认模型设为 " + profile.ID + "/" + profile.DefaultModel
	}
	return msg
}

func dshApplier(agentID, agentName, cfgPath string) *applier {
	return &applier{
		agentID: agentID, agentName: agentName, color: "#8b5cf6", support: "partial",
		note:       "DSH 通过环境变量读取 API key：写入后需设置环境变量并在启动 DSH 前导出",
		configPath: cfgPath,
		read:       readYAML, write: writeYAMLFile,
		current: func(cfg map[string]any) string {
			llm, _ := cfg["llm-pi-ai"].(map[string]any)
			providers, _ := llm["providers"].(map[string]any)
			ids := make([]string, 0, len(providers))
			for k := range providers {
				ids = append(ids, k)
			}
			if len(ids) == 0 {
				return "未配置自定义供应商"
			}
			sort.Strings(ids)
			text := strings.Join(ids, "、")
			if def, ok := cfg["agent-default-model"].(map[string]any); ok {
				if p := strOf(def["provider"]); p != "" {
					text += "（默认 " + p + "/" + strOf(def["model"]) + "）"
				}
			}
			return text
		},
		apply: func(ap *applier, cfg map[string]any, profile ModelProfile, opts ApplyOptions) string {
			envName := "AGENTMGR_" + envKeyPart(profile.ID) + "_API_KEY"
			llm, _ := cfg["llm-pi-ai"].(map[string]any)
			if llm == nil {
				llm = map[string]any{}
			}
			providers, _ := llm["providers"].(map[string]any)
			if providers == nil {
				providers = map[string]any{}
			}
			models := []any{}
			for _, m := range profile.Models {
				entry := map[string]any{"id": m.ID}
				if m.Name != "" {
					entry["name"] = m.Name
				}
				if m.ContextWindow > 0 {
					entry["contextWindow"] = m.ContextWindow
				}
				if m.MaxTokens > 0 {
					entry["maxTokens"] = m.MaxTokens
				}
				models = append(models, entry)
			}
			providers[profile.ID] = map[string]any{
				"displayName": profile.Name,
				"apiKeyEnv":   envName,
				"api":         "openai-completions",
				"baseURL":     profile.BaseURL,
				"models":      models,
			}
			llm["providers"] = providers
			cfg["llm-pi-ai"] = llm
			if opts.SetDefault && profile.DefaultModel != "" {
				cfg["agent-default-model"] = map[string]any{"provider": profile.ID, "model": profile.DefaultModel}
			}
			hint := ""
			if profile.APIKey != "" {
				hint = "=" + maskProfileKey(profile.APIKey)
			}
			return "已写入供应商 " + profile.ID + "；请设置环境变量 " + envName + hint + " 后重启 DSH 生效"
		},
	}
}

// envKeyPart 把 profile id 变成合法环境变量片段。
func envKeyPart(id string) string {
	var b strings.Builder
	for _, r := range strings.ToUpper(id) {
		if (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		} else {
			b.WriteByte('_')
		}
	}
	return b.String()
}

var unsupportedAppliers = []ApplierInfo{
	{AgentID: "trae-cn", AgentName: "Trae CN", Color: "#ef4444", Support: "none", Note: "模型配置存在应用内部数据库，无法安全写入", Current: "—"},
	{AgentID: "qoder", AgentName: "Qoder", Color: "#f59e0b", Support: "none", Note: "模型配置由应用账号体系管理", Current: "—"},
	{AgentID: "codebuddy", AgentName: "CodeBuddy", Color: "#3b82f6", Support: "none", Note: "模型配置存在应用内部数据库", Current: "—"},
	{AgentID: "workbuddy", AgentName: "WorkBuddy", Color: "#10b981", Support: "none", Note: "模型配置存在应用内部数据库", Current: "—"},
	{AgentID: "agnes", AgentName: "AgnesCode", Color: "#ec4899", Support: "none", Note: "使用平台内置 OAuth 供应商体系", Current: "—"},
}

func (a *App) ListAppliers() string {
	out := []ApplierInfo{}
	for _, ap := range appliers() {
		info := ApplierInfo{
			AgentID: ap.agentID, AgentName: ap.agentName, Color: ap.color,
			Support: ap.support, Note: ap.note, Current: "未检测到配置文件",
		}
		if exists(ap.configPath) {
			info.Current = "读取失败"
			if cfg := ap.read(ap.configPath); cfg != nil {
				info.Current = ap.current(cfg)
			}
		} else {
			info.Support = "none"
			info.Note = "未检测到该智能体"
		}
		out = append(out, info)
	}
	return toJSON(append(out, unsupportedAppliers...))
}

// ApplyModelProfile 下发到多个智能体；每个目标独立成败，单点失败不影响其他。
func (a *App) ApplyModelProfile(profileID string, agentIDs []string, optsJSON string) string {
	var opts ApplyOptions
	if optsJSON != "" {
		_ = json.Unmarshal([]byte(optsJSON), &opts)
	}

	var profile *ModelProfile
	for _, p := range loadModelProfiles() {
		if p.ID == profileID {
			copied := p
			profile = &copied
			break
		}
	}
	results := []ApplyResult{}
	if profile == nil {
		for _, id := range agentIDs {
			results = append(results, ApplyResult{AgentID: id, AgentName: id, OK: false, Message: "未找到模型配置"})
		}
		return toJSON(results)
	}

	byID := map[string]*applier{}
	for _, ap := range appliers() {
		byID[ap.agentID] = ap
	}
	for _, id := range agentIDs {
		ap, ok := byID[id]
		if !ok {
			results = append(results, ApplyResult{AgentID: id, AgentName: id, OK: false, Message: "不支持自动配置"})
			continue
		}
		if !exists(ap.configPath) {
			results = append(results, ApplyResult{AgentID: id, AgentName: ap.agentName, OK: false, Message: "未检测到配置文件"})
			continue
		}
		cfg, err := loadForWrite(ap.configPath, ap.read)
		if err != nil {
			results = append(results, ApplyResult{AgentID: id, AgentName: ap.agentName, OK: false, Message: err.Error()})
			continue
		}
		message := ap.apply(ap, cfg, *profile, opts)
		bak, err := commitWithVerify(ap.configPath, func() error { return ap.write(ap.configPath, cfg) }, ap.read)
		if err != nil {
			results = append(results, ApplyResult{AgentID: id, AgentName: ap.agentName, OK: false, Message: err.Error(), BackupPath: bak})
			continue
		}
		results = append(results, ApplyResult{
			AgentID: id, AgentName: ap.agentName, OK: true, Message: message, BackupPath: bak,
		})
	}
	return toJSON(results)
}

// FetchModelCatalog 拉取供应商的模型清单（只读，用于填充 Profile 的模型列表）。
func (a *App) FetchModelCatalog(baseURL, apiKey, kind string) string {
	base := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if base == "" {
		return toJSON(map[string]any{"ok": false, "error": "缺少 Base URL", "models": []any{}})
	}
	req, err := http.NewRequest(http.MethodGet, base+"/models", nil)
	if err != nil {
		return toJSON(map[string]any{"ok": false, "error": err.Error(), "models": []any{}})
	}
	if kind == "anthropic" {
		req.Header.Set("x-api-key", apiKey)
		req.Header.Set("anthropic-version", "2023-06-01")
	} else {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return toJSON(map[string]any{"ok": false, "error": err.Error(), "models": []any{}})
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return toJSON(map[string]any{
			"ok": false, "error": fmt.Sprintf("上游返回 HTTP %d", resp.StatusCode), "models": []any{},
		})
	}

	var parsed struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
		Models []struct {
			ID          string `json:"id"`
			DisplayName string `json:"display_name"`
		} `json:"models"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return toJSON(map[string]any{"ok": false, "error": "无法解析模型清单", "models": []any{}})
	}
	models := []map[string]any{}
	seen := map[string]bool{}
	for _, m := range parsed.Data {
		if m.ID != "" && !seen[m.ID] {
			seen[m.ID] = true
			models = append(models, map[string]any{"id": m.ID})
		}
	}
	for _, m := range parsed.Models {
		if m.ID != "" && !seen[m.ID] {
			seen[m.ID] = true
			models = append(models, map[string]any{"id": m.ID, "name": m.DisplayName})
		}
	}
	sort.SliceStable(models, func(i, j int) bool { return strOf(models[i]["id"]) < strOf(models[j]["id"]) })
	return toJSON(map[string]any{"ok": true, "models": models})
}
