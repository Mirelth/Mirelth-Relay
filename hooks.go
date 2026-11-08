package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Hooks 管理：读写各智能体 settings 文件顶层的 hooks 键
//（Anthropic 系通用格式 {hooks: {Event: [{matcher, hooks: [{type, command, timeout}]}]}}）。
// 写入统一走 loadForWrite + commitWithVerify：解析失败拒写、写前备份、写后回读校验失败自动回滚。

type HookEntry struct {
	ID         string `json:"id"`
	AgentID    string `json:"agentId"`
	AgentName  string `json:"agentName"`
	Color      string `json:"color"`
	Event      string `json:"event"`
	Matcher    string `json:"matcher,omitempty"`
	Command    string `json:"command"`
	Timeout    int    `json:"timeout,omitempty"`
	SourcePath string `json:"sourcePath"`
}

type HooksTarget struct {
	AgentID      string `json:"agentId"`
	AgentName    string `json:"agentName"`
	Color        string `json:"color"`
	SettingsPath string `json:"settingsPath"`
	Exists       bool   `json:"exists"`
	HookCount    int    `json:"hookCount"`
	Verified     bool   `json:"verified"`
	Note         string `json:"note,omitempty"`
}

type HookCreateInput struct {
	AgentID string `json:"agentId"`
	Event   string `json:"event"`
	Matcher string `json:"matcher"`
	Command string `json:"command"`
	Timeout int    `json:"timeout"`
}

type hookTargetDef struct {
	agentID, agentName, color, settingsPath string
	verified                                bool
	note                                    string
}

func hookTargets() []hookTargetDef {
	home := homeDir()
	return []hookTargetDef{
		{"zcode", "ZCode", "#6366f1", filepath.Join(home, ".zcode/v2/setting.json"), false,
			"配置格式与 Claude Code hooks 通用；是否被当前版本消费取决于 ZCode 版本"},
		{"claude-code", "Claude Code", "#d97706", filepath.Join(home, ".claude/settings.json"), true,
			"官方 hooks 配置格式"},
		{"codebuddy", "CodeBuddy", "#3b82f6", filepath.Join(home, ".codebuddy/settings.json"), false,
			"同 anthropic 系格式；是否生效取决于 CodeBuddy 版本"},
		{"workbuddy", "WorkBuddy", "#10b981", filepath.Join(home, ".workbuddy/settings.json"), false,
			"同 anthropic 系格式；是否生效取决于 WorkBuddy 版本"},
		{"qoder", "Qoder", "#f59e0b", filepath.Join(home, ".qoder/settings.json"), false,
			"同 anthropic 系格式；是否生效取决于 Qoder 版本"},
	}
}

// readHookGroups 读出某个 settings 文件的 hooks 段（结构不合法的键直接忽略）。
func readHookGroups(settingsPath string) map[string][]any {
	cfg := readJSON(settingsPath)
	if cfg == nil {
		return map[string][]any{}
	}
	out := map[string][]any{}
	if raw, ok := cfg["hooks"].(map[string]any); ok {
		for event, groups := range raw {
			if list, ok := groups.([]any); ok {
				out[event] = list
			}
		}
	}
	return out
}

func hookCommandOf(group map[string]any) []map[string]any {
	out := []map[string]any{}
	if list, ok := group["hooks"].([]any); ok {
		for _, item := range list {
			if h, ok := item.(map[string]any); ok {
				out = append(out, h)
			}
		}
	}
	return out
}

func (a *App) ListHooks() string {
	out := []HookEntry{}
	for _, t := range hookTargets() {
		if !exists(t.settingsPath) {
			continue
		}
		for event, groups := range readHookGroups(t.settingsPath) {
			for gi, raw := range groups {
				group, ok := raw.(map[string]any)
				if !ok {
					continue
				}
				matcher := strOf(group["matcher"])
				for _, h := range hookCommandOf(group) {
					command := strOf(h["command"])
					if command == "" {
						continue
					}
					out = append(out, HookEntry{
						ID:      t.agentID + "|" + event + "|" + itoa(int64(gi)) + "|" + command,
						AgentID: t.agentID, AgentName: t.agentName, Color: t.color,
						Event: event, Matcher: matcher, Command: command,
						Timeout: int(intOf(h["timeout"])), SourcePath: t.settingsPath,
					})
				}
			}
		}
	}
	return toJSON(out)
}

func (a *App) ListHookTargets() string {
	out := []HooksTarget{}
	for _, t := range hookTargets() {
		installed := exists(t.settingsPath)
		count := 0
		if installed {
			for _, groups := range readHookGroups(t.settingsPath) {
				count += len(groups)
			}
		}
		out = append(out, HooksTarget{
			AgentID: t.agentID, AgentName: t.agentName, Color: t.color,
			SettingsPath: t.settingsPath, Exists: installed, HookCount: count,
			Verified: t.verified, Note: t.note,
		})
	}
	return toJSON(out)
}

// writeHookGroups 把 hooks 段写回 settings 文件；空则删键。
func writeHookGroups(settingsPath string, hooks map[string][]any) (string, error) {
	cfg, err := loadForWrite(settingsPath, readJSON)
	if err != nil {
		return "", err
	}
	if cfg == nil {
		// loadForWrite 在文件不存在时返回空 map，这里不会走到；保险起见按空处理
		cfg = map[string]any{}
	}
	if len(hooks) > 0 {
		cfg["hooks"] = hooks
	} else {
		delete(cfg, "hooks")
	}

	bak, err := commitWithVerify(settingsPath, func() error {
		if err := os.MkdirAll(filepath.Dir(settingsPath), 0700); err != nil {
			return err
		}
		payload, err := json.MarshalIndent(cfg, "", "  ")
		if err != nil {
			return err
		}
		return os.WriteFile(settingsPath, append(payload, '\n'), 0600)
	}, readJSON)
	if err != nil {
		return bak, err
	}
	if bak == "" {
		return "", configWriteErr("settings 文件不存在，无法写入")
	}
	return bak, nil
}

func (a *App) CreateHook(input HookCreateInput) string {
	var target *hookTargetDef
	defs := hookTargets()
	for i := range defs {
		if defs[i].agentID == input.AgentID {
			target = &defs[i]
			break
		}
	}
	if target == nil {
		return toJSON(map[string]any{"error": "不支持在该智能体上管理 hooks"})
	}
	if !exists(target.settingsPath) {
		return toJSON(map[string]any{"error": "未检测到该智能体的 settings 文件"})
	}
	command := strings.TrimSpace(input.Command)
	if command == "" {
		return toJSON(map[string]any{"error": "命令不能为空"})
	}
	if strings.TrimSpace(input.Event) == "" {
		return toJSON(map[string]any{"error": "事件名不能为空"})
	}

	hooks := readHookGroups(target.settingsPath)
	inner := map[string]any{"type": "command", "command": command}
	if input.Timeout > 0 {
		inner["timeout"] = input.Timeout
	}
	group := map[string]any{"hooks": []any{inner}}
	if m := strings.TrimSpace(input.Matcher); m != "" {
		group["matcher"] = m
	}
	hooks[input.Event] = append(hooks[input.Event], group)

	bak, err := writeHookGroups(target.settingsPath, hooks)
	if err != nil {
		return toJSON(map[string]any{"error": err.Error(), "backupPath": bak})
	}
	return toJSON(map[string]any{"backupPath": bak})
}

func (a *App) DeleteHook(hookID string) string {
	parts := strings.Split(hookID, "|")
	if len(parts) < 4 {
		return toJSON(map[string]any{"error": "未找到对应的 hooks 配置"})
	}
	agentID, event, giText, command := parts[0], parts[1], parts[2], strings.Join(parts[3:], "|")

	var target *hookTargetDef
	defs := hookTargets()
	for i := range defs {
		if defs[i].agentID == agentID {
			target = &defs[i]
			break
		}
	}
	if target == nil || !exists(target.settingsPath) {
		return toJSON(map[string]any{"error": "未找到对应的 hooks 配置"})
	}
	gi, err := strconv.Atoi(giText)
	if err != nil {
		return toJSON(map[string]any{"error": "未找到对应 hook 条目"})
	}

	hooks := readHookGroups(target.settingsPath)
	groups, ok := hooks[event]
	if !ok || gi < 0 || gi >= len(groups) {
		return toJSON(map[string]any{"error": "未找到对应事件的 hooks"})
	}
	group, ok := groups[gi].(map[string]any)
	if !ok {
		return toJSON(map[string]any{"error": "未找到对应 hook 条目"})
	}

	kept := []any{}
	for _, h := range hookCommandOf(group) {
		if strOf(h["command"]) == command {
			continue
		}
		kept = append(kept, h)
	}
	if len(kept) == 0 {
		hooks[event] = append(groups[:gi], groups[gi+1:]...)
	} else {
		group["hooks"] = kept
		hooks[event] = groups
	}
	if len(hooks[event]) == 0 {
		delete(hooks, event)
	}

	bak, err := writeHookGroups(target.settingsPath, hooks)
	if err != nil {
		return toJSON(map[string]any{"error": err.Error(), "backupPath": bak})
	}
	return toJSON(map[string]any{"backupPath": bak})
}
