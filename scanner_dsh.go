package main

import (
	"encoding/json"
	"path/filepath"
	"strings"
)

// DSH 家族：同一引擎两种分发形态，数据目录不同，作为两个独立实体分别统计。
//   - DSH Web：~/.dsh/sessions
//   - DSH Desktop：~/.dsh-desktop/sessions
//
// 用量格式一致：sessions/<项目>/<会话>/session.jsonl.zstd，逐请求一行 usage，
// 时间戳与模型名都是真实值（旧的按天粗聚 json 已弃用）。

const dshDesktopApp = "DeepSeek Harness Desktop.app"

type dshScanner struct {
	id     string
	name   string
	home   string
	color  string
	appTag string // 桌面版才有应用包本体证据
}

func (s dshScanner) Meta() ScannerMeta {
	home := filepath.Join(homeDir(), s.home)
	meta := ScannerMeta{
		ID: s.id, Name: s.name, Vendor: "DeepSeek", Kind: "desktop", Color: s.color,
		Probes: []string{home},
	}
	if s.appTag != "" {
		// 桌面版是绿色分发的 .app：/Applications、用户级目录或任意挂载卷里都可能
		meta.InstallProbeResolver = func() []string {
			paths := appPaths(dshDesktopApp)
			if onVol := findAppOnVolumes(dshDesktopApp, 4); onVol != "" {
				paths = append(paths, onVol)
			}
			return paths
		}
	}
	return meta
}

func (s dshScanner) Scan() AgentSnapshot {
	meta := s.Meta()
	home := filepath.Join(homeDir(), s.home)
	detected := exists(home)
	snap := emptySnapshot(meta, detected)
	if !detected {
		return snap
	}

	settingsPath := filepath.Join(home, "settings.yaml")
	if cfg := readYAML(settingsPath); cfg != nil {
		snap.Configs = []ConfigFileInfo{{Path: settingsPath, Exists: true, Summary: redact(cfg).(map[string]any)}}
	} else {
		snap.Configs = []ConfigFileInfo{{Path: settingsPath, Exists: false}}
	}

	snap.DataDirs = dataDirs([][2]string{
		{filepath.Join(home, "sessions"), "会话记录"},
		{filepath.Join(home, "memory"), "记忆库"},
		{filepath.Join(home, ".agent-presets"), "智能体预设"},
		{filepath.Join(home, "storages"), "存储缓存"},
	})

	// 技能：.agent-presets 下的条目视为预设清单
	presetDir := filepath.Join(home, ".agent-presets")
	for _, name := range listEntries(presetDir) {
		snap.Skills = append(snap.Skills, SkillInfo{
			ID: meta.ID + ":preset:" + name, AgentID: meta.ID, Name: name,
			Source: filepath.Join(presetDir, name),
		})
	}

	usage, projects := scanDSHSessions(filepath.Join(home, "sessions"), 2000)
	snap.Usage = append(snap.Usage, usage...)
	snap.ProjectDirs = append(snap.ProjectDirs, projects...)
	return finalize(snap)
}

// parseDSHSession 解析一份会话日志文本（纯函数，便于单测）。
// 只认三类行：session（拿 cwd）、request/header（拿 model）、assistant/chunk 里的 usage。
func parseDSHSession(text string) ([]UsageRecord, string) {
	usage := []UsageRecord{}
	cwd := ""
	model := "unknown"

	for _, line := range strings.Split(text, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var entry map[string]any
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			continue
		}
		data, _ := entry["data"].(map[string]any)
		switch strOf(entry["type"]) {
		case "session":
			if v := strOf(entry["cwd"]); v != "" {
				cwd = v
			}
		case "request/header":
			header, _ := data["header"].(map[string]any)
			config, _ := header["config"].(map[string]any)
			if v := strOf(config["model"]); v != "" {
				model = v
			}
		case "assistant/chunk":
			chunk, _ := data["chunk"].(map[string]any)
			if strOf(chunk["type"]) != "usage" {
				continue
			}
			u, _ := chunk["usage"].(map[string]any)
			ts := int64(0)
			if f, ok := entry["time"].(float64); ok {
				ts = int64(f)
			}
			usage = append(usage, UsageRecord{
				TS: ts, Model: model,
				InputTokens:      intOf(u["inputTokens"]),
				OutputTokens:     intOf(u["outputTokens"]),
				CacheReadTokens:  intOf(u["cacheReadTokens"]),
				CacheWriteTokens: intOf(u["cacheWriteTokens"]),
				ReasoningTokens:  intOf(u["reasoningTokens"]),
				Requests:         1,
			})
		}
	}
	return usage, cwd
}

// scanDSHSessions 遍历 sessions 树并解 zstd；单个会话损坏只跳过它。
func scanDSHSessions(sessionsDir string, cap int) ([]UsageRecord, []string) {
	usage := []UsageRecord{}
	projects := []string{}
	files := 0
	for _, proj := range listDirs(sessionsDir) {
		for _, sess := range listDirs(proj) {
			file := filepath.Join(sess, "session.jsonl.zstd")
			if !exists(file) {
				continue
			}
			files++
			if files > cap {
				return usage, projects
			}
			text := decompressZstdFile(file)
			if text == "" {
				continue
			}
			got, cwd := parseDSHSession(text)
			usage = append(usage, got...)
			if cwd != "" {
				projects = append(projects, cwd)
			}
		}
	}
	return usage, projects
}

func intOf(v any) int64 {
	switch typed := v.(type) {
	case float64:
		return int64(typed)
	case int64:
		return typed
	case int:
		return int64(typed)
	default:
		return 0
	}
}
