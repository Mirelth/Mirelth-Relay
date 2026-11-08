package main

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// 这一组适配器结构简单：探测目录 → 列出配置/数据目录 → 收集技能与 MCP 条目。
// 用量要么没有，要么来自各自的小库，逐个在文件里单独处理。

// ---------- ycli ----------

type ycliScanner struct{}

func (ycliScanner) Meta() ScannerMeta {
	return ScannerMeta{
		ID: "ycli", Name: "ycli", Kind: "cli", Color: "#64748b",
		Probes:      []string{filepath.Join(homeDir(), ".ycli")},
		InstallBins: []string{"ycli"},
	}
}

func (ycliScanner) Scan() AgentSnapshot {
	meta := ycliScanner{}.Meta()
	home := filepath.Join(homeDir(), ".ycli")
	detected := exists(home)
	snap := emptySnapshot(meta, detected)
	if !detected {
		return snap
	}
	configPath := filepath.Join(home, "config.yaml")
	if cfg := readYAML(configPath); cfg != nil {
		snap.Configs = []ConfigFileInfo{{Path: configPath, Exists: true, Summary: redact(cfg).(map[string]any)}}
	} else {
		snap.Configs = []ConfigFileInfo{{Path: configPath, Exists: false}}
	}
	snap.DataDirs = dataDirs([][2]string{{home, "数据目录"}, {filepath.Join(home, "logs"), "日志"}})
	// session.db 只存记忆 episodes，没有 token 字段，所以不算有用量。
	return finalize(snap)
}

// ---------- Hub ----------

type hubScanner struct{}

func (hubScanner) Meta() ScannerMeta {
	return ScannerMeta{
		ID: "hub", Name: "Hub", Kind: "cli", Color: "#14b8a6",
		Probes: []string{filepath.Join(homeDir(), ".hub")},
	}
}

func (hubScanner) Scan() AgentSnapshot {
	meta := hubScanner{}.Meta()
	home := filepath.Join(homeDir(), ".hub")
	detected := exists(home)
	snap := emptySnapshot(meta, detected)
	if !detected {
		return snap
	}
	basePath := filepath.Join(home, ".config-v2/base.json")
	base := readJSONC(basePath)
	if base != nil {
		snap.Configs = []ConfigFileInfo{{Path: basePath, Exists: true, Summary: redact(base).(map[string]any)}}
	} else {
		snap.Configs = []ConfigFileInfo{{Path: basePath, Exists: false}}
	}
	snap.DataDirs = dataDirs([][2]string{
		{filepath.Join(home, ".config-v2"), "配置中心"},
		{filepath.Join(home, "skills"), "技能"},
		{filepath.Join(home, "runtimes"), "运行时"},
	})
	snap.Skills = append(snap.Skills, skillsFromDir(meta.ID, filepath.Join(home, "skills"), false)...)
	snap.Skills = append(snap.Skills, skillsFromDir(meta.ID, filepath.Join(home, ".config-v2/skills"), false)...)
	if base != nil {
		snap.MCPServers = append(snap.MCPServers, mcpFromMap(base["mcp"], false)...)
	}
	return finalize(snap)
}

// ---------- Trae CN ----------

type traeScanner struct{}

func (traeScanner) Meta() ScannerMeta {
	return ScannerMeta{
		ID: "trae-cn", Name: "Trae CN", Vendor: "ByteDance", Kind: "ide", Color: "#ef4444",
		Probes:        []string{filepath.Join(homeDir(), ".trae-cn"), "/Applications/Trae CN.app"},
		InstallProbes: appPaths("Trae CN.app"),
	}
}

func (traeScanner) Scan() AgentSnapshot {
	meta := traeScanner{}.Meta()
	home := filepath.Join(homeDir(), ".trae-cn")
	detected := exists(home)
	snap := emptySnapshot(meta, detected)
	if !detected {
		return snap
	}
	snap.Info.Version = readAppBundleVersion("/Applications/Trae CN.app")
	snap.Configs = configFiles([]string{
		filepath.Join(home, "skill-config.json"),
		filepath.Join(home, "argv.json"),
	})
	snap.DataDirs = dataDirs([][2]string{
		{filepath.Join(home, "builtin_skills"), "内置技能"},
		{filepath.Join(home, "extensions"), "扩展"},
		{filepath.Join(home, "mcps"), "MCP 服务"},
		{filepath.Join(home, "memory"), "记忆库"},
		{filepath.Join(homeDir(), "Library/Application Support/Trae CN/User"), "编辑器用户数据"},
	})

	// 内置技能：builtin_skills/<name>/skill.json（注意：这里是 json，不是 SKILL.md）
	for _, name := range listEntries(filepath.Join(home, "builtin_skills")) {
		if strings.HasPrefix(name, "_") {
			continue
		}
		skillDir := filepath.Join(home, "builtin_skills", name)
		def := readJSON(filepath.Join(skillDir, "skill.json"))
		sname := name
		if v, ok := def["name"].(string); ok && v != "" {
			sname = v
		}
		desc, _ := def["description"].(string)
		snap.Skills = append(snap.Skills, SkillInfo{
			ID: skillID(meta.ID, sname, len(snap.Skills)+1), AgentID: meta.ID, Name: sname,
			Description: desc, InstalledAt: mtimeISO(skillDir), Source: skillDir, Builtin: true,
		})
	}

	// MCP：mcps/<id>/…/SERVER_METADATA.json + tools/*.json，深度限制 5 层
	mcpsRoot := filepath.Join(home, "mcps")
	for _, serverDir := range listEntries(mcpsRoot) {
		root := filepath.Join(mcpsRoot, serverDir)
		stack := []string{root}
		found := false
		for len(stack) > 0 && !found {
			cur := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			for _, entry := range listEntries(cur) {
				full := filepath.Join(cur, entry)
				if entry == "SERVER_METADATA.json" {
					md := readJSON(full)
					name, _ := md["server_name"].(string)
					if name == "" {
						name = serverDir + "/integrated_code_mode"
					}
					snap.MCPServers = append(snap.MCPServers, RawMcp{
						Name: name, Transport: "stdio", Endpoint: cur, Enabled: true,
						Tools: traeTools(filepath.Join(cur, "tools")), Status: "unverified",
						StatusDetail: "内置服务，仅检测到配置",
					})
					found = true
					break
				}
				if depthOf(full, mcpsRoot) < 5 {
					stack = append(stack, full)
				}
			}
		}
	}
	return finalize(snap)
}

func traeTools(toolsDir string) []McpTool {
	tools := []McpTool{}
	for _, t := range listEntries(toolsDir) {
		def := readJSON(filepath.Join(toolsDir, t))
		name, _ := def["name"].(string)
		if name == "" {
			name = strings.TrimSuffix(t, ".json")
		}
		desc, _ := def["description"].(string)
		if len(desc) > 120 {
			desc = desc[:120]
		}
		tools = append(tools, McpTool{Name: name, Description: desc})
	}
	return tools
}

// ---------- CodeBuddy ----------

type codebuddyScanner struct{}

func (codebuddyScanner) Meta() ScannerMeta {
	return ScannerMeta{
		ID: "codebuddy", Name: "CodeBuddy", Vendor: "Tencent", Kind: "ide", Color: "#3b82f6",
		Probes: []string{
			filepath.Join(homeDir(), ".codebuddy"),
			filepath.Join(homeDir(), ".codebuddycn"),
		},
		InstallProbes: appPaths("CodeBuddy CN.app", "CodeBuddy.app"),
	}
}

func (codebuddyScanner) Scan() AgentSnapshot {
	meta := codebuddyScanner{}.Meta()
	home := filepath.Join(homeDir(), ".codebuddy")
	detected := exists(home)
	snap := emptySnapshot(meta, detected)
	if !detected {
		return snap
	}
	snap.Configs = configFiles([]string{
		filepath.Join(home, "settings.json"),
		filepath.Join(home, "mcp.json"),
	})
	snap.DataDirs = dataDirs([][2]string{
		{filepath.Join(home, "skills"), "技能"},
		{filepath.Join(home, "skills-marketplace"), "技能市场"},
		{filepath.Join(home, "plugins"), "插件"},
		{filepath.Join(home, "memery"), "记忆库"},
	})
	snap.Skills = append(snap.Skills, skillsFromDir(meta.ID, filepath.Join(home, "skills"), false)...)
	for _, d := range listDirs(filepath.Join(home, "skills-marketplace", "skills")) {
		candidate := skillFromDir(meta.ID, d, false, len(snap.Skills)+1)
		if !hasSkillNamed(snap.Skills, candidate.Name) {
			snap.Skills = append(snap.Skills, candidate)
		}
	}
	if mcp := readJSON(filepath.Join(home, "mcp.json")); mcp != nil {
		snap.MCPServers = append(snap.MCPServers, mcpFromMap(mcp["mcpServers"], false)...)
	}
	return finalize(snap)
}

// ---------- WorkBuddy ----------

type workbuddyScanner struct{}

func (workbuddyScanner) Meta() ScannerMeta {
	return ScannerMeta{
		ID: "workbuddy", Name: "WorkBuddy", Vendor: "Tencent", Kind: "desktop", Color: "#10b981",
		Probes:        []string{filepath.Join(homeDir(), ".workbuddy"), "/Applications/WorkBuddy.app"},
		InstallProbes: appPaths("WorkBuddy.app"),
	}
}

func (workbuddyScanner) Scan() AgentSnapshot {
	meta := workbuddyScanner{}.Meta()
	home := filepath.Join(homeDir(), ".workbuddy")
	detected := exists(home)
	snap := emptySnapshot(meta, detected)
	if !detected {
		return snap
	}
	snap.Info.Version = readAppBundleVersion("/Applications/WorkBuddy.app")

	// 配置：JSON 解析失败但文件存在时，标记存在但摘要留空（不猜内容）
	for _, p := range []string{filepath.Join(home, "settings.json"), filepath.Join(home, ".mcp.json")} {
		raw := readJSON(p)
		info := ConfigFileInfo{Path: p}
		if raw != nil {
			info.Exists = true
			info.Summary = redact(raw).(map[string]any)
		} else if _, ok := readText(p); ok {
			info.Exists = true
			info.Summary = map[string]any{"raw": true}
		}
		snap.Configs = append(snap.Configs, info)
	}

	snap.DataDirs = dataDirs([][2]string{
		{filepath.Join(home, "skills"), "技能"},
		{filepath.Join(home, "plugins"), "插件"},
		{filepath.Join(home, "sessions"), "会话"},
		{filepath.Join(home, "projects"), "项目记录"},
		{filepath.Join(home, "memory"), "记忆库"},
		{filepath.Join(home, "connectors"), "连接器"},
	})
	snap.Skills = append(snap.Skills, skillsFromDir(meta.ID, filepath.Join(home, "skills"), false)...)

	if mcp := readJSON(filepath.Join(home, ".mcp.json")); mcp != nil {
		snap.MCPServers = append(snap.MCPServers, mcpFromMap(mcp["mcpServers"], true)...)
	}

	usage, projects := workbuddyUsage(filepath.Join(home, "workbuddy.db"))
	snap.Usage = append(snap.Usage, usage...)
	snap.ProjectDirs = append(snap.ProjectDirs, projects...)
	return finalize(snap)
}

// workbuddyUsage：sessions 左连 session_usage，used 即输入 token 总量（该工具只记这一项）。
func workbuddyUsage(dbPath string) ([]UsageRecord, []string) {
	usage := []UsageRecord{}
	projects := []string{}
	db, closer, ok := openSQLiteRO(dbPath)
	if !ok {
		return usage, projects
	}
	defer closer()

	if rows, err := db.Query(`select s.cwd, s.model, s.created_at, u.used, u.updated_at
		from sessions s left join session_usage u on u.session_id = s.id`); err == nil {
		defer rows.Close()
		for rows.Next() {
			var cwd, model sql.NullString
			var createdAt, used, updatedAt sql.NullInt64
			if err := rows.Scan(&cwd, &model, &createdAt, &used, &updatedAt); err != nil {
				break
			}
			name := model.String
			if name == "" {
				name = "unknown"
			}
			if used.Valid && used.Int64 > 0 {
				ts := updatedAt.Int64
				if ts == 0 {
					ts = createdAt.Int64
				}
				if ts == 0 {
					ts = time.Now().UnixMilli()
				}
				usage = append(usage, UsageRecord{
					TS: ts, Model: name, InputTokens: used.Int64, Requests: 1,
				})
			}
			if cwd.String != "" {
				projects = append(projects, cwd.String)
			}
		}
	}
	if rows, err := db.Query(`select path from workspaces`); err == nil {
		defer rows.Close()
		for rows.Next() {
			var p sql.NullString
			if err := rows.Scan(&p); err != nil {
				break
			}
			if p.String != "" {
				projects = append(projects, p.String)
			}
		}
	}
	return usage, projects
}

// ---------- AgnesCode ----------

type agnesScanner struct{}

func (agnesScanner) Meta() ScannerMeta {
	return ScannerMeta{
		ID: "agnes", Name: "AgnesCode", Vendor: "Agnes", Kind: "desktop", Color: "#ec4899",
		Probes:        []string{filepath.Join(homeDir(), ".agnes"), "/Applications/AgnesCode.app"},
		InstallProbes: appPaths("AgnesCode.app"),
	}
}

func (agnesScanner) Scan() AgentSnapshot {
	meta := agnesScanner{}.Meta()
	home := filepath.Join(homeDir(), ".agnes")
	detected := exists(home)
	snap := emptySnapshot(meta, detected)
	if !detected {
		return snap
	}
	snap.Info.Version = readAppBundleVersion("/Applications/AgnesCode.app")

	configPath := filepath.Join(home, "config/config.yaml")
	config := readYAML(configPath)
	if config != nil {
		snap.Configs = []ConfigFileInfo{{Path: configPath, Exists: true, Summary: redact(config).(map[string]any)}}
	} else {
		snap.Configs = []ConfigFileInfo{{Path: configPath, Exists: false}}
	}

	snap.DataDirs = dataDirs([][2]string{
		{filepath.Join(home, "data/sessions"), "会话数据库"},
		{filepath.Join(home, "data"), "数据目录"},
		{filepath.Join(home, "memories"), "记忆库"},
		{filepath.Join(home, "state"), "运行状态"},
	})

	// 技能直接来自 config.yaml 的 extensions（没有独立技能目录）
	if config != nil {
		if ext, ok := config["extensions"].(map[string]any); ok {
			for key, raw := range ext {
				entry, _ := raw.(map[string]any)
				name := firstNonEmpty(strOf(entry["display_name"]), strOf(entry["name"]), key)
				desc := strOf(entry["description"])
				builtin, _ := entry["builtin"].(bool)
				snap.Skills = append(snap.Skills, SkillInfo{
					ID: meta.ID + ":ext:" + key, AgentID: meta.ID, Name: name,
					Description: desc, Source: configPath, Builtin: builtin,
				})
			}
		}
	}

	usage, projects := agnesUsage(filepath.Join(home, "data/sessions/sessions.db"))
	snap.Usage = append(snap.Usage, usage...)
	snap.ProjectDirs = append(snap.ProjectDirs, projects...)
	return finalize(snap)
}

func agnesUsage(dbPath string) ([]UsageRecord, []string) {
	usage := []UsageRecord{}
	projects := []string{}
	db, closer, ok := openSQLiteRO(dbPath)
	if !ok {
		return usage, projects
	}
	defer closer()

	rows, err := db.Query(`select l.created_timestamp, l.model, l.input_tokens, l.output_tokens,
		l.cache_read_tokens, l.cache_write_tokens, l.cost, s.working_dir
		from usage_ledger l left join sessions s on s.id = l.session_id`)
	if err != nil {
		return usage, projects
	}
	defer rows.Close()
	for rows.Next() {
		var createdAt sql.NullInt64
		var model, workingDir sql.NullString
		var in, out, cacheRead, cacheWrite sql.NullInt64
		var cost sql.NullFloat64
		if err := rows.Scan(&createdAt, &model, &in, &out, &cacheRead, &cacheWrite, &cost, &workingDir); err != nil {
			break
		}
		// 秒级时间戳统一成毫秒（该工具老版本写秒）
		ts := createdAt.Int64
		if ts > 0 && ts < 1e12 {
			ts *= 1000
		}
		name := model.String
		if name == "" {
			name = "unknown"
		}
		usage = append(usage, UsageRecord{
			TS: ts, Model: name, InputTokens: in.Int64, OutputTokens: out.Int64,
			CacheReadTokens: cacheRead.Int64, CacheWriteTokens: cacheWrite.Int64,
			Requests: 1, CostUSD: cost.Float64,
		})
		if workingDir.String != "" {
			projects = append(projects, workingDir.String)
		}
	}
	return usage, projects
}

// ---------- 共用小工具 ----------

func hasSkillNamed(skills []SkillInfo, name string) bool {
	for _, s := range skills {
		if s.Name == name {
			return true
		}
	}
	return false
}

func strOf(v any) string {
	s, _ := v.(string)
	return s
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// depthOf 返回 child 相对 root 的层级。
func depthOf(child, root string) int {
	rel, err := filepath.Rel(root, child)
	if err != nil {
		return 99
	}
	return len(strings.Split(rel, string(os.PathSeparator)))
}

// openSQLiteRO 只读打开第三方库；文件不存在或打不开时 ok=false，调用方按「没有数据」处理。
func openSQLiteRO(path string) (*sql.DB, func(), bool) {
	if !exists(path) {
		return nil, func() {}, false
	}
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		return nil, func() {}, false
	}
	return db, func() { _ = db.Close() }, true
}
