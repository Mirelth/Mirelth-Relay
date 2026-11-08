package main

import (
	"database/sql"
	"encoding/json"
	"path/filepath"
)

// OpenCode 家族：标准 OpenCode 与 Loomy（讯飞 fork）共用同一套数据布局。
// - 新版 session 表直接有 tokens_* / cost / model / directory 列
// - Loomy 旧版 session 表没有 token 列，token 藏在 part 表的 step-finish JSON 里
type opencodeScanner struct {
	id            string
	name          string
	vendor        string
	color         string
	configPath    string
	dataDir       string
	configAppDir  string
	installProbes []string
	installBins   []string
}

func (s opencodeScanner) Meta() ScannerMeta {
	return ScannerMeta{
		ID: s.id, Name: s.name, Vendor: s.vendor, Kind: "desktop", Color: s.color,
		Probes:        []string{s.configPath, s.dataDir},
		InstallProbes: s.installProbes, InstallBins: s.installBins,
	}
}

func (s opencodeScanner) Scan() AgentSnapshot {
	meta := s.Meta()
	detected := exists(s.configPath) || exists(s.dataDir)
	snap := emptySnapshot(meta, detected)
	if !detected {
		return snap
	}

	// 配置：jsonc，脱敏后展示（Electron 侧这里没脱敏，见迁移说明）
	info := ConfigFileInfo{Path: s.configPath, Exists: exists(s.configPath)}
	if cfg := readJSONC(s.configPath); cfg != nil {
		info.Summary = redact(cfg).(map[string]any)
	}
	snap.Configs = []ConfigFileInfo{info}

	dirs := [][2]string{
		{s.dataDir, "数据库与快照"},
		{filepath.Join(s.dataDir, "log"), "日志"},
		{filepath.Join(s.dataDir, "snapshot"), "文件快照"},
	}
	if s.configAppDir != "" {
		dirs = append(dirs, [2]string{s.configAppDir, "应用数据"})
	}
	snap.DataDirs = dataDirs(dirs)

	usage, projects := opencodeUsage(filepath.Join(s.dataDir, "opencode.db"))
	snap.Usage = append(snap.Usage, usage...)
	snap.ProjectDirs = append(snap.ProjectDirs, projects...)
	return finalize(snap)
}

func opencodeUsage(dbPath string) ([]UsageRecord, []string) {
	usage := []UsageRecord{}
	projects := []string{}
	db, closer, ok := openSQLiteRO(dbPath)
	if !ok {
		return usage, projects
	}
	defer closer()

	if rows, err := db.Query(`select distinct directory from project_directory`); err == nil {
		for rows.Next() {
			var d sql.NullString
			if err := rows.Scan(&d); err != nil {
				break
			}
			if d.String != "" {
				projects = append(projects, d.String)
			}
		}
		_ = rows.Close()
	}

	// 新版：session 表的 token 汇总列
	fromSession := false
	if rows, err := db.Query(`select directory, model, time_created, cost,
		tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write
		from session where tokens_input is not null`); err == nil {
		fromSession = true
		defer rows.Close()
		for rows.Next() {
			var directory, model sql.NullString
			var createdAt, in, out, reasoning, cacheRead, cacheWrite sql.NullInt64
			var cost sql.NullFloat64
			if err := rows.Scan(&directory, &model, &createdAt, &cost, &in, &out,
				&reasoning, &cacheRead, &cacheWrite); err != nil {
				break
			}
			usage = append(usage, UsageRecord{
				TS: createdAt.Int64, Model: opencodeModelName(model.String),
				InputTokens: in.Int64, OutputTokens: out.Int64,
				ReasoningTokens: reasoning.Int64,
				CacheReadTokens: cacheRead.Int64, CacheWriteTokens: cacheWrite.Int64,
				Requests: 1, CostUSD: cost.Float64,
			})
			if directory.String != "" {
				projects = append(projects, directory.String)
			}
		}
	}

	if fromSession {
		return usage, projects
	}

	// 旧版（Loomy）：part.step-finish 里带 tokens，模型取自所属 message
	rows, err := db.Query(`select p.data as part_data, m.data as msg_data
		from part p join message m on m.id = p.message_id
		where p.data like '%step-finish%'`)
	if err != nil {
		return usage, projects
	}
	defer rows.Close()
	for rows.Next() {
		var partData, msgData sql.NullString
		if err := rows.Scan(&partData, &msgData); err != nil {
			break
		}
		var part map[string]any
		if json.Unmarshal([]byte(partData.String), &part) != nil {
			continue
		}
		tokens, _ := part["tokens"].(map[string]any)
		if tokens == nil {
			continue
		}
		cache, _ := tokens["cache"].(map[string]any)

		model := "unknown"
		var msgTime int64
		var msg map[string]any
		if json.Unmarshal([]byte(msgData.String), &msg) == nil {
			model = firstNonEmpty(strOf(msg["modelID"]), strOf(msg["model"]), model)
			if t, ok := msg["time"].(map[string]any); ok {
				msgTime = intOf(t["created"])
			}
		}
		ts := msgTime
		if ts == 0 {
			if t, ok := part["time"].(map[string]any); ok {
				ts = intOf(t["created"])
			}
		}
		usage = append(usage, UsageRecord{
			TS: ts, Model: model,
			InputTokens: intOf(tokens["input"]), OutputTokens: intOf(tokens["output"]),
			CacheReadTokens: intOf(cache["read"]), CacheWriteTokens: intOf(cache["write"]),
			ReasoningTokens: intOf(tokens["reasoning"]),
			Requests:        1, CostUSD: floatOf(part["cost"]),
		})
	}
	if rows2, err := db.Query(`select distinct directory from session where directory is not null`); err == nil {
		for rows2.Next() {
			var d sql.NullString
			if err := rows2.Scan(&d); err != nil {
				break
			}
			if d.String != "" {
				projects = append(projects, d.String)
			}
		}
		_ = rows2.Close()
	}
	return usage, projects
}

// opencodeModelName：session.model 存的是 JSON（{"id":"…"}），解析失败就原样用。
func opencodeModelName(raw string) string {
	if raw == "" {
		return "unknown"
	}
	var m map[string]any
	if json.Unmarshal([]byte(raw), &m) == nil {
		if id := strOf(m["id"]); id != "" {
			return id
		}
	}
	return raw
}

func floatOf(v any) float64 {
	switch typed := v.(type) {
	case float64:
		return typed
	case int64:
		return float64(typed)
	default:
		return 0
	}
}

func opencodeScanners() []Scanner {
	home := homeDir()
	return []Scanner{
		opencodeScanner{
			id: "opencode", name: "OpenCode", vendor: "SST / OpenCode", color: "#f97316",
			configPath:   filepath.Join(home, ".config/opencode/opencode.jsonc"),
			dataDir:      filepath.Join(home, ".local/share/opencode"),
			configAppDir: filepath.Join(home, "Library/Application Support/ai.opencode.desktop"),
			installBins:  []string{"opencode"},
			installProbes: append([]string{filepath.Join(home, ".opencode/bin/opencode")},
				appPaths("OpenCode.app")...),
		},
		opencodeScanner{
			id: "loomy", name: "Loomy OpenCode", vendor: "iFlytek", color: "#06b6d4",
			configPath:   filepath.Join(home, ".config/loomy-opencode/opencode.json"),
			dataDir:      filepath.Join(home, ".local/share/loomy/opencode"),
			configAppDir: filepath.Join(home, ".config/loomy"),
		},
	}
}
