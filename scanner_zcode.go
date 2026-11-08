package main

import (
	"database/sql"
	"path/filepath"
)

// ZCode（智谱）适配器：从 src/main/scanner/agents/zcode.ts 移植。
// 用量来自它自己的 sqlite（model_usage 表），只有真实数据，不做估算。

func zcodeMeta() ScannerMeta {
	return ScannerMeta{
		ID: "zcode", Name: "ZCode", Vendor: "Zhipu AI", Kind: "desktop", Color: "#6366f1",
		Probes:        []string{filepath.Join(homeDir(), ".zcode"), "/Applications/ZCode.app"},
		InstallProbes: appPaths("ZCode.app"),
	}
}

type zcodeScanner struct{}

func (zcodeScanner) Meta() ScannerMeta { return zcodeMeta() }

func (zcodeScanner) Scan() AgentSnapshot {
	meta := zcodeMeta()
	home := homeDir()
	detected := exists(meta.Probes[0]) || exists(meta.Probes[1])
	snap := emptySnapshot(meta, detected)
	if !detected {
		return snap
	}

	snap.Info.Version = readAppBundleVersion("/Applications/ZCode.app")
	snap.Configs = configFiles([]string{
		filepath.Join(home, ".zcode/v2/config.json"),
		filepath.Join(home, ".zcode/v2/setting.json"),
		filepath.Join(home, ".zcode/v2/credentials.json"),
	})
	snap.DataDirs = dataDirs([][2]string{
		{filepath.Join(home, ".zcode/cli/db"), "会话/用量数据库"},
		{filepath.Join(home, ".zcode/cli/plugins"), "插件与技能"},
		{filepath.Join(home, ".zcode/cli/rollout"), "模型调用日志"},
		{filepath.Join(home, ".zcode/cli/log"), "运行日志"},
		{filepath.Join(home, ".zcode/cli/memories"), "记忆库"},
		{filepath.Join(home, ".zcode/v2"), "应用配置"},
	})
	snap.Skills = zcodePluginSkills(meta.ID)

	usage, projects := zcodeUsage(filepath.Join(home, ".zcode/cli/db/db.sqlite"))
	snap.Usage = usage
	snap.ProjectDirs = projects
	return finalize(snap)
}

// zcodePluginSkills 走插件缓存：marketplace/plugin/<version>/skills/<skill>/SKILL.md，
// 也可能 skills 直接挂在 plugin 下，所以两级都看。
func zcodePluginSkills(agentID string) []SkillInfo {
	out := []SkillInfo{}
	cacheRoot := filepath.Join(homeDir(), ".zcode/cli/plugins/cache")
	for _, marketplace := range listDirs(cacheRoot) {
		for _, plugin := range listDirs(marketplace) {
			candidates := append(listDirs(plugin), plugin)
			for _, candidate := range candidates {
				skillsDir := filepath.Join(candidate, "skills")
				for _, skillDir := range listDirs(skillsDir) {
					// 比 Electron 侧多读一步 SKILL.md：那边的插件技能只有目录名，
					// 页面上的版本/描述是空的。这里顺带把 frontmatter 取出来。
					out = append(out, skillFromDir(agentID, skillDir, false, len(out)+1))
				}
			}
		}
	}
	return out
}

// zcodeUsage 读它的用量库；表结构或数据库不可用时按「没有用量」处理，不报错。
func zcodeUsage(dbPath string) ([]UsageRecord, []string) {
	usage := []UsageRecord{}
	projects := []string{}
	if !exists(dbPath) {
		return usage, projects
	}
	db, err := sql.Open("sqlite", "file:"+dbPath+"?mode=ro")
	if err != nil {
		return usage, projects
	}
	defer func() { _ = db.Close() }()

	rows, err := db.Query(`select m.model_id, m.started_at, m.input_tokens, m.output_tokens,
		m.reasoning_tokens, m.cache_creation_input_tokens, m.cache_read_input_tokens
		from model_usage m where m.started_at is not null`)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var model sql.NullString
			var startedAt sql.NullInt64
			var in, out, reasoning, cacheWrite, cacheRead sql.NullInt64
			if err := rows.Scan(&model, &startedAt, &in, &out, &reasoning, &cacheWrite, &cacheRead); err != nil {
				break
			}
			name := model.String
			if name == "" {
				name = "unknown"
			}
			usage = append(usage, UsageRecord{
				TS: startedAt.Int64, Model: name,
				InputTokens: in.Int64, OutputTokens: out.Int64,
				ReasoningTokens:  reasoning.Int64,
				CacheWriteTokens: cacheWrite.Int64, CacheReadTokens: cacheRead.Int64,
				Requests: 1,
			})
		}
	}

	if prows, err := db.Query(`select distinct directory from session where directory is not null`); err == nil {
		defer prows.Close()
		for prows.Next() {
			var dir sql.NullString
			if err := prows.Scan(&dir); err != nil {
				break
			}
			if dir.String != "" {
				projects = append(projects, dir.String)
			}
		}
	}
	return usage, projects
}
