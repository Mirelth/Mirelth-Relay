package main

import (
	"encoding/json"
	"path/filepath"
	"testing"
	"time"
)

func snapshotFixture(id, name string, detected bool, state string) AgentSnapshot {
	return AgentSnapshot{
		Info: AgentInfo{
			ID: id, Name: name, Vendor: "Vendor", Kind: "cli", Color: "#123456",
			Detected: detected, InstallState: state,
		},
		Configs:     []ConfigFileInfo{{Path: "/tmp/" + id + "/config.json", Exists: true, Summary: map[string]any{"apiKey": "••••••••1234"}}},
		DataDirs:    []DataDirInfo{{Path: "/tmp/" + id, Label: "数据目录", SizeBytes: 1024}},
		Skills:      []SkillInfo{{ID: id + ":s1:1", AgentID: id, Name: "s1", Source: "/tmp/s1"}},
		MCPServers:  []RawMcp{{Name: "files", Transport: "stdio", Endpoint: "npx -y files", Enabled: true, Tools: []McpTool{{Name: "read"}}}},
		Usage:       []UsageRecord{{TS: nowUnixMilli(), Model: "m1", InputTokens: 10, OutputTokens: 5, Requests: 1, CostUSD: 0.01}},
		ProjectDirs: []string{"/tmp/project-a"},
	}
}

func TestSaveSnapshotAndListAgents(t *testing.T) {
	st := testStore(t)
	if err := st.SaveSnapshot(snapshotFixture("b", "Beta", true, "installed")); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveSnapshot(snapshotFixture("a", "Alpha", false, "unknown")); err != nil {
		t.Fatal(err)
	}

	agents, err := st.ListAgents()
	if err != nil {
		t.Fatal(err)
	}
	if len(agents) != 2 {
		t.Fatalf("agents = %d", len(agents))
	}
	// 已检测的排前面
	if agents[0].ID != "b" || !agents[0].Detected || agents[0].InstallState != "installed" {
		t.Fatalf("first agent = %+v", agents[0])
	}
	if agents[0].SkillCount != 1 || agents[0].McpCount != 1 || !agents[0].HasUsage || agents[0].ProjectCount != 1 {
		t.Fatalf("counters = %+v", agents[0])
	}
	if agents[1].ID != "a" || agents[1].Detected {
		t.Fatalf("second agent = %+v", agents[1])
	}

	// 再存一次同 id：整体替换，不重复
	if err := st.SaveSnapshot(snapshotFixture("b", "Beta", true, "installed")); err != nil {
		t.Fatal(err)
	}
	agents, _ = st.ListAgents()
	if len(agents) != 2 {
		t.Fatalf("re-save must replace, agents = %d", len(agents))
	}
	records, _ := st.UsageRecords("", "", 0, 0, 100)
	if len(records) != 2 {
		t.Fatalf("usage rows should be replaced per agent, got %d", len(records))
	}
}

func TestAgentDetailAndFilters(t *testing.T) {
	st := testStore(t)
	if err := st.SaveSnapshot(snapshotFixture("zcode", "ZCode", true, "residual")); err != nil {
		t.Fatal(err)
	}

	detail, err := st.AgentDetail("zcode")
	if err != nil || detail == nil {
		t.Fatalf("detail = %v err = %v", detail, err)
	}
	if detail.Info.Name != "ZCode" || len(detail.Configs) != 1 || len(detail.DataDirs) != 1 {
		t.Fatalf("detail = %+v", detail)
	}
	if detail.Configs[0].Summary["apiKey"] != "••••••••1234" {
		t.Fatalf("config summary lost: %+v", detail.Configs[0])
	}
	if len(detail.Skills) != 1 || len(detail.MCPServers) != 1 || len(detail.MCPServers[0].Tools) != 1 {
		t.Fatalf("detail skills/mcp = %+v", detail)
	}
	if detail.MCPServers[0].ID != "zcode:files" || detail.MCPServers[0].Status != "unverified" {
		t.Fatalf("mcp row = %+v", detail.MCPServers[0])
	}
	if got, _ := st.AgentDetail("nope"); got != nil {
		t.Fatal("unknown agent must return nil")
	}

	if skills, _ := st.ListSkills("", "zcode"); len(skills) != 1 {
		t.Fatalf("filter by agent = %d", len(skills))
	}
	if skills, _ := st.ListSkills("s1", ""); len(skills) != 1 {
		t.Fatalf("filter by search = %d", len(skills))
	}
	if skills, _ := st.ListSkills("zzz", ""); len(skills) != 0 {
		t.Fatalf("unmatched search = %d", len(skills))
	}
}

func TestDeleteAgentsExceptRemovesStaleRows(t *testing.T) {
	st := testStore(t)
	if err := st.SaveSnapshot(snapshotFixture("keep", "Keep", true, "installed")); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveSnapshot(snapshotFixture("gone", "Gone", true, "installed")); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteAgentsExcept([]string{"keep"}); err != nil {
		t.Fatal(err)
	}
	agents, _ := st.ListAgents()
	if len(agents) != 1 || agents[0].ID != "keep" {
		t.Fatalf("agents = %+v", agents)
	}
	if skills, _ := st.ListSkills("", ""); len(skills) != 1 {
		t.Fatalf("stale skills left: %d", len(skills))
	}
	if usage, _ := st.UsageRecords("", "", 0, 0, 100); len(usage) != 1 {
		t.Fatalf("stale usage left: %d", len(usage))
	}
}

func TestDashboardNumbersAndCounts(t *testing.T) {
	st := testStore(t)
	if err := st.SaveSnapshot(snapshotFixture("zcode", "ZCode", true, "installed")); err != nil {
		t.Fatal(err)
	}
	counts, err := st.ScanCounts()
	if err != nil {
		t.Fatal(err)
	}
	if counts.Agents != 1 || counts.InstalledAgents != 1 || counts.ResidualAgents != 0 ||
		counts.Skills != 1 || counts.MCP != 1 || counts.Repos != 1 {
		t.Fatalf("counts = %+v", counts)
	}

	nums, err := st.DashboardNumbers()
	if err != nil {
		t.Fatal(err)
	}
	if nums.TodayTokens != 15 || nums.Last7dTokens != 15 || nums.YesterdayTokens != 0 {
		t.Fatalf("numbers = %+v", nums)
	}
	if len(nums.TopAgents) != 1 || nums.TopAgents[0].AgentID != "zcode" || nums.TopAgents[0].TotalTokens != 15 {
		t.Fatalf("top agents = %+v", nums.TopAgents)
	}
	if len(nums.TopModels) != 1 || nums.TopModels[0].Model != "m1" {
		t.Fatalf("top models = %+v", nums.TopModels)
	}
}

func TestUsageStatsDimensions(t *testing.T) {
	st := testStore(t)
	snap := snapshotFixture("zcode", "ZCode", true, "installed")
	snap.Usage = []UsageRecord{
		{TS: nowUnixMilli(), Model: "m1", InputTokens: 10, Requests: 1, CostUSD: 1},
		{TS: nowUnixMilli(), Model: "m2", InputTokens: 90, Requests: 1, CostUSD: 2},
	}
	if err := st.SaveSnapshot(snap); err != nil {
		t.Fatal(err)
	}
	byAgent, err := st.UsageStats("agent", 14)
	if err != nil {
		t.Fatal(err)
	}
	if len(byAgent) != 1 || byAgent[0].Key != "zcode" || byAgent[0].Tokens != 100 {
		t.Fatalf("by agent = %+v", byAgent)
	}
	if byAgent[0].CostCNY != 3*defaultRateUSDCNY {
		t.Fatalf("cost = %v", byAgent[0].CostCNY)
	}

	byModel, _ := st.UsageStats("model", 14)
	if len(byModel) != 2 || byModel[0].Key != "m2" {
		t.Fatalf("by model should sort by tokens desc: %+v", byModel)
	}

	byDay, _ := st.UsageStats("day", 14)
	if len(byDay) != 1 || len(byDay[0].Key) != len("2026-11-08") {
		t.Fatalf("by day = %+v", byDay)
	}
}

// 端到端：假家目录 → 扫描 → 缓存 → 绑定返回的形状。
func TestScanAndCacheEndToEnd(t *testing.T) {
	home := fakeHome(t)
	mkfile(t, filepath.Join(home, ".zcode/v2/config.json"), `{"apiKey":"abcdefgh5678"}`)
	mkfile(t, filepath.Join(home, ".zcode/cli/plugins/cache/m/p/1.0.0/skills/pdf/SKILL.md"), "---\nname: pdf\n---\n")

	app := &App{store: testStore(t)}
	scanned, errs, _ := app.scanAndCache("")
	if len(errs) != 0 {
		t.Fatalf("scan errors: %v", errs)
	}
	if len(scanned) != len(allScanners()) {
		t.Fatalf("scanned = %d, want %d", len(scanned), len(allScanners()))
	}

	var agents []AgentInfo
	if err := json.Unmarshal([]byte(app.GetAgents()), &agents); err != nil {
		t.Fatal(err)
	}
	if len(agents) != len(allScanners()) {
		t.Fatalf("agents = %d", len(agents))
	}
	var zcode *AgentInfo
	for i := range agents {
		if agents[i].ID == "zcode" {
			zcode = &agents[i]
		}
	}
	if zcode == nil || !zcode.Detected || zcode.SkillCount != 1 {
		t.Fatalf("zcode row = %+v", zcode)
	}

	// 详情里配置必须已脱敏
	var detail AgentDetail
	if err := json.Unmarshal([]byte(app.GetAgentDetail("zcode")), &detail); err != nil {
		t.Fatal(err)
	}
	var configFile *ConfigFileInfo
	for i := range detail.Configs {
		if filepath.Base(detail.Configs[i].Path) == "config.json" {
			configFile = &detail.Configs[i]
		}
	}
	if configFile == nil || !configFile.Exists || configFile.Summary["apiKey"] != "••••••••5678" {
		t.Fatalf("detail configs = %+v", detail.Configs)
	}

	var lastScan struct{ At string }
	if err := json.Unmarshal([]byte(app.LastScan()), &lastScan); err != nil || lastScan.At == "" {
		t.Fatalf("lastScan = %v err = %v", lastScan, err)
	}
	if skills := app.GetSkills("zcode", ""); skills == "[]" {
		t.Fatal("skills binding should return the migrated skill")
	}
	if dash := app.GetAgentDashboard(); dash == "{}" {
		t.Fatal("dashboard must render a payload")
	}
	if stats := app.GetUsageStats("day", 14); stats == "" {
		t.Fatal("usage stats must render a payload")
	}
}

func nowUnixMilli() int64 { return time.Now().UnixMilli() }
