package main

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"time"
)

// Qoder（阿里）适配器。它不上报 token：输入按 context_usage_ratio × 上下文窗口估算，
// 输出按 assistant 内容长度估算，成本用 credits / 汇率折算——都是估算值，页面靠 hasUsage 区分「有数据」。
const (
	qoderContextWindow = 200000
	defaultRateUSDCNY  = 7.2
)

type qoderScanner struct{}

func (qoderScanner) Meta() ScannerMeta {
	return ScannerMeta{
		ID: "qoder", Name: "Qoder", Vendor: "Alibaba", Kind: "ide", Color: "#f59e0b",
		Probes:        []string{filepath.Join(homeDir(), ".qoder"), "/Applications/Qoder.app"},
		InstallProbes: appPaths("Qoder.app"),
	}
}

func (qoderScanner) Scan() AgentSnapshot {
	meta := qoderScanner{}.Meta()
	home := filepath.Join(homeDir(), ".qoder")
	detected := exists(home)
	snap := emptySnapshot(meta, detected)
	if !detected {
		return snap
	}
	snap.Info.Version = readAppBundleVersion("/Applications/Qoder.app")
	snap.Configs = configFiles([]string{
		filepath.Join(home, "settings.json"),
		filepath.Join(home, ".qoder-app-status.json"),
	})
	snap.DataDirs = dataDirs([][2]string{
		{filepath.Join(home, "projects"), "会话记录"},
		{filepath.Join(home, "plugins"), "插件"},
		{filepath.Join(home, "logs"), "日志"},
		{filepath.Join(home, ".models"), "模型配置"},
	})

	// 技能 = 已安装插件；installed_plugins_v2.json 是主来源
	if plugins := readJSON(filepath.Join(home, "plugins/installed_plugins_v2.json")); plugins != nil {
		if installed, ok := plugins["plugins"].(map[string]any); ok {
			for key, raw := range installed {
				name := strings.Split(key, "@")[0]
				if name == "" {
					name = key
				}
				var version, installedAt, installPath string
				if list, ok := raw.([]any); ok && len(list) > 0 {
					if first, ok := list[0].(map[string]any); ok {
						version = strOf(first["version"])
						installedAt = strOf(first["installedAt"])
						installPath = strOf(first["installPath"])
					}
				}
				source := installPath
				if source == "" {
					source = key
				}
				snap.Skills = append(snap.Skills, SkillInfo{
					ID: meta.ID + ":" + key, AgentID: meta.ID, Name: name,
					Version: version, InstalledAt: installedAt, Source: source,
				})
			}
		}
	}
	// 插件缓存目录也算技能来源（与已安装清单去重）
	for _, market := range listDirs(filepath.Join(home, "plugins/cache")) {
		for _, dir := range listDirs(market) {
			name := filepath.Base(dir)
			if hasSkillNamed(snap.Skills, name) {
				continue
			}
			snap.Skills = append(snap.Skills, SkillInfo{
				ID: meta.ID + ":cache:" + name, AgentID: meta.ID, Name: name, Source: dir,
			})
		}
	}

	projectsDir := filepath.Join(home, "projects")
	for _, p := range listDirs(projectsDir) {
		if decoded := decodeQoderProjectDir(filepath.Base(p)); decoded != "" {
			snap.ProjectDirs = append(snap.ProjectDirs, decoded)
		}
	}
	snap.Usage = append(snap.Usage, parseQoderUsage(projectsDir)...)
	return finalize(snap)
}

// decodeQoderProjectDir 把 '-Users-new-x' 尽力还原成 '/Users/new/x'。
// 目录名里的空格与短横线本身不可区分，所以这只是展示用路径，不保证等于真实路径。
func decodeQoderProjectDir(name string) string {
	if !strings.HasPrefix(name, "-") {
		return ""
	}
	parts := []string{}
	for _, p := range strings.Split(name, "-") {
		if p != "" {
			parts = append(parts, p)
		}
	}
	return "/" + strings.Join(parts, "/")
}

// parseQoderUsage 解析会话 JSONL 里的 usage 行（credits + 上下文占用比例）。
func parseQoderUsage(projectsDir string) []UsageRecord {
	records := []UsageRecord{}
	if !exists(projectsDir) {
		return records
	}
	for _, projectDir := range listDirs(projectsDir) {
		for _, file := range listEntries(projectDir) {
			if !strings.HasSuffix(file, ".jsonl") {
				continue
			}
			text, ok := readText(filepath.Join(projectDir, file))
			if !ok {
				continue
			}
			records = append(records, parseQoderSession(text)...)
		}
	}
	return records
}

// parseQoderSession 是纯函数，便于单测；只认 assistant 且 credits>0 的行。
func parseQoderSession(text string) []UsageRecord {
	out := []UsageRecord{}
	for _, line := range strings.Split(text, "\n") {
		if !strings.Contains(line, `"usage"`) {
			continue
		}
		var entry map[string]any
		if json.Unmarshal([]byte(line), &entry) != nil {
			continue
		}
		if strOf(entry["type"]) != "assistant" {
			continue
		}
		message, _ := entry["message"].(map[string]any)
		usage, _ := message["usage"].(map[string]any)
		credits := floatOf(usage["credits"])
		if credits <= 0 {
			continue
		}
		ts := parseISOMillis(strOf(entry["timestamp"]))
		if ts == 0 {
			continue
		}
		ratio := floatOf(usage["context_usage_ratio"])
		estInput := int64(ratio * qoderContextWindow)

		estOutput := int64(100)
		if content, ok := message["content"].([]any); ok {
			chars := 0
			for _, block := range content {
				if b, err := json.Marshal(block); err == nil {
					chars += len(b)
				}
			}
			if v := int64(chars / 3); v > estOutput {
				estOutput = v
			}
		}
		model := firstNonEmpty(strOf(message["model"]), "unknown")
		out = append(out, UsageRecord{
			TS: ts, Model: model,
			InputTokens: estInput, OutputTokens: estOutput,
			Requests: 1, CostUSD: credits / defaultRateUSDCNY,
		})
	}
	return out
}

func parseISOMillis(v string) int64 {
	if v == "" {
		return 0
	}
	if t, err := time.Parse(time.RFC3339Nano, v); err == nil {
		return t.UnixMilli()
	}
	if t, err := time.Parse(time.RFC3339, v); err == nil {
		return t.UnixMilli()
	}
	return 0
}
