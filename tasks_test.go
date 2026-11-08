package main

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

// ---------- 约束 ----------

func TestConstraintLifecycleAndValidation(t *testing.T) {
	fakeHome(t)
	app := &App{}

	if out := app.AddConstraint(`{"agentId":"","type":"token-limit"}`); !strings.Contains(out, "error") {
		t.Fatalf("missing agentId must fail: %s", out)
	}
	var added AgentConstraint
	if err := json.Unmarshal([]byte(app.AddConstraint(
		`{"agentId":"zcode","type":"token-limit","config":{"maxTokensPerDay":100},"action":"block","enabled":true}`)), &added); err != nil {
		t.Fatal(err)
	}
	if added.ID == "" || added.CreatedAt == 0 {
		t.Fatalf("added = %+v", added)
	}

	var list []AgentConstraint
	_ = json.Unmarshal([]byte(app.ListConstraints()), &list)
	if len(list) != 1 || list[0].AgentID != "zcode" {
		t.Fatalf("list = %+v", list)
	}

	// token-limit 命中
	var res struct {
		Allowed    bool                  `json:"allowed"`
		Violations []ConstraintViolation `json:"violations"`
		Message    string                `json:"message"`
	}
	_ = json.Unmarshal([]byte(app.ValidateConstraints("zcode", `{"tokensToday":150}`)), &res)
	if res.Allowed || len(res.Violations) != 1 || !strings.Contains(res.Message, "操作被阻止") {
		t.Fatalf("token limit = %+v", res)
	}
	// 未达上限
	_ = json.Unmarshal([]byte(app.ValidateConstraints("zcode", `{"tokensToday":50}`)), &res)
	if !res.Allowed || len(res.Violations) != 0 {
		t.Fatalf("under limit = %+v", res)
	}

	// warn 动作放行但带提示
	_ = json.Unmarshal([]byte(app.UpdateConstraint(added.ID, `{"action":"warn"}`)), &added)
	_ = json.Unmarshal([]byte(app.ValidateConstraints("zcode", `{"tokensToday":150}`)), &res)
	if !res.Allowed || !strings.Contains(res.Message, "警告") {
		t.Fatalf("warn = %+v", res)
	}

	// 停用后不再生效
	_ = json.Unmarshal([]byte(app.UpdateConstraint(added.ID, `{"enabled":false}`)), &added)
	_ = json.Unmarshal([]byte(app.ValidateConstraints("zcode", `{"tokensToday":150}`)), &res)
	if len(res.Violations) != 0 {
		t.Fatalf("disabled constraint must not fire: %+v", res)
	}

	// 其他类型
	for _, c := range []string{
		`{"agentId":"a","type":"model-whitelist","config":{"allowedModels":["gpt"]},"action":"block","enabled":true}`,
		`{"agentId":"b","type":"cost-cap","config":{"maxCostPerDay":1},"action":"block","enabled":true}`,
		`{"agentId":"c","type":"time-window","config":{"allowedHours":[9,18]},"action":"block","enabled":true}`,
	} {
		app.AddConstraint(c)
	}
	_ = json.Unmarshal([]byte(app.ValidateConstraints("a", `{"model":"claude-3"}`)), &res)
	if len(res.Violations) != 1 || !strings.Contains(res.Violations[0].Message, "白名单") {
		t.Fatalf("model whitelist = %+v", res)
	}
	_ = json.Unmarshal([]byte(app.ValidateConstraints("a", `{"model":"gpt-4o"}`)), &res)
	if len(res.Violations) != 0 {
		t.Fatalf("allowed model = %+v", res)
	}
	_ = json.Unmarshal([]byte(app.ValidateConstraints("b", `{"costToday":2.5}`)), &res)
	if len(res.Violations) != 1 || !strings.Contains(res.Violations[0].Message, "成本") {
		t.Fatalf("cost cap = %+v", res)
	}
	_ = json.Unmarshal([]byte(app.ValidateConstraints("c", `{"currentHour":3}`)), &res)
	if len(res.Violations) != 1 || !strings.Contains(res.Violations[0].Message, "允许时段") {
		t.Fatalf("time window = %+v", res)
	}

	if out := app.DeleteConstraint("nope"); out != "false" {
		t.Fatalf("delete unknown = %s", out)
	}
	if out := app.DeleteConstraint(added.ID); out != "true" {
		t.Fatalf("delete = %s", out)
	}
	if out := app.UpdateConstraint("nope", `{}`); out != "null" {
		t.Fatalf("update unknown = %s", out)
	}
}

// ---------- 信任度 ----------

func TestTrustScoreMath(t *testing.T) {
	fakeHome(t)
	app := &App{}

	first := updateTrustScore("zcode", true, 1000)
	if first.TotalTasks != 1 || first.SuccessfulTasks != 1 || first.Score <= 0.5 {
		t.Fatalf("first = %+v", first)
	}
	// 成功一次、1 秒完成：成功率 1 * 0.7 + 时间因子 ~0.98 * 0.3
	if first.Score < 0.95 {
		t.Fatalf("score = %v", first.Score)
	}

	second := updateTrustScore("zcode", false, 120000)
	if second.TotalTasks != 2 || second.FailedTasks != 1 {
		t.Fatalf("second = %+v", second)
	}
	if second.Score >= first.Score {
		t.Fatalf("failure must lower the score: %+v", second)
	}

	var scores []TrustScore
	_ = json.Unmarshal([]byte(app.TrustScores()), &scores)
	if len(scores) != 1 || scores[0].AgentID != "zcode" {
		t.Fatalf("scores = %+v", scores)
	}
	var one TrustScore
	_ = json.Unmarshal([]byte(app.AgentTrustScore("zcode")), &one)
	if one.Score != second.Score {
		t.Fatalf("single = %+v", one)
	}
	if out := app.AgentTrustScore("ghost"); out != "null" {
		t.Fatalf("unknown agent = %s", out)
	}

	var ranked []struct {
		AgentID string  `json:"agentId"`
		Score   float64 `json:"score"`
	}
	updateTrustScore("other", true, 500)
	_ = json.Unmarshal([]byte(app.RankByTrust([]string{"ghost", "zcode", "other"})), &ranked)
	if len(ranked) != 3 || ranked[0].Score < ranked[len(ranked)-1].Score {
		t.Fatalf("ranked = %+v", ranked)
	}
	if ranked[len(ranked)-1].AgentID != "ghost" || ranked[len(ranked)-1].Score != 0.5 {
		t.Fatalf("unknown agent should default to 0.5: %+v", ranked)
	}
}

func TestFrictionPointsAreCappedAndFiltered(t *testing.T) {
	fakeHome(t)
	app := &App{}
	for i := 0; i < 1005; i++ {
		recordFrictionPoint(FrictionPoint{
			ID: "fp-" + itoa(int64(i)), AgentID: "zcode", Description: "boom", Category: "error",
		})
	}
	recordFrictionPoint(FrictionPoint{ID: "fp-x", AgentID: "other", Description: "x", Category: "timeout"})

	stored := readJSONList[FrictionPoint](frictionPointsPath())
	if len(stored) != 1000 {
		t.Fatalf("friction points should be capped at 1000, got %d", len(stored))
	}

	var stats struct {
		Total      int            `json:"total"`
		ByCategory map[string]int `json:"byCategory"`
	}
	_ = json.Unmarshal([]byte(app.FrictionStats("zcode")), &stats)
	if stats.Total == 0 || stats.ByCategory["error"] == 0 {
		t.Fatalf("stats = %+v", stats)
	}
	_ = json.Unmarshal([]byte(app.FrictionStats("other")), &stats)
	if stats.Total != 1 || stats.ByCategory["timeout"] != 1 {
		t.Fatalf("filtered stats = %+v", stats)
	}
}

// ---------- 任务与队列 ----------

func TestTaskLifecycleAndDependencies(t *testing.T) {
	fakeHome(t)
	app := &App{}

	if out := app.CreateTask(`{"title":"  "}`); !strings.Contains(out, "error") {
		t.Fatalf("empty title must fail: %s", out)
	}
	var t1 Task
	if err := json.Unmarshal([]byte(app.CreateTask(`{"title":"任务一","description":"d","assignedAgents":["zcode"]}`)), &t1); err != nil {
		t.Fatal(err)
	}
	if t1.Status != "pending" || t1.Mode != "sequential" || t1.ID == "" {
		t.Fatalf("task = %+v", t1)
	}
	var t2 Task
	_ = json.Unmarshal([]byte(app.CreateTask(`{"title":"任务二","dependencies":["`+t1.ID+`"],"mode":"parallel"}`)), &t2)

	var ready []Task
	_ = json.Unmarshal([]byte(app.ReadyTasks()), &ready)
	if len(ready) != 1 || ready[0].ID != t1.ID {
		t.Fatalf("only the dependency-free task is ready: %+v", ready)
	}

	_ = app.UpdateTaskStatus(t1.ID, "completed")
	_ = json.Unmarshal([]byte(app.ReadyTasks()), &ready)
	if len(ready) != 1 || ready[0].ID != t2.ID {
		t.Fatalf("dependent task becomes ready: %+v", ready)
	}

	// 子任务指派
	var got Task
	_ = json.Unmarshal([]byte(app.GetTask(t2.ID)), &got)
	got.SubTasks = []SubTask{{ID: "sub-1", Description: "x", Status: "pending"}}
	tasks := getTasks()
	for i := range tasks {
		if tasks[i].ID == t2.ID {
			tasks[i].SubTasks = got.SubTasks
		}
	}
	_ = saveTasks(tasks)
	if out := app.AssignSubTask(t2.ID, "sub-1", "opencode"); out != "true" {
		t.Fatalf("assign = %s", out)
	}
	if out := app.AssignSubTask(t2.ID, "nope", "opencode"); out != "false" {
		t.Fatalf("assign unknown = %s", out)
	}

	if out := app.CancelTask(t2.ID); out != "true" {
		t.Fatalf("cancel = %s", out)
	}
	_ = json.Unmarshal([]byte(app.GetTask(t2.ID)), &got)
	if got.Status != "cancelled" {
		t.Fatalf("cancelled task = %+v", got)
	}
}

func TestQueueOrderingAndControls(t *testing.T) {
	app := &App{}
	app.QueueClear()

	app.QueueEnqueue("low", 1)
	app.QueueEnqueue("high", 10)
	app.QueueEnqueue("mid", 5)
	app.QueueEnqueue("high", 20) // 同 id 更新优先级

	var ids []string
	_ = json.Unmarshal([]byte(app.QueueTaskIDs()), &ids)
	if len(ids) != 3 || ids[0] != "high" || ids[1] != "mid" || ids[2] != "low" {
		t.Fatalf("queue order = %v", ids)
	}

	app.QueuePause()
	var status struct {
		Paused  bool `json:"paused"`
		Pending int  `json:"pending"`
	}
	_ = json.Unmarshal([]byte(app.QueueStatus()), &status)
	if !status.Paused || status.Pending != 3 {
		t.Fatalf("status = %+v", status)
	}
	app.QueueResume()
	app.QueueClear()
	_ = json.Unmarshal([]byte(app.QueueTaskIDs()), &ids)
	if len(ids) != 0 {
		t.Fatalf("cleared queue = %v", ids)
	}
}

func TestDecomposeWithoutGatewayReportsError(t *testing.T) {
	fakeHome(t)
	app := &App{}
	var task Task
	_ = json.Unmarshal([]byte(app.CreateTask(`{"title":"做一个功能","description":"细节"}`)), &task)

	out := app.DecomposeTask(task.ID)
	if !strings.Contains(out, "error") || !strings.Contains(out, "网关") {
		t.Fatalf("no gateway should produce a readable error: %s", out)
	}
	if out := app.DecomposeTask("ghost"); !strings.Contains(out, "任务不存在") {
		t.Fatalf("unknown task = %s", out)
	}
}

func TestExecuteSubTaskWithoutGatewayFailsAndRecordsFriction(t *testing.T) {
	fakeHome(t)
	app := &App{}
	var task Task
	_ = json.Unmarshal([]byte(app.CreateTask(`{"title":"t","assignedAgents":["zcode"]}`)), &task)
	tasks := getTasks()
	tasks[0].SubTasks = []SubTask{{ID: "sub-1", Description: "做点事", AssignedAgent: "zcode", Status: "pending"}}
	_ = saveTasks(tasks)

	out := app.ExecuteSubTask(task.ID, "sub-1")
	if !strings.Contains(out, "error") {
		t.Fatalf("execute without gateway must fail: %s", out)
	}
	var got Task
	_ = json.Unmarshal([]byte(app.GetTask(task.ID)), &got)
	if got.SubTasks[0].Status != "failed" || got.SubTasks[0].Error == "" {
		t.Fatalf("subtask = %+v", got.SubTasks[0])
	}
	var score TrustScore
	_ = json.Unmarshal([]byte(app.AgentTrustScore("zcode")), &score)
	if score.FailedTasks != 1 {
		t.Fatalf("failure must be recorded in trust: %+v", score)
	}
	if points := readJSONList[FrictionPoint](frictionPointsPath()); len(points) != 1 {
		t.Fatalf("friction points = %+v", points)
	}
}

// ---------- 团队仓库 ----------

func TestTeamRepoInitStatusAndFiles(t *testing.T) {
	home := fakeHome(t)
	app := &App{}

	var status TeamRepoStatus
	_ = json.Unmarshal([]byte(app.TeamRepoStatus()), &status)
	if status.Initialized {
		t.Fatal("team repo should not exist yet")
	}

	var initRes struct {
		Success bool   `json:"success"`
		Error   string `json:"error"`
	}
	_ = json.Unmarshal([]byte(app.InitTeamRepo()), &initRes)
	if !initRes.Success {
		t.Skipf("git 不可用：%s", initRes.Error)
	}
	for _, sub := range []string{"skills", "rules", "mcp", "hooks", "knowledge"} {
		if !exists(filepath.Join(home, ".relay/team-repo", sub)) {
			t.Fatalf("missing subdir %s", sub)
		}
	}

	_ = json.Unmarshal([]byte(app.TeamRepoStatus()), &status)
	if !status.Initialized || !status.IsGitRepo || status.Branch != "main" {
		t.Fatalf("status = %+v", status)
	}

	// 写技能与规则
	if out := app.TeamRepoSaveSkill("code-review", "# 代码评审\n\n先看安全。"); !strings.Contains(out, `"ok":true`) {
		t.Fatalf("save skill = %s", out)
	}
	app.TeamRepoSaveRule("no-secrets", "# 禁止明文密钥\n")
	if out := app.TeamRepoSaveSkill("../escape", "x"); !strings.Contains(out, `"ok":false`) {
		t.Fatalf("path traversal must be rejected: %s", out)
	}

	var skills []map[string]any
	_ = json.Unmarshal([]byte(app.TeamRepoSkills()), &skills)
	if len(skills) != 1 || skills[0]["name"] != "code-review" {
		t.Fatalf("skills = %+v", skills)
	}
	var rules []map[string]any
	_ = json.Unmarshal([]byte(app.TeamRepoRules()), &rules)
	if len(rules) != 1 {
		t.Fatalf("rules = %+v", rules)
	}

	var content string
	_ = json.Unmarshal([]byte(app.TeamRepoGetSkill("code-review")), &content)
	if !strings.Contains(content, "代码评审") {
		t.Fatalf("content = %q", content)
	}
	if out := app.TeamRepoGetSkill("missing"); out != `""` {
		t.Fatalf("missing skill = %s", out)
	}

	_ = json.Unmarshal([]byte(app.TeamRepoStatus()), &status)
	if !status.LocalChanges {
		t.Fatal("saving files should show up as local changes")
	}
	if status.SkillCount != 1 || status.RuleCount != 1 {
		t.Fatalf("counts = %+v", status)
	}
}

func TestTeamRepoPushPullRequireRemote(t *testing.T) {
	fakeHome(t)
	app := &App{}
	if out := app.TeamRepoPush(); !strings.Contains(out, "尚未初始化") {
		t.Fatalf("push before init = %s", out)
	}
	if out := app.InitTeamRepo(); !strings.Contains(out, `"success":true`) {
		t.Skip("git 不可用")
	}
	if out := app.TeamRepoPush(); !strings.Contains(out, "未配置远端") {
		t.Fatalf("push without remote = %s", out)
	}
	if out := app.TeamRepoAddRemote("  "); !strings.Contains(out, "缺少远端地址") {
		t.Fatalf("empty remote = %s", out)
	}
}

func TestSyncConfigDefaultsAndPersist(t *testing.T) {
	fakeHome(t)
	app := &App{}

	var cfg SyncConfig
	_ = json.Unmarshal([]byte(app.TeamRepoSyncConfig()), &cfg)
	if cfg.AutoSync || cfg.AutoSyncInterval != 300000 {
		t.Fatalf("defaults = %+v", cfg)
	}
	if out := app.TeamRepoSaveSyncConfig(`{"autoSync":true,"autoSyncInterval":0}`); !strings.Contains(out, `"ok":true`) {
		t.Fatalf("save = %s", out)
	}
	_ = json.Unmarshal([]byte(app.TeamRepoSyncConfig()), &cfg)
	if !cfg.AutoSync || cfg.AutoSyncInterval != 300000 {
		t.Fatalf("persisted = %+v", cfg)
	}
	if out := app.TeamRepoSaveSyncConfig(`not json`); !strings.Contains(out, `"ok":false`) {
		t.Fatalf("bad json = %s", out)
	}
}
