package main

import (
	"encoding/csv"
	"encoding/json"
	"strings"
	"time"
)

// Invoke 是旧前端 window.api 的统一入口：所有历史 IPC channel 都路由到这里。
// 已迁移到网关口径的能力返回真实数据，其余旧模块返回安全空值，保证页面不崩。
func (a *App) Invoke(channel, rawArgs string) string {
	var args []any
	if rawArgs != "" {
		_ = json.Unmarshal([]byte(rawArgs), &args)
	}
	arg := func(i int) any {
		if i < len(args) {
			return args[i]
		}
		return nil
	}
	str := func(i int) string {
		s, _ := arg(i).(string)
		return s
	}

	switch channel {
	case "app:lastScan":
		return a.LastScan()
	case "app:refresh":
		filter := ""
		if opts, ok := arg(0).(map[string]any); ok {
			filter, _ = opts["agentId"].(string)
		}
		return a.RefreshAgents(filter)
	case "update:check":
		return toJSON(a.checkUpdate(false))
	case "shell:openExternal":
		a.OpenExternal(str(0))
		return "null"
	case "io:export":
		// 内容由前端适配层生成并触发浏览器下载，这里只回执。
		return toJSON(map[string]any{"ok": true, "canceled": false})
	case "settings:get":
		return "null"
	case "settings:set":
		return "null"
	// ---------- 任务 / 队列 ----------
	case "tasks:list":
		return a.ListTasks()
	case "tasks:get":
		return a.GetTask(str(0))
	case "tasks:create":
		return a.CreateTask(rawArg(arg(0)))
	case "tasks:updateStatus":
		return a.UpdateTaskStatus(str(0), str(1))
	case "tasks:decompose":
		return a.DecomposeTask(str(0))
	case "tasks:assignSubTask":
		return a.AssignSubTask(str(0), str(1), str(2))
	case "tasks:executeSubTask":
		return a.ExecuteSubTask(str(0), str(1))
	case "tasks:monitor":
		return a.MonitorTask(str(0))
	case "tasks:cancel":
		return a.CancelTask(str(0))
	case "tasks:ready":
		return a.ReadyTasks()
	case "queue:status":
		return a.QueueStatus()
	case "queue:enqueue":
		return a.QueueEnqueue(str(0), int(intOf(arg(1))))
	case "queue:pause":
		return a.QueuePause()
	case "queue:resume":
		return a.QueueResume()
	case "queue:clear":
		return a.QueueClear()
	case "queue:taskIds":
		return a.QueueTaskIDs()
	// ---------- 约束 / 信任度 ----------
	case "constraints:list":
		return a.ListConstraints()
	case "constraints:add":
		return a.AddConstraint(rawArg(arg(0)))
	case "constraints:update":
		return a.UpdateConstraint(str(0), rawArg(arg(1)))
	case "constraints:delete":
		return a.DeleteConstraint(str(0))
	case "constraints:agent":
		return a.AgentConstraints(str(0))
	case "constraints:validate":
		return a.ValidateConstraints(str(0), rawArg(arg(1)))
	case "trust:scores":
		return a.TrustScores()
	case "trust:agent":
		return a.AgentTrustScore(str(0))
	case "trust:update":
		success, _ := arg(1).(bool)
		return a.UpdateTrust(str(0), success, floatOf(arg(2)))
	case "trust:frictionStats":
		return a.FrictionStats(str(0))
	case "trust:rank":
		return a.RankByTrust(stringSlice(arg(0)))
	// ---------- 团队仓库 ----------
	case "teamRepo:init":
		return a.InitTeamRepo()
	case "teamRepo:status":
		return a.TeamRepoStatus()
	case "teamRepo:addRemote":
		return a.TeamRepoAddRemote(str(0))
	case "teamRepo:push":
		return a.TeamRepoPush()
	case "teamRepo:pull":
		return a.TeamRepoPull()
	case "teamRepo:skills":
		return a.TeamRepoSkills()
	case "teamRepo:rules":
		return a.TeamRepoRules()
	case "teamRepo:getSkill":
		return a.TeamRepoGetSkill(str(0))
	case "teamRepo:getRule":
		return a.TeamRepoGetRule(str(0))
	case "teamRepo:saveSkill":
		return a.TeamRepoSaveSkill(str(0), str(1))
	case "teamRepo:saveRule":
		return a.TeamRepoSaveRule(str(0), str(1))
	case "teamRepo:syncConfig":
		return a.TeamRepoSyncConfig()
	case "teamRepo:saveSyncConfig":
		return a.TeamRepoSaveSyncConfig(rawArg(arg(0)))
	case "git:commits":
		return toJSON(a.listCommits(gitFilter(arg(0))))
	case "git:commitDetail":
		detail := a.getCommitDetail(str(0))
		if detail == nil {
			return "null"
		}
		return toJSON(detail)
	case "hooks:list":
		return a.ListHooks()
	case "hooks:targets":
		return a.ListHookTargets()
	case "hooks:create":
		return a.CreateHook(hookInput(arg(0)))
	case "hooks:delete":
		return a.DeleteHook(str(0))
	case "models:list":
		return a.ListModelProfiles()
	case "models:save":
		return a.SaveModelProfile(rawArg(arg(0)))
	case "models:delete":
		return a.DeleteModelProfile(str(0))
	case "models:appliers":
		return a.ListAppliers()
	case "models:apply":
		return a.ApplyModelProfile(str(0), stringSlice(arg(1)), rawArg(arg(2)))
	case "models:catalog":
		return a.FetchModelCatalog(str(0), str(1), str(2))
	case "pricing:get":
		prices := []map[string]any{}
		for model, p := range a.cfg.Prices {
			prices = append(prices, map[string]any{
				"model": model, "currency": "USD", "input": p.Input,
				"output": p.Output, "cacheRead": p.CacheRead, "cacheWrite": p.CacheWrite,
			})
		}
		return toJSON(map[string]any{"prices": prices, "rateUsdCny": a.cfg.RateUSDCNY})
	case "pricing:save":
		if raw, ok := arg(0).(map[string]any); ok {
			if rate, ok := raw["rateUsdCny"].(float64); ok && rate > 0 {
				a.cfg.RateUSDCNY = rate
				_ = a.cfg.save()
			}
		}
		return "null"
	case "pricing:reset":
		a.cfg.Prices = defaultPrices()
		a.cfg.RateUSDCNY = 7.2
		_ = a.cfg.save()
		return "null"
	case "gw:get":
		return toJSON(map[string]any{
			"name": "Relay", "port": a.cfg.Port, "running": gatewayAddr(a.gw) != "",
			"endpoint": gatewayAddr(a.gw), "autoStart": true,
			"key": maskKey(a.cfg.APIKey), "models": []any{},
		})
	case "gw:logs":
		return "[]"
	case "gw:revealKey":
		return a.RevealKey()
	case "gw:regenKey":
		return toJSON(map[string]any{"key": a.RegenerateKey()})
	case "gw:start", "gw:stop", "gw:update":
		return "null"
	case "agents:scan":
		return a.GetAgents()
	case "agents:detail":
		return a.GetAgentDetail(str(0))
	case "skills:list":
		agentID, search := filterPair(arg(0))
		return a.GetSkills(agentID, search)
	case "mcp:list":
		return a.GetMcpServers(str(0))
	case "security:scan":
		return a.RunSecurityScan()
	case "security:pickRepo":
		return a.PickRepoDir()
	case "security:repoScan":
		return a.RunRepoSecurityScan(str(0))
	case "mcp:check":
		return a.CheckMcp(str(0))
	case "mcp:checkAll":
		return a.CheckAllMcp(str(0))
	case "tokens:records":
		return a.usageRecordsFromQuery(arg(0))
	case "dashboard":
		return a.GetAgentDashboard()
	case "tokens:stats":
		return a.usageStatsFromQuery(str(0), arg(1))
	default:
		return defaultFor(channel)
	}
}

// 旧页面的列表型 channel 必须返回数组，否则前端 .map 会抛错。
var arrayChannels = map[string]bool{
	"agents:scan": true, "skills:list": true, "mcp:list": true, "mcp:check": true,
	"mcp:checkAll": true, "git:commits": true, "models:list": true, "models:appliers": true,
	"hooks:list": true, "hooks:targets": true, "skills:copyTargets": true,
	"teamRepo:skills": true, "teamRepo:rules": true, "tasks:list": true,
	"tasks:ready": true, "queue:taskIds": true, "constraints:list": true,
	"trust:scores": true, "trust:rank": true, "trust:frictionStats": true,
	"models:catalog": true, "agents:detail": false,
}

var objectChannels = map[string]string{
	"security:scan":        `{"findings":[],"scannedFiles":0,"riskCount":0}`,
	"security:repoScan":    `{"findings":[],"scannedFiles":0,"riskCount":0}`,
	"security:pickRepo":    `""`,
	"queue:status":         `{"running":false,"pending":0,"processing":null}`,
	"teamRepo:status":      `{"initialized":false,"isGitRepo":false,"branch":"main","localChanges":false}`,
	"teamRepo:syncConfig":  `{"autoSync":false,"autoSyncInterval":300000}`,
	"gw:simulate":          `{"tier":"standard","model":"","output":""}`,
	"gw:testModel":         `{"ok":true,"latencyMs":0,"preview":""}`,
	"tasks:monitor":        `{"taskId":"","status":"idle","subTasks":[]}`,
	"constraints:validate": `{"allowed":true,"violations":[]}`,
}

// hookInput / rawArg / stringSlice 负责把旧 IPC 的松散参数收成 Go 侧结构。
func gitFilter(v any) GitFilter {
	m, _ := v.(map[string]any)
	return GitFilter{
		AgentID: strOf(m["agentId"]),
		Project: strOf(m["project"]),
		Since:   strOf(m["since"]),
		Until:   strOf(m["until"]),
		Search:  strOf(m["search"]),
		Limit:   int(intOf(m["limit"])),
	}
}

func hookInput(v any) HookCreateInput {
	m, _ := v.(map[string]any)
	return HookCreateInput{
		AgentID: strOf(m["agentId"]),
		Event:   strOf(m["event"]),
		Matcher: strOf(m["matcher"]),
		Command: strOf(m["command"]),
		Timeout: int(intOf(m["timeout"])),
	}
}

func rawArg(v any) string {
	if v == nil {
		return ""
	}
	b, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	return string(b)
}

func stringSlice(v any) []string {
	list, _ := v.([]any)
	out := make([]string, 0, len(list))
	for _, item := range list {
		if s := strOf(item); s != "" {
			out = append(out, s)
		}
	}
	return out
}

func defaultFor(channel string) string {
	if v, ok := objectChannels[channel]; ok {
		return v
	}
	if arrayChannels[channel] {
		return "[]"
	}
	return "{}"
}

// ---------- CSV 导出 ----------

func (a *App) ExportCSV(kind, dimension string, days int) string {
	if days <= 0 || days > 365 {
		days = 30
	}
	var buf strings.Builder
	buf.WriteString("\ufeff")
	w := csv.NewWriter(&buf)
	if kind == "aggregate" {
		_ = w.Write([]string{"维度", "Token", "请求", "估算成本(CNY)"})
		points := []SeriesPoint{}
		_ = json.Unmarshal([]byte(a.GetStats(dimension, days)), &points)
		for _, p := range points {
			_ = w.Write([]string{p.Key, itoa(p.Tokens), itoa(p.Requests), ftoa(p.CostCNY)})
		}
	} else {
		_ = w.Write([]string{"时间", "模型", "来源", "输入", "输出", "缓存读", "缓存写", "推理", "合计", "成本(USD)", "状态"})
		rows, err := a.store.Recent(500)
		if err == nil {
			for _, r := range rows {
				_ = w.Write([]string{
					time.UnixMilli(r.TS).Format("2006-01-02 15:04:05"), r.Model, r.Source,
					itoa(r.InputTokens), itoa(r.OutputTokens), itoa(r.CacheRead),
					itoa(r.CacheWrite), itoa(r.Reasoning), itoa(r.Total()),
					ftoa(r.CostUSD), r.Status,
				})
			}
		}
	}
	w.Flush()
	return buf.String()
}

func itoa(n int64) string {
	return strings.TrimSpace(jsonNumber(n))
}

func jsonNumber(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}

func ftoa(f float64) string {
	b, _ := json.Marshal(f)
	return string(b)
}
