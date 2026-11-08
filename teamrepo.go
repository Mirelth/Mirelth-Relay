package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// 团队仓库（对应 src/main/{team-repo,sync-engine}.ts）：~/.relay/team-repo 是个 git 仓库，
// 按目录存放团队共享的 skills / rules / mcp / hooks / knowledge。

type TeamRepoStatus struct {
	Initialized  bool   `json:"initialized"`
	IsGitRepo    bool   `json:"isGitRepo"`
	Branch       string `json:"branch"`
	Remote       string `json:"remote,omitempty"`
	LocalChanges bool   `json:"localChanges"`
	SkillCount   int    `json:"skillCount"`
	RuleCount    int    `json:"ruleCount"`
}

type SyncConfig struct {
	AutoSync         bool `json:"autoSync"`
	AutoSyncInterval int  `json:"autoSyncInterval"`
}

func teamRepoDir() string    { return filepath.Join(configDir(), "team-repo") }
func teamSkillsDir() string  { return filepath.Join(teamRepoDir(), "skills") }
func teamRulesDir() string   { return filepath.Join(teamRepoDir(), "rules") }
func syncConfigPath() string { return filepath.Join(configDir(), "sync-config.json") }

// InitTeamRepo 建目录骨架 + git 仓库 + 首提交（幂等）。
func (a *App) InitTeamRepo() string {
	dir := teamRepoDir()
	if err := os.MkdirAll(dir, 0700); err != nil {
		return toJSON(map[string]any{"success": false, "error": err.Error()})
	}
	for _, sub := range []string{"skills", "rules", "mcp", "hooks", "knowledge"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0700); err != nil {
			return toJSON(map[string]any{"success": false, "error": err.Error()})
		}
	}
	gitignore := filepath.Join(dir, ".gitignore")
	if !exists(gitignore) {
		_ = os.WriteFile(gitignore, []byte(".DS_Store\nnode_modules/\n*.log\n"), 0600)
	}
	readme := filepath.Join(dir, "README.md")
	if !exists(readme) {
		_ = os.WriteFile(readme,
			[]byte("# 团队仓库\n\n由 Relay 初始化：`skills/` 放共享技能，`rules/` 放团队约束规则。\n"), 0600)
	}

	if !exists(filepath.Join(dir, ".git")) {
		if _, err := execGit(dir, "init", "-q"); err != nil {
			return toJSON(map[string]any{"success": false, "error": "git init 失败：" + err.Error()})
		}
		_, _ = execGit(dir, "checkout", "-q", "-b", "main")
		// 本地提交需要身份；没有全局配置时用仓库级兜底身份
		_, _ = execGit(dir, "config", "user.email", "relay@localhost")
		_, _ = execGit(dir, "config", "user.name", "Relay")
	}
	if _, err := execGit(dir, "add", "."); err != nil {
		return toJSON(map[string]any{"success": false, "error": "git add 失败：" + err.Error()})
	}
	// 没有改动时 commit 会失败，这里不算错误
	_, _ = execGit(dir, "commit", "-qm", "chore: 初始化团队仓库")
	return toJSON(map[string]any{"success": true})
}

func (a *App) TeamRepoStatus() string {
	dir := teamRepoDir()
	status := TeamRepoStatus{
		Initialized: exists(dir),
		IsGitRepo:   exists(filepath.Join(dir, ".git")),
		Branch:      "main",
		SkillCount:  len(listEntries(teamSkillsDir())),
		RuleCount:   len(listEntries(teamRulesDir())),
	}
	if status.IsGitRepo {
		if out, err := execGit(dir, "rev-parse", "--abbrev-ref", "HEAD"); err == nil {
			if b := strings.TrimSpace(out); b != "" {
				status.Branch = b
			}
		}
		if out, err := execGit(dir, "remote", "get-url", "origin"); err == nil {
			status.Remote = strings.TrimSpace(out)
		}
		if out, err := execGit(dir, "status", "--porcelain"); err == nil {
			status.LocalChanges = strings.TrimSpace(out) != ""
		}
	}
	return toJSON(status)
}

func (a *App) TeamRepoAddRemote(url string) string {
	dir := teamRepoDir()
	if !exists(filepath.Join(dir, ".git")) {
		return toJSON(map[string]any{"success": false, "error": "团队仓库尚未初始化"})
	}
	if strings.TrimSpace(url) == "" {
		return toJSON(map[string]any{"success": false, "error": "缺少远端地址"})
	}
	// 已存在 origin 时先移除再添加，避免 "remote origin already exists"
	_, _ = execGit(dir, "remote", "remove", "origin")
	if _, err := execGit(dir, "remote", "add", "origin", url); err != nil {
		return toJSON(map[string]any{"success": false, "error": err.Error()})
	}
	return toJSON(map[string]any{"success": true})
}

func (a *App) TeamRepoPush() string {
	dir := teamRepoDir()
	if !exists(filepath.Join(dir, ".git")) {
		return toJSON(map[string]any{"success": false, "error": "团队仓库尚未初始化"})
	}
	if _, err := execGit(dir, "remote", "get-url", "origin"); err != nil {
		return toJSON(map[string]any{"success": false, "error": "未配置远端仓库"})
	}
	if _, err := execGit(dir, "add", "."); err != nil {
		return toJSON(map[string]any{"success": false, "error": err.Error()})
	}
	msg := "chore: 同步团队仓库 " + time.Now().Format("2006-01-02 15:04")
	_, _ = execGit(dir, "commit", "-qm", msg)
	if _, err := execGit(dir, "push", "-u", "origin", "HEAD"); err != nil {
		return toJSON(map[string]any{"success": false, "error": "git push 失败：" + err.Error()})
	}
	return toJSON(map[string]any{"success": true})
}

func (a *App) TeamRepoPull() string {
	dir := teamRepoDir()
	if !exists(filepath.Join(dir, ".git")) {
		return toJSON(map[string]any{"success": false, "error": "团队仓库尚未初始化"})
	}
	if _, err := execGit(dir, "remote", "get-url", "origin"); err != nil {
		return toJSON(map[string]any{"success": false, "error": "未配置远端仓库"})
	}
	if _, err := execGit(dir, "pull", "--no-rebase", "origin", "HEAD"); err != nil {
		return toJSON(map[string]any{"success": false, "error": "git pull 失败：" + err.Error()})
	}
	return toJSON(map[string]any{"success": true})
}

// teamFileSummary 读 skills / rules 目录下的 .md，解析成摘要列表。
func teamFileSummary(dir string) []map[string]any {
	out := []map[string]any{}
	for _, name := range listEntries(dir) {
		path := filepath.Join(dir, name)
		if !strings.HasSuffix(name, ".md") {
			continue
		}
		meta := parseSkillFile(path)
		item := map[string]any{
			"name": strings.TrimSuffix(name, ".md"),
			"path": path,
		}
		if meta.Name != "" {
			item["name"] = meta.Name
		}
		if meta.Description != "" {
			item["description"] = meta.Description
		}
		if meta.Version != "" {
			item["version"] = meta.Version
		}
		if at := mtimeISO(path); at != "" {
			item["updatedAt"] = at
		}
		out = append(out, item)
	}
	sort.SliceStable(out, func(i, j int) bool { return strOf(out[i]["name"]) < strOf(out[j]["name"]) })
	return out
}

func (a *App) TeamRepoSkills() string { return toJSON(teamFileSummary(teamSkillsDir())) }

func (a *App) TeamRepoRules() string { return toJSON(teamFileSummary(teamRulesDir())) }

// teamFileContent 只读目录下的 .md 文件，防止 ../ 穿越。
func teamFileContent(dir, name string) (string, bool) {
	clean := filepath.Base(strings.TrimSpace(name))
	if clean == "" || clean == "." || clean == ".." {
		return "", false
	}
	if !strings.HasSuffix(clean, ".md") {
		clean += ".md"
	}
	return readText(filepath.Join(dir, clean))
}

func (a *App) TeamRepoGetSkill(name string) string {
	content, ok := teamFileContent(teamSkillsDir(), name)
	if !ok {
		return toJSON("")
	}
	return toJSON(content)
}

func (a *App) TeamRepoGetRule(name string) string {
	content, ok := teamFileContent(teamRulesDir(), name)
	if !ok {
		return toJSON("")
	}
	return toJSON(content)
}

func (a *App) TeamRepoSaveSkill(name, content string) string {
	return toJSON(saveTeamFile(teamSkillsDir(), name, content))
}

func (a *App) TeamRepoSaveRule(name, content string) string {
	return toJSON(saveTeamFile(teamRulesDir(), name, content))
}

// saveTeamFile 写团队仓库里的一个 .md。
// 含路径分隔符的名字直接拒绝而不是静默改名——用户以为写的是 a/b，实际落到 b 会很难排查。
func saveTeamFile(dir, name, content string) map[string]any {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" || strings.ContainsAny(trimmed, `/\`) || trimmed == "." || trimmed == ".." {
		return map[string]any{"ok": false, "error": "文件名不合法（不允许包含路径分隔符）"}
	}
	clean := trimmed
	if !strings.HasSuffix(clean, ".md") {
		clean += ".md"
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	path := filepath.Join(dir, clean)
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	return map[string]any{"ok": true, "path": path}
}

func (a *App) TeamRepoSyncConfig() string {
	cfg := SyncConfig{AutoSync: false, AutoSyncInterval: 300000}
	if raw, ok := readText(syncConfigPath()); ok {
		_ = json.Unmarshal([]byte(raw), &cfg)
		if cfg.AutoSyncInterval <= 0 {
			cfg.AutoSyncInterval = 300000
		}
	}
	return toJSON(cfg)
}

func (a *App) TeamRepoSaveSyncConfig(raw string) string {
	var cfg SyncConfig
	if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
		return toJSON(map[string]any{"ok": false, "error": err.Error()})
	}
	if cfg.AutoSyncInterval <= 0 {
		cfg.AutoSyncInterval = 300000
	}
	if err := writeJSONList(syncConfigPath(), cfg); err != nil {
		return toJSON(map[string]any{"ok": false, "error": err.Error()})
	}
	return toJSON(map[string]any{"ok": true})
}
