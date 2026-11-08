package main

import (
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// 扫描编排与查询绑定（对应 Electron 的 engine.ts + ipc.ts 中的 agents/skills/mcp/tokens/dashboard 部分）。

// scanAndCache 执行一次扫描并整体替换缓存；单个适配器出错不影响其他。
func (a *App) scanAndCache(filter string) ([]string, []string, int64) {
	begin := time.Now()
	res := scanAll(filter)
	if a.store == nil {
		return res.Scanned, []string{"缓存库不可用"}, time.Since(begin).Milliseconds()
	}
	saved := make([]string, 0, len(res.Snapshots))
	for _, snap := range res.Snapshots {
		if err := a.store.SaveSnapshot(snap); err != nil {
			res.Errors = append(res.Errors, snap.Info.ID+": "+err.Error())
			continue
		}
		saved = append(saved, snap.Info.ID)
	}
	if filter == "" {
		// 全量扫描时清理注册表里已不存在的旧行（适配器改名/拆分后不留幽灵数据）
		ids := make([]string, 0, len(res.Scanned))
		for _, id := range res.Scanned {
			ids = append(ids, id)
		}
		if err := a.store.DeleteAgentsExcept(ids); err != nil {
			res.Errors = append(res.Errors, "清理旧数据失败: "+err.Error())
		}
	}
	_ = a.store.MetaSet("lastScanAt", strconv.FormatInt(time.Now().UnixMilli(), 10))
	_ = a.store.MetaSet("scannedAgents", strings.Join(res.Scanned, ","))
	return saved, res.Errors, time.Since(begin).Milliseconds()
}

// RefreshAgents 是扫描绑定入口（前端 app:refresh 与页面刷新都走它）。
func (a *App) RefreshAgents(filter string) string {
	scanned, errs, ms := a.scanAndCache(filter)
	out := map[string]any{
		"ok":            len(errs) == 0,
		"scannedAgents": scanned,
		"durationMs":    ms,
	}
	if len(errs) > 0 {
		out["error"] = strings.Join(errs, "; ")
	}
	if a.ctx != nil {
		runtime.EventsEmit(a.ctx, "scan:completed")
	}
	return toJSON(out)
}

// LastScan 返回上次扫描时间（ISO8601），没有则返回空串。
func (a *App) LastScan() string {
	if a.store == nil {
		return toJSON(map[string]any{"at": ""})
	}
	raw := a.store.MetaGet("lastScanAt")
	if raw == "" {
		return toJSON(map[string]any{"at": ""})
	}
	ms, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return toJSON(map[string]any{"at": ""})
	}
	return toJSON(map[string]any{"at": time.UnixMilli(ms).Format(time.RFC3339)})
}

func (a *App) GetAgents() string {
	if a.store == nil {
		return "[]"
	}
	agents, err := a.store.ListAgents()
	if err != nil {
		return "[]"
	}
	return toJSON(agents)
}

func (a *App) GetAgentDetail(id string) string {
	if a.store == nil || id == "" {
		return "null"
	}
	detail, err := a.store.AgentDetail(id)
	if err != nil || detail == nil {
		return "null"
	}
	return toJSON(detail)
}

func (a *App) GetSkills(agentID, search string) string {
	if a.store == nil {
		return "[]"
	}
	skills, err := a.store.ListSkills(search, agentID)
	if err != nil {
		return "[]"
	}
	return toJSON(skills)
}

func (a *App) GetMcpServers(agentID string) string {
	if a.store == nil {
		return "[]"
	}
	servers, err := a.store.ListMCP(agentID)
	if err != nil {
		return "[]"
	}
	return toJSON(servers)
}

// GetAgentDashboard 是仪表盘的数据源：计数来自缓存，token 来自各智能体的真实用量。
func (a *App) GetAgentDashboard() string {
	out := map[string]any{
		"agentCount": 0, "installedAgents": 0, "residualAgents": 0,
		"skillCount": 0, "mcpTotal": 0, "mcpOnline": 0, "mcpOffline": 0,
		"todayTokens": 0, "yesterdayTokens": 0, "last7dTokens": 0,
		"repoCount": 0, "commitCount7d": 0,
		"topAgents": []any{}, "topModels": []any{},
	}
	if a.store == nil {
		return toJSON(out)
	}
	counts, err := a.store.ScanCounts()
	if err != nil {
		return toJSON(out)
	}
	nums, err := a.store.DashboardNumbers()
	if err != nil {
		return toJSON(out)
	}
	names := map[string]string{}
	if agents, err := a.store.ListAgents(); err == nil {
		for _, ag := range agents {
			names[ag.ID] = ag.Name
		}
	}
	topAgents := make([]map[string]any, 0, len(nums.TopAgents))
	for _, t := range nums.TopAgents {
		name := names[t.AgentID]
		if name == "" {
			name = t.AgentID
		}
		topAgents = append(topAgents, map[string]any{
			"agentId": t.AgentID, "name": name, "totalTokens": t.TotalTokens,
		})
	}
	topModels := make([]map[string]any, 0, len(nums.TopModels))
	for _, m := range nums.TopModels {
		topModels = append(topModels, map[string]any{"model": m.Model, "totalTokens": m.TotalTokens})
	}

	lastScan := ""
	if raw := a.store.MetaGet("lastScanAt"); raw != "" {
		if ms, err := strconv.ParseInt(raw, 10, 64); err == nil {
			lastScan = time.UnixMilli(ms).Format(time.RFC3339)
		}
	}
	out["agentCount"] = counts.Agents
	out["installedAgents"] = counts.InstalledAgents
	out["residualAgents"] = counts.ResidualAgents
	out["skillCount"] = counts.Skills
	out["mcpTotal"] = counts.MCP
	out["mcpOnline"] = counts.MCPOnline
	out["mcpOffline"] = counts.MCPOffline
	out["repoCount"] = counts.Repos
	out["todayTokens"] = nums.TodayTokens
	out["yesterdayTokens"] = nums.YesterdayTokens
	out["last7dTokens"] = nums.Last7dTokens
	out["topAgents"] = topAgents
	out["topModels"] = topModels
	if lastScan != "" {
		out["lastScanAt"] = lastScan
	}
	return toJSON(out)
}

// GetUsageRecords 返回 Token 明细（可按模型/智能体/时间过滤）。
func (a *App) GetUsageRecords(model, agentID string, sinceMs, untilMs int64, limit int) string {
	if a.store == nil {
		return "[]"
	}
	records, err := a.store.UsageRecords(model, agentID, sinceMs, untilMs, limit)
	if err != nil {
		return "[]"
	}
	return toJSON(records)
}

// GetUsageStats 返回按天/智能体/模型聚合的用量序列。
func (a *App) GetUsageStats(dimension string, days int) string {
	if dimension == "" {
		dimension = "day"
	}
	if a.store == nil {
		return toJSON(usageStatsPayload(dimension, []SeriesPoint{}))
	}
	points, err := a.store.UsageStats(dimension, days)
	if err != nil {
		points = []SeriesPoint{}
	}
	return toJSON(usageStatsPayload(dimension, points))
}

// usageStatsPayload 组装 Tokens 页面吃的形状（series/daily/total/models/costInfo）。
func usageStatsPayload(dimension string, points []SeriesPoint) map[string]any {
	series := make([]map[string]any, 0, len(points))
	models := []string{}
	total := SeriesPoint{Key: "all"}
	for _, p := range points {
		series = append(series, map[string]any{
			"key": p.Key, "tokens": p.Tokens, "requests": p.Requests,
			"inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 0,
			"cacheWriteTokens": 0, "reasoningTokens": 0,
			"estCostCny": p.CostCNY,
		})
		total.Tokens += p.Tokens
		total.Requests += p.Requests
		total.CostCNY += p.CostCNY
		if dimension == "model" {
			models = append(models, p.Key)
		}
	}
	sort.Strings(models)
	return map[string]any{
		"dimension": dimension,
		"series":    series,
		"daily":     series,
		"models":    models,
		"total": map[string]any{
			"key": "all", "tokens": total.Tokens, "requests": total.Requests,
			"estCostCny": total.CostCNY,
		},
		"costInfo": map[string]any{
			"totalCostCny": total.CostCNY, "pricedTokens": total.Tokens,
			"totalTokens": total.Tokens, "unpricedModels": []string{},
			"rateUsdCny": defaultRateUSDCNY,
		},
	}
}

// filterPair 解析 {search, agentId} 形式的过滤参数。
func filterPair(v any) (agentID, search string) {
	m, ok := v.(map[string]any)
	if !ok {
		return "", ""
	}
	agentID, _ = m["agentId"].(string)
	search, _ = m["search"].(string)
	return agentID, search
}

// usageRecordsFromQuery 解析 TokenDetailQuery（since/until 是 ISO 字符串）。
func (a *App) usageRecordsFromQuery(v any) string {
	m, _ := v.(map[string]any)
	model, _ := m["model"].(string)
	agentID, _ := m["agentId"].(string)
	return a.GetUsageRecords(model, agentID, isoToMillis(m["since"]), isoToMillis(m["until"]), 2000)
}

// usageStatsFromQuery 解析维度 + 天数（页面用 {days} 控制窗口）。
func (a *App) usageStatsFromQuery(dimension string, v any) string {
	m, _ := v.(map[string]any)
	days := 14
	if f, ok := m["days"].(float64); ok && f > 0 {
		days = int(f)
	}
	return a.GetUsageStats(dimension, days)
}

func isoToMillis(v any) int64 {
	s, _ := v.(string)
	if s == "" {
		return 0
	}
	return parseISOMillis(s)
}
