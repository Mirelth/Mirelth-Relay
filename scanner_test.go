package main

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeHome 把 HOME 指到临时目录，让适配器在自己控制的假家目录里扫描。
func fakeHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	return home
}

func mkfile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
}

func mkzcodeDB(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.Exec(`
create table session (id text primary key, directory text);
create table model_usage (
  session_id text, model_id text, started_at integer,
  input_tokens integer, output_tokens integer, reasoning_tokens integer,
  cache_creation_input_tokens integer, cache_read_input_tokens integer,
  computed_total_tokens integer
);
insert into session (id, directory) values ('s1', '/Users/x/project-a'), ('s2', '/Users/x/project-a'), ('s3', '/Users/x/project-b');
insert into model_usage values
 ('s1','glm-4.6',1762500000000,1200,340,50,20,400,2000),
 ('s2','glm-4.6',1762500060000,800,120,0,0,100,1020),
 ('s3','glm-4.5-air',1762500120000,500,60,10,0,0,570);
`); err != nil {
		t.Fatal(err)
	}
}

func TestScanAllSkipsUndetectedAgent(t *testing.T) {
	fakeHome(t)
	res := scanAll("")
	if len(res.Scanned) != len(allScanners()) {
		t.Fatalf("scanned %d of %d scanners", len(res.Scanned), len(allScanners()))
	}
	for _, snap := range res.Snapshots {
		if snap.Info.Detected {
			t.Fatalf("%s must not be detected in a fresh HOME", snap.Info.ID)
		}
		if snap.Info.Name == "" || snap.Info.Kind == "" || snap.Info.Color == "" {
			t.Fatalf("%s meta lost: %+v", snap.Info.ID, snap.Info)
		}
		if len(snap.Configs) != 0 || len(snap.Skills) != 0 || len(snap.Usage) != 0 {
			t.Fatalf("%s must stay empty when not detected: %+v", snap.Info.ID, snap)
		}
	}
	if snap := res.Snapshots[0]; snap.Info.ID != "zcode" {
		t.Fatalf("registry order changed: %v", res.Scanned)
	}
}

func TestZcodeScanReadsConfigsSkillsAndUsage(t *testing.T) {
	home := fakeHome(t)
	mkfile(t, filepath.Join(home, ".zcode/v2/config.json"),
		`{"apiKey":"abcdefgh12345678","provider":"zhipu","model":"glm-4.6"}`)
	mkfile(t, filepath.Join(home, ".zcode/cli/plugins/cache/marketplace/cool-plugin/1.0.0/skills/pdf-tools/SKILL.md"),
		"---\nname: pdf-tools\ndescription: 处理 PDF\nversion: 2.0.0\n---\n")
	mkzcodeDB(t, filepath.Join(home, ".zcode/cli/db/db.sqlite"))

	res := scanAll("zcode")
	snap := res.Snapshots[0]
	if !snap.Info.Detected {
		t.Fatal("detected should be true once ~/.zcode exists")
	}

	// 配置读取 + 脱敏
	var cfg *ConfigFileInfo
	for i := range snap.Configs {
		if filepath.Base(snap.Configs[i].Path) == "config.json" {
			cfg = &snap.Configs[i]
		}
	}
	if cfg == nil || !cfg.Exists {
		t.Fatalf("config.json should be read: %#v", snap.Configs)
	}
	if got := cfg.Summary["apiKey"]; got != "••••••••5678" {
		t.Fatalf("apiKey not redacted: %v", got)
	}

	// 技能来自插件缓存
	if len(snap.Skills) != 1 {
		t.Fatalf("skills = %#v", snap.Skills)
	}
	skill := snap.Skills[0]
	if skill.Name != "pdf-tools" || skill.Version != "2.0.0" || skill.Description != "处理 PDF" {
		t.Fatalf("skill meta = %+v", skill)
	}
	if skill.AgentID != "zcode" || skill.Builtin {
		t.Fatalf("skill = %+v", skill)
	}

	// 用量：三条真实记录，token 字段对齐（cache write 来自 cache_creation）
	if len(snap.Usage) != 3 {
		t.Fatalf("usage rows = %d", len(snap.Usage))
	}
	first := snap.Usage[0]
	if first.Model != "glm-4.6" || first.InputTokens != 1200 || first.OutputTokens != 340 ||
		first.ReasoningTokens != 50 || first.CacheWriteTokens != 20 || first.CacheReadTokens != 400 {
		t.Fatalf("usage row = %+v", first)
	}
	if !snap.Info.HasUsage || snap.Info.SkillCount != 1 {
		t.Fatalf("counters = %+v", snap.Info)
	}

	// 项目目录去重
	if snap.Info.ProjectCount != 2 || len(snap.ProjectDirs) != 2 {
		t.Fatalf("projects = %#v", snap.ProjectDirs)
	}
	if snap.ProjectDirs[0] != "/Users/x/project-a" || snap.ProjectDirs[1] != "/Users/x/project-b" {
		t.Fatalf("projects = %#v", snap.ProjectDirs)
	}

	// 装过但本体不在（测试环境没有 ZCode.app）→ residual
	if snap.Info.InstallState != "residual" {
		t.Fatalf("installState = %q, want residual", snap.Info.InstallState)
	}
}

func TestZcodeScanSurvivesBrokenDatabase(t *testing.T) {
	home := fakeHome(t)
	mkfile(t, filepath.Join(home, ".zcode/v2/config.json"), `{}`)
	// 不是 sqlite 文件的同名文件：查询会失败，但扫描必须继续
	mkfile(t, filepath.Join(home, ".zcode/cli/db/db.sqlite"), "definitely not a database")

	snap := scanAll("zcode").Snapshots[0]
	if !snap.Info.Detected {
		t.Fatal("detected should stay true")
	}
	if len(snap.Usage) != 0 || snap.Info.HasUsage {
		t.Fatalf("broken db must yield no usage: %+v", snap.Usage)
	}
	if len(snap.Configs) != 3 {
		t.Fatalf("configs should still be listed: %#v", snap.Configs)
	}
}

func TestComputeInstallState(t *testing.T) {
	cases := []struct {
		hasEvidence, programFound, dataFound bool
		want                                 string
	}{
		{false, false, true, "unknown"},
		{false, true, true, "unknown"},
		{true, true, false, "installed"},
		{true, false, true, "residual"},
		{true, false, false, "unknown"},
	}
	for _, c := range cases {
		if got := computeInstallState(c.hasEvidence, c.programFound, c.dataFound); got != c.want {
			t.Errorf("computeInstallState(%v,%v,%v) = %q, want %q",
				c.hasEvidence, c.programFound, c.dataFound, got, c.want)
		}
	}
}

func TestDetectInstallStateUsesBinsAndResolvers(t *testing.T) {
	home := fakeHome(t)
	dir := filepath.Join(home, ".local/bin")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "fake-cli"), []byte("#!/bin/sh\n"), 0755); err != nil {
		t.Fatal(err)
	}

	byBin := ScannerMeta{InstallBins: []string{"fake-cli"}}
	if got := detectInstallState(byBin, true); got != "installed" {
		t.Fatalf("bin evidence → %q, want installed", got)
	}
	if got := detectInstallState(ScannerMeta{InstallBins: []string{"nope-cli"}}, true); got != "residual" {
		t.Fatalf("missing bin with data → %q, want residual", got)
	}
	byResolver := ScannerMeta{InstallProbeResolver: func() []string { return []string{home} }}
	if got := detectInstallState(byResolver, false); got != "installed" {
		t.Fatalf("resolver evidence → %q, want installed", got)
	}
	if got := detectInstallState(ScannerMeta{}, true); got != "unknown" {
		t.Fatalf("no evidence → %q, want unknown", got)
	}
}

// ---------- 通用探测位 ----------

func TestGenericClaudeCodeScan(t *testing.T) {
	home := fakeHome(t)
	mkfile(t, filepath.Join(home, ".claude.json"), `{
  "mcpServers": {"filesystem": {"command": "npx", "args": ["-y", "server"]}, "docs": {"url": "https://x/mcp"}}
}`)
	mkfile(t, filepath.Join(home, ".claude/skills/pdf/SKILL.md"), "---\nname: pdf\ndescription: PDF 处理\n---\n")
	mkfile(t, filepath.Join(home, ".claude/settings.json"), `{"env":{"ANTHROPIC_AUTH_TOKEN":"abcdefgh1234"}}`)
	if err := os.MkdirAll(filepath.Join(home, ".claude/projects/-Users-new-project-a"), 0700); err != nil {
		t.Fatal(err)
	}

	// 清掉 PATH：这台机器可能真的装了 claude，本用例要断言「只有数据 = residual」
	t.Setenv("PATH", t.TempDir())

	snap := scanAll("claude-code").Snapshots[0]
	if !snap.Info.Detected || snap.Info.Vendor != "Anthropic" || snap.Info.Kind != "cli" {
		t.Fatalf("info = %+v", snap.Info)
	}
	if len(snap.MCPServers) != 2 {
		t.Fatalf("mcp = %#v", snap.MCPServers)
	}
	byName := map[string]RawMcp{}
	for _, m := range snap.MCPServers {
		byName[m.Name] = m
	}
	if got := byName["filesystem"]; got.Transport != "stdio" || got.Endpoint != "npx -y server" {
		t.Fatalf("stdio mcp = %+v", got)
	}
	if got := byName["docs"]; got.Transport != "http" || got.Endpoint != "https://x/mcp" {
		t.Fatalf("http mcp = %+v", got)
	}
	if len(snap.Skills) != 1 || snap.Skills[0].Name != "pdf" {
		t.Fatalf("skills = %#v", snap.Skills)
	}
	if len(snap.ProjectDirs) != 1 || snap.ProjectDirs[0] != "/Users/new/project/a" {
		t.Fatalf("projects = %#v", snap.ProjectDirs)
	}
	// 配置摘要里的 token 必须脱敏
	for _, cf := range snap.Configs {
		if cf.Summary == nil {
			continue
		}
		if env, ok := cf.Summary["env"].(map[string]any); ok {
			if v, ok := env["ANTHROPIC_AUTH_TOKEN"].(string); ok && strings.Contains(v, "abcdefgh") {
				t.Fatalf("token leaked: %v", v)
			}
		}
	}
	// 没有可验证的 claude 可执行文件 → residual
	if snap.Info.InstallState != "residual" {
		t.Fatalf("installState = %q", snap.Info.InstallState)
	}
}

func TestGenericTomlConfigOnlyReportsExistence(t *testing.T) {
	home := fakeHome(t)
	mkfile(t, filepath.Join(home, ".codex/config.toml"), "model = \"gpt-5\"\n")
	snap := scanAll("codex").Snapshots[0]
	if !snap.Info.Detected {
		t.Fatal("codex should be detected from ~/.codex")
	}
	if len(snap.Configs) != 1 || !snap.Configs[0].Exists || snap.Configs[0].Summary != nil {
		t.Fatalf("toml config must be listed without parsing: %#v", snap.Configs)
	}
}

// ---------- CodeBuddy / Qoder / Hub ----------

func TestCodebuddySkillsDedupeAndMcp(t *testing.T) {
	home := fakeHome(t)
	mkfile(t, filepath.Join(home, ".codebuddy/skills/alpha/SKILL.md"), "---\nname: alpha\n---\n")
	mkfile(t, filepath.Join(home, ".codebuddy/skills-marketplace/skills/alpha/SKILL.md"), "---\nname: alpha\n---\n")
	mkfile(t, filepath.Join(home, ".codebuddy/skills-marketplace/skills/beta/SKILL.md"), "---\nname: beta\n---\n")
	mkfile(t, filepath.Join(home, ".codebuddy/mcp.json"), `{"mcpServers":{"s1":{"command":"node","args":["s.js"]},"s2":{"url":"https://y/mcp","disabled":true}}}`)

	snap := scanAll("codebuddy").Snapshots[0]
	if len(snap.Skills) != 2 {
		t.Fatalf("skills should dedupe by name: %#v", snap.Skills)
	}
	if len(snap.MCPServers) != 2 {
		t.Fatalf("mcp = %#v", snap.MCPServers)
	}
	for _, m := range snap.MCPServers {
		if m.Name == "s2" && m.Enabled {
			t.Fatal("disabled mcp must be marked disabled")
		}
	}
}

func TestHubMcpFromConfig(t *testing.T) {
	home := fakeHome(t)
	mkfile(t, filepath.Join(home, ".hub/.config-v2/base.json"), `{
  // hub 的配置允许注释
  "mcp": {"tools": {"command": ["python3", "server.py"]}, "off": {"url": "https://z/mcp", "enabled": false}}
}`)
	snap := scanAll("hub").Snapshots[0]
	if len(snap.MCPServers) != 2 {
		t.Fatalf("mcp = %#v", snap.MCPServers)
	}
	for _, m := range snap.MCPServers {
		switch m.Name {
		case "tools":
			if m.Endpoint != "python3 server.py" || !m.Enabled {
				t.Fatalf("tools = %+v", m)
			}
		case "off":
			if m.Enabled {
				t.Fatalf("off should be disabled: %+v", m)
			}
		}
	}
}

func TestQoderPluginsAsSkillsAndUsageEstimate(t *testing.T) {
	home := fakeHome(t)
	mkfile(t, filepath.Join(home, ".qoder/plugins/installed_plugins_v2.json"), `{
  "plugins": {"my-plugin@1.2.3": [{"scope":"user","installPath":"/tmp/p","version":"1.2.3","installedAt":"2026-01-02T03:04:05Z"}]}
}`)
	mkfile(t, filepath.Join(home, ".qoder/projects/-Users-new-demo/session.jsonl"), strings.Join([]string{
		`{"type":"assistant","timestamp":"2026-11-08T10:00:00Z","message":{"model":"qwen3","content":[{"type":"text","text":"hello"}],"usage":{"credits":7.2,"context_usage_ratio":0.5}}}`,
		`{"type":"user","timestamp":"2026-11-08T10:00:01Z","message":{"usage":{"credits":9}}}`,
		`{"type":"assistant","timestamp":"2026-11-08T10:00:02Z","message":{"model":"qwen3","usage":{"credits":0}}}`,
	}, "\n"))

	snap := scanAll("qoder").Snapshots[0]
	if len(snap.Skills) != 1 || snap.Skills[0].Name != "my-plugin" || snap.Skills[0].Version != "1.2.3" {
		t.Fatalf("skills = %#v", snap.Skills)
	}
	if len(snap.Usage) != 1 {
		t.Fatalf("only credited assistant rows count: %#v", snap.Usage)
	}
	row := snap.Usage[0]
	if row.InputTokens != qoderContextWindow/2 {
		t.Fatalf("est input = %d", row.InputTokens)
	}
	if row.OutputTokens < 100 {
		t.Fatalf("est output floor = %d", row.OutputTokens)
	}
	if got, want := row.CostUSD, 7.2/defaultRateUSDCNY; got != want {
		t.Fatalf("cost = %v, want %v", got, want)
	}
	if len(snap.ProjectDirs) != 1 || snap.ProjectDirs[0] != "/Users/new/demo" {
		t.Fatalf("projects = %#v", snap.ProjectDirs)
	}
}

// ---------- DSH ----------

func TestParseDshSession(t *testing.T) {
	text := strings.Join([]string{
		`{"type":"session","cwd":"/Users/x/proj","time":1762500000000}`,
		`{"type":"request/header","data":{"header":{"config":{"model":"deepseek-v4"}}}}`,
		`{"type":"assistant/chunk","time":1762500001000,"data":{"chunk":{"type":"usage","usage":{"inputTokens":10,"outputTokens":20,"cacheReadTokens":5,"cacheWriteTokens":1,"reasoningTokens":2}}}}`,
		`{"type":"assistant/chunk","time":1762500002000,"data":{"chunk":{"type":"text","text":"hi"}}}`,
		`not json at all`,
		`{"type":"assistant/chunk","time":1762500003000,"data":{"chunk":{"type":"usage","usage":{"inputTokens":3}}}}`,
	}, "\n")

	usage, cwd := parseDSHSession(text)
	if cwd != "/Users/x/proj" {
		t.Fatalf("cwd = %q", cwd)
	}
	if len(usage) != 2 {
		t.Fatalf("usage rows = %#v", usage)
	}
	first := usage[0]
	if first.Model != "deepseek-v4" || first.InputTokens != 10 || first.OutputTokens != 20 ||
		first.CacheReadTokens != 5 || first.CacheWriteTokens != 1 || first.ReasoningTokens != 2 {
		t.Fatalf("first row = %+v", first)
	}
	if first.TS != 1762500001000 {
		t.Fatalf("ts = %d", first.TS)
	}
}

func TestDshScansPresetsAndConfig(t *testing.T) {
	home := fakeHome(t)
	mkfile(t, filepath.Join(home, ".dsh/settings.yaml"), "llm-pi-ai:\n  apiKey: abcdefgh9999\n")
	if err := os.MkdirAll(filepath.Join(home, ".dsh/.agent-presets/reviewer"), 0700); err != nil {
		t.Fatal(err)
	}
	snap := scanAll("dsh-web").Snapshots[0]
	if !snap.Info.Detected {
		t.Fatal("dsh-web should be detected")
	}
	if len(snap.Skills) != 1 || snap.Skills[0].Name != "reviewer" {
		t.Fatalf("presets = %#v", snap.Skills)
	}
	if len(snap.Configs) != 1 || snap.Configs[0].Summary == nil {
		t.Fatalf("config = %#v", snap.Configs)
	}
	if key, ok := snap.Configs[0].Summary["llm-pi-ai"].(map[string]any); ok {
		if v, _ := key["apiKey"].(string); strings.Contains(v, "abcdefgh") {
			t.Fatalf("dsh api key leaked: %v", v)
		}
	}
	// DSH Web 没有可验证的本体位置 → 即使装了也是 unknown
	if snap.Info.InstallState != "unknown" {
		t.Fatalf("installState = %q, want unknown", snap.Info.InstallState)
	}
}

// ---------- OpenCode ----------

func TestOpencodeFamilyReadsSessionTable(t *testing.T) {
	home := fakeHome(t)
	mkfile(t, filepath.Join(home, ".config/opencode/opencode.jsonc"),
		"{\n  // 注释\n  \"provider\": {}\n}")
	dbPath := filepath.Join(home, ".local/share/opencode/opencode.db")
	if err := os.MkdirAll(filepath.Dir(dbPath), 0700); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
create table project_directory (directory text);
create table session (
  id text primary key, directory text, model text, time_created integer, cost real,
  tokens_input integer, tokens_output integer, tokens_reasoning integer,
  tokens_cache_read integer, tokens_cache_write integer
);
insert into project_directory values ('/Users/x/oc-project');
insert into session values ('s1','/Users/x/oc-project','{"id":"deepseek-v4.1-flash"}',1762500000000,0.25,100,200,10,50,20);
`); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()

	snap := scanAll("opencode").Snapshots[0]
	if !snap.Info.Detected {
		t.Fatal("opencode should be detected")
	}
	if len(snap.Usage) != 1 {
		t.Fatalf("usage = %#v", snap.Usage)
	}
	row := snap.Usage[0]
	if row.Model != "deepseek-v4.1-flash" || row.InputTokens != 100 || row.OutputTokens != 200 ||
		row.ReasoningTokens != 10 || row.CacheReadTokens != 50 || row.CacheWriteTokens != 20 || row.CostUSD != 0.25 {
		t.Fatalf("row = %+v", row)
	}
	if len(snap.ProjectDirs) != 1 || snap.ProjectDirs[0] != "/Users/x/oc-project" {
		t.Fatalf("projects = %#v", snap.ProjectDirs)
	}
	if len(snap.Configs) != 1 || snap.Configs[0].Summary == nil {
		t.Fatalf("jsonc config should parse: %#v", snap.Configs)
	}
}
