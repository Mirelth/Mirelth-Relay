package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// 扫描结果缓存（对应 Electron 的 src/main/cache.ts）。
// 每次全量扫描后按智能体整体替换，界面读取一律走这里，保证与扫描解耦、读取稳定。

// McpServer 是落库后的 MCP 条目（比扫描产物多 id/agentId/状态与检测时间）。
type McpServer struct {
	ID           string    `json:"id"`
	AgentID      string    `json:"agentId"`
	Name         string    `json:"name"`
	Transport    string    `json:"transport"`
	Endpoint     string    `json:"endpoint,omitempty"`
	Status       string    `json:"status"`
	StatusDetail string    `json:"statusDetail,omitempty"`
	Tools        []McpTool `json:"tools"`
	LastChecked  string    `json:"lastChecked,omitempty"`
	Enabled      bool      `json:"enabled"`
}

type AgentDetail struct {
	Info        AgentInfo        `json:"info"`
	Configs     []ConfigFileInfo `json:"configs"`
	DataDirs    []DataDirInfo    `json:"dataDirs"`
	Skills      []SkillInfo      `json:"skills"`
	MCPServers  []McpServer      `json:"mcpServers"`
	ProjectDirs []string         `json:"projectDirs"`
}

// TokenRecord 是 Tokens 页面用的单条用量记录。
type TokenRecord struct {
	AgentID          string  `json:"agentId"`
	TS               string  `json:"ts"`
	Model            string  `json:"model"`
	InputTokens      int64   `json:"inputTokens"`
	OutputTokens     int64   `json:"outputTokens"`
	CacheReadTokens  int64   `json:"cacheReadTokens"`
	CacheWriteTokens int64   `json:"cacheWriteTokens"`
	ReasoningTokens  int64   `json:"reasoningTokens"`
	Requests         int64   `json:"requests"`
	CostUSD          float64 `json:"costUsd,omitempty"`
}

type ScanCounts struct {
	Agents          int64 `json:"agents"`
	InstalledAgents int64 `json:"installedAgents"`
	ResidualAgents  int64 `json:"residualAgents"`
	Skills          int64 `json:"skills"`
	MCP             int64 `json:"mcp"`
	MCPOnline       int64 `json:"mcpOnline"`
	MCPOffline      int64 `json:"mcpOffline"`
	Repos           int64 `json:"repos"`
}

type DashboardNumbers struct {
	TodayTokens     int64      `json:"todayTokens"`
	YesterdayTokens int64      `json:"yesterdayTokens"`
	Last7dTokens    int64      `json:"last7dTokens"`
	TopAgents       []TopAgent `json:"topAgents"`
	TopModels       []TopModel `json:"topModels"`
}

type TopAgent struct {
	AgentID     string `json:"agentId"`
	TotalTokens int64  `json:"totalTokens"`
}

type TopModel struct {
	Model       string `json:"model"`
	TotalTokens int64  `json:"totalTokens"`
}

// createScanSchema 幂等建表；与 Electron 侧表结构保持同义（表名换成 agent_* 以区分网关用量）。
func createScanSchema(db *sql.DB) error {
	_, err := db.Exec(`
create table if not exists scan_meta (key text primary key, value text);
create table if not exists agents (
  id text primary key,
  name text, vendor text, version text, kind text,
  detected integer, skill_count integer, mcp_count integer,
  has_usage integer, project_count integer, color text,
  detail_json text, install_state text not null default 'unknown'
);
create table if not exists agent_skills (
  id text primary key, agent_id text, name text, version text,
  description text, installed_at text, source text, builtin integer
);
create index if not exists idx_agent_skills_agent on agent_skills(agent_id);
create table if not exists agent_mcp (
  id text primary key, agent_id text, name text, transport text,
  endpoint text, enabled integer, tools_json text,
  status text, status_detail text, last_checked text
);
create table if not exists agent_usage (
  agent_id text, ts integer, model text,
  input_tokens integer, output_tokens integer,
  cache_read integer, cache_write integer, reasoning integer,
  requests integer, cost real
);
create index if not exists idx_agent_usage_ts on agent_usage(ts);
create table if not exists agent_projects (agent_id text, path text);
create table if not exists scan_log (agent_id text, at integer, ok integer, error text);
`)
	return err
}

// SaveSnapshot 用一个快照整体替换该智能体的缓存行（单事务，避免读到半边数据）。
func (s *Store) SaveSnapshot(snap AgentSnapshot) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	info := snap.Info
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	for _, table := range []string{"agents", "agent_skills", "agent_mcp", "agent_usage", "agent_projects"} {
		col := "agent_id"
		if table == "agents" {
			col = "id"
		}
		if _, err := tx.Exec(`delete from `+table+` where `+col+` = ?`, info.ID); err != nil {
			return err
		}
	}

	detail, err := json.Marshal(map[string]any{
		"configs":     snap.Configs,
		"dataDirs":    snap.DataDirs,
		"projectDirs": snap.ProjectDirs,
	})
	if err != nil {
		return err
	}
	installState := info.InstallState
	if installState == "" {
		installState = "unknown"
	}
	if _, err := tx.Exec(`insert into agents
(id, name, vendor, version, kind, detected, skill_count, mcp_count, has_usage, project_count, color, detail_json, install_state)
values (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		info.ID, info.Name, nullIfEmpty(info.Vendor), nullIfEmpty(info.Version), info.Kind,
		boolInt(info.Detected), len(snap.Skills), len(snap.MCPServers), boolInt(len(snap.Usage) > 0),
		len(snap.ProjectDirs), info.Color, string(detail), installState); err != nil {
		return err
	}

	for _, skill := range snap.Skills {
		if _, err := tx.Exec(`insert or replace into agent_skills
(id, agent_id, name, version, description, installed_at, source, builtin)
values (?,?,?,?,?,?,?,?)`,
			skill.ID, skill.AgentID, skill.Name, nullIfEmpty(skill.Version), nullIfEmpty(skill.Description),
			nullIfEmpty(skill.InstalledAt), skill.Source, boolInt(skill.Builtin)); err != nil {
			return err
		}
	}

	for _, m := range snap.MCPServers {
		tools, _ := json.Marshal(m.Tools)
		status := m.Status
		if status == "" {
			status = "unverified"
		}
		if _, err := tx.Exec(`insert or replace into agent_mcp
(id, agent_id, name, transport, endpoint, enabled, tools_json, status, status_detail, last_checked)
values (?,?,?,?,?,?,?,?,?,?)`,
			info.ID+":"+m.Name, info.ID, m.Name, m.Transport, nullIfEmpty(m.Endpoint),
			boolInt(m.Enabled), string(tools), status, nullIfEmpty(m.StatusDetail), nil); err != nil {
			return err
		}
	}

	for _, u := range snap.Usage {
		if _, err := tx.Exec(`insert into agent_usage
(agent_id, ts, model, input_tokens, output_tokens, cache_read, cache_write, reasoning, requests, cost)
values (?,?,?,?,?,?,?,?,?,?)`,
			info.ID, u.TS, u.Model, u.InputTokens, u.OutputTokens, u.CacheReadTokens,
			u.CacheWriteTokens, u.ReasoningTokens, u.Requests, u.CostUSD); err != nil {
			return err
		}
	}

	for _, p := range snap.ProjectDirs {
		if _, err := tx.Exec(`insert into agent_projects (agent_id, path) values (?,?)`, info.ID, p); err != nil {
			return err
		}
	}

	if _, err := tx.Exec(`insert into scan_log (agent_id, at, ok, error) values (?,?,?,?)`,
		info.ID, time.Now().UnixMilli(), 1, nil); err != nil {
		return err
	}
	return tx.Commit()
}

// ListAgents 按「已检测优先、技能+MCP 多者优先、名称」排序，与 Electron 侧一致。
func (s *Store) ListAgents() ([]AgentInfo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.Query(`select id, name, vendor, version, kind, detected, skill_count, mcp_count,
has_usage, project_count, color, install_state
from agents order by detected desc, skill_count + mcp_count desc, name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []AgentInfo{}
	for rows.Next() {
		var (
			info                       AgentInfo
			vendor, version, state     sql.NullString
			detected, hasUsage         int
			skillCount, mcpCount, proj int
		)
		if err := rows.Scan(&info.ID, &info.Name, &vendor, &version, &info.Kind, &detected,
			&skillCount, &mcpCount, &hasUsage, &proj, &info.Color, &state); err != nil {
			return nil, err
		}
		info.Vendor = vendor.String
		info.Version = version.String
		info.Detected = detected == 1
		info.HasUsage = hasUsage == 1
		info.SkillCount = skillCount
		info.McpCount = mcpCount
		info.ProjectCount = proj
		info.InstallState = state.String
		if info.InstallState == "" {
			info.InstallState = "unknown"
		}
		out = append(out, info)
	}
	return out, rows.Err()
}

// AgentDetail 组装单个智能体的详情页数据。
func (s *Store) AgentDetail(id string) (*AgentDetail, error) {
	agents, err := s.ListAgents()
	if err != nil {
		return nil, err
	}
	var info *AgentInfo
	for i := range agents {
		if agents[i].ID == id {
			info = &agents[i]
			break
		}
	}
	if info == nil {
		return nil, nil
	}

	s.mu.Lock()
	var detailJSON sql.NullString
	_ = s.db.QueryRow(`select detail_json from agents where id = ?`, id).Scan(&detailJSON)
	s.mu.Unlock()

	detail := &AgentDetail{Info: *info, Configs: []ConfigFileInfo{}, DataDirs: []DataDirInfo{}, ProjectDirs: []string{}}
	if detailJSON.String != "" {
		var parsed struct {
			Configs     []ConfigFileInfo `json:"configs"`
			DataDirs    []DataDirInfo    `json:"dataDirs"`
			ProjectDirs []string         `json:"projectDirs"`
		}
		if json.Unmarshal([]byte(detailJSON.String), &parsed) == nil {
			if parsed.Configs != nil {
				detail.Configs = parsed.Configs
			}
			if parsed.DataDirs != nil {
				detail.DataDirs = parsed.DataDirs
			}
			if parsed.ProjectDirs != nil {
				detail.ProjectDirs = parsed.ProjectDirs
			}
		}
	}
	skills, err := s.ListSkills("", id)
	if err != nil {
		return nil, err
	}
	mcp, err := s.ListMCP(id)
	if err != nil {
		return nil, err
	}
	detail.Skills = skills
	detail.MCPServers = mcp
	return detail, nil
}

// ListSkills 支持按智能体与关键字过滤（名称或描述模糊匹配）。
func (s *Store) ListSkills(search, agentID string) ([]SkillInfo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	conds := []string{}
	args := []any{}
	if agentID != "" {
		conds = append(conds, "agent_id = ?")
		args = append(args, agentID)
	}
	if search != "" {
		conds = append(conds, "(name like ? or ifnull(description,'') like ?)")
		like := "%" + search + "%"
		args = append(args, like, like)
	}
	where := ""
	if len(conds) > 0 {
		where = "where " + strings.Join(conds, " and ")
	}
	rows, err := s.db.Query(`select id, agent_id, name, version, description, installed_at, source, builtin
from agent_skills `+where+` order by agent_id, name`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []SkillInfo{}
	for rows.Next() {
		var (
			skill                 SkillInfo
			version, desc, instAt sql.NullString
			builtin               int
		)
		if err := rows.Scan(&skill.ID, &skill.AgentID, &skill.Name, &version, &desc,
			&instAt, &skill.Source, &builtin); err != nil {
			return nil, err
		}
		skill.Version = version.String
		skill.Description = desc.String
		skill.InstalledAt = instAt.String
		skill.Builtin = builtin == 1
		out = append(out, skill)
	}
	return out, rows.Err()
}

// ListMCP 返回 MCP 清单（agentID 为空时返回全部）。
func (s *Store) ListMCP(agentID string) ([]McpServer, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	where, args := "", []any{}
	if agentID != "" {
		where, args = "where agent_id = ?", append(args, agentID)
	}
	rows, err := s.db.Query(`select id, agent_id, name, transport, endpoint, enabled, tools_json,
status, status_detail, last_checked from agent_mcp `+where+` order by agent_id, name`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []McpServer{}
	for rows.Next() {
		var (
			m                        McpServer
			endpoint, detail, lastCh sql.NullString
			toolsJSON                sql.NullString
			enabled                  int
		)
		if err := rows.Scan(&m.ID, &m.AgentID, &m.Name, &m.Transport, &endpoint, &enabled,
			&toolsJSON, &m.Status, &detail, &lastCh); err != nil {
			return nil, err
		}
		m.Endpoint = endpoint.String
		m.Enabled = enabled == 1
		m.StatusDetail = detail.String
		m.LastChecked = lastCh.String
		m.Tools = []McpTool{}
		if toolsJSON.String != "" {
			_ = json.Unmarshal([]byte(toolsJSON.String), &m.Tools)
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// DeleteAgentsExcept 清掉注册表里已不存在的适配器遗留行（改名/拆分后不留幽灵数据）。
func (s *Store) DeleteAgentsExcept(ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	for _, stmt := range []string{
		`delete from agents where id not in (` + placeholders + `)`,
		`delete from agent_skills where agent_id not in (` + placeholders + `)`,
		`delete from agent_mcp where agent_id not in (` + placeholders + `)`,
		`delete from agent_usage where agent_id not in (` + placeholders + `)`,
		`delete from agent_projects where agent_id not in (` + placeholders + `)`,
		`delete from scan_log where agent_id not in (` + placeholders + `)`,
	} {
		if _, err := s.db.Exec(stmt, args...); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) ScanCounts() (ScanCounts, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	out := ScanCounts{}
	one := func(sqlText string) int64 {
		var n sql.NullInt64
		_ = s.db.QueryRow(sqlText).Scan(&n)
		return n.Int64
	}
	out.Agents = one(`select count(*) from agents where detected = 1`)
	out.InstalledAgents = one(`select count(*) from agents where detected = 1 and install_state = 'installed'`)
	out.ResidualAgents = one(`select count(*) from agents where detected = 1 and install_state = 'residual'`)
	out.Skills = one(`select count(*) from agent_skills`)
	out.MCP = one(`select count(*) from agent_mcp`)
	out.MCPOnline = one(`select count(*) from agent_mcp where status = 'online'`)
	out.MCPOffline = one(`select count(*) from agent_mcp where status = 'offline'`)
	out.Repos = one(`select count(distinct path) from agent_projects`)
	return out, nil
}

const tokenSumExpr = `input_tokens + output_tokens + cache_read + cache_write + reasoning`

func (s *Store) DashboardNumbers() (DashboardNumbers, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	startOfToday := startOfDay().UnixMilli()
	startOfYesterday := startOfToday - 86400_000
	start7d := startOfToday - 6*86400_000

	num := DashboardNumbers{TopAgents: []TopAgent{}, TopModels: []TopModel{}}
	sum := func(sqlText string, args ...any) int64 {
		var v sql.NullInt64
		_ = s.db.QueryRow(sqlText, args...).Scan(&v)
		return v.Int64
	}
	num.TodayTokens = sum(`select sum(`+tokenSumExpr+`) from agent_usage where ts >= ?`, startOfToday)
	num.YesterdayTokens = sum(`select sum(`+tokenSumExpr+`) from agent_usage where ts >= ? and ts < ?`,
		startOfYesterday, startOfToday)
	num.Last7dTokens = sum(`select sum(`+tokenSumExpr+`) from agent_usage where ts >= ?`, start7d)

	if rows, err := s.db.Query(`select agent_id, sum(` + tokenSumExpr + `) t from agent_usage
group by agent_id order by t desc limit 6`); err == nil {
		defer rows.Close()
		for rows.Next() {
			var row TopAgent
			var v sql.NullInt64
			if err := rows.Scan(&row.AgentID, &v); err != nil {
				break
			}
			row.TotalTokens = v.Int64
			num.TopAgents = append(num.TopAgents, row)
		}
	}
	if rows, err := s.db.Query(`select model, sum(` + tokenSumExpr + `) t from agent_usage
group by model order by t desc limit 8`); err == nil {
		defer rows.Close()
		for rows.Next() {
			var row TopModel
			var v sql.NullInt64
			if err := rows.Scan(&row.Model, &v); err != nil {
				break
			}
			row.TotalTokens = v.Int64
			num.TopModels = append(num.TopModels, row)
		}
	}
	return num, nil
}

// UsageRecords 返回最近的单条用量（Tokens 页明细）。
func (s *Store) UsageRecords(model, agentID string, since, until int64, limit int) ([]TokenRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	conds := []string{}
	args := []any{}
	if model != "" {
		conds = append(conds, "model = ?")
		args = append(args, model)
	}
	if agentID != "" {
		conds = append(conds, "agent_id = ?")
		args = append(args, agentID)
	}
	if since > 0 {
		conds = append(conds, "ts >= ?")
		args = append(args, since)
	}
	if until > 0 {
		conds = append(conds, "ts < ?")
		args = append(args, until)
	}
	where := ""
	if len(conds) > 0 {
		where = "where " + strings.Join(conds, " and ")
	}
	if limit <= 0 || limit > 2000 {
		limit = 200
	}
	args = append(args, limit)

	rows, err := s.db.Query(`select agent_id, ts, model, input_tokens, output_tokens,
cache_read, cache_write, reasoning, requests, cost from agent_usage `+where+` order by ts desc limit ?`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []TokenRecord{}
	for rows.Next() {
		var r TokenRecord
		var ts int64
		var cost sql.NullFloat64
		if err := rows.Scan(&r.AgentID, &ts, &r.Model, &r.InputTokens, &r.OutputTokens,
			&r.CacheReadTokens, &r.CacheWriteTokens, &r.ReasoningTokens, &r.Requests, &cost); err != nil {
			return nil, err
		}
		r.TS = time.UnixMilli(ts).Format(time.RFC3339)
		r.CostUSD = cost.Float64
		out = append(out, r)
	}
	return out, rows.Err()
}

// UsageStats 按天/智能体/模型聚合，供趋势图与排行使用。
func (s *Store) UsageStats(dimension string, days int) ([]SeriesPoint, error) {
	if days <= 0 || days > 365 {
		days = 14
	}
	since := startOfDay().AddDate(0, 0, -(days - 1)).UnixMilli()

	s.mu.Lock()
	defer s.mu.Unlock()

	groupExpr := "model"
	switch dimension {
	case "day":
		groupExpr = "strftime('%Y-%m-%d', ts/1000, 'unixepoch', 'localtime')"
	case "agent":
		groupExpr = "agent_id"
	}
	rows, err := s.db.Query(`select `+groupExpr+` as key,
coalesce(sum(`+tokenSumExpr+`), 0) tokens,
coalesce(sum(requests), 0) requests,
coalesce(sum(cost), 0) cost
from agent_usage where ts >= ? group by `+groupExpr+``, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []SeriesPoint{}
	for rows.Next() {
		var p SeriesPoint
		var cost float64
		if err := rows.Scan(&p.Key, &p.Tokens, &p.Requests, &cost); err != nil {
			return nil, err
		}
		p.CostCNY = cost * defaultRateUSDCNY
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sortSeries(out, dimension)
	return out, nil
}

func sortSeries(points []SeriesPoint, dimension string) {
	if dimension == "day" {
		for i := 1; i < len(points); i++ {
			for j := i; j > 0 && points[j].Key < points[j-1].Key; j-- {
				points[j], points[j-1] = points[j-1], points[j]
			}
		}
		return
	}
	for i := 1; i < len(points); i++ {
		for j := i; j > 0 && points[j].Tokens > points[j-1].Tokens; j-- {
			points[j], points[j-1] = points[j-1], points[j]
		}
	}
}

func (s *Store) MetaSet(key, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`insert into scan_meta (key, value) values (?,?)
on conflict(key) do update set value = excluded.value`, key, value)
	return err
}

func (s *Store) MetaGet(key string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var v sql.NullString
	_ = s.db.QueryRow(`select value from scan_meta where key = ?`, key).Scan(&v)
	return v.String
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func fmtCount(n int64) string { return fmt.Sprint(n) }
