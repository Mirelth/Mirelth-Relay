package main

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

type UsageRow struct {
	RequestID    string  `json:"requestId"`
	TS           int64   `json:"ts"`
	Model        string  `json:"model"`
	Source       string  `json:"source"`
	InputTokens  int64   `json:"inputTokens"`
	OutputTokens int64   `json:"outputTokens"`
	CacheRead    int64   `json:"cacheRead"`
	CacheWrite   int64   `json:"cacheWrite"`
	Reasoning    int64   `json:"reasoning"`
	Requests     int64   `json:"requests"`
	CostUSD      float64 `json:"costUsd"`
	Estimated    bool    `json:"estimated"`
	Status       string  `json:"status"`
	LatencyMS    int64   `json:"latencyMs"`
}

func (u UsageRow) Total() int64 {
	return u.InputTokens + u.OutputTokens + u.CacheRead + u.CacheWrite + u.Reasoning
}

type Store struct {
	db        *sql.DB
	mu        sync.Mutex
	lastPrune time.Time
}

func openStore() (*Store, error) {
	return openStoreAt(filepath.Join(configDir(), "relay.db"))
}

func openStoreAt(dbPath string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(dbPath), 0700); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, err
	}
	if _, err = db.Exec(`pragma journal_mode = WAL;
create table if not exists gw_usage (
  request_id text primary key,
  ts integer not null,
  model text,
  source text,
  input_tokens integer default 0,
  output_tokens integer default 0,
  cache_read integer default 0,
  cache_write integer default 0,
  reasoning integer default 0,
  requests integer default 1,
  cost_usd real default 0,
  estimated integer default 0,
  status text,
  latency_ms integer default 0
);
create index if not exists idx_gw_usage_ts on gw_usage(ts);
create index if not exists idx_gw_usage_model on gw_usage(model);
create table if not exists gw_request (
  id text primary key,
  ts integer not null,
  endpoint text,
  agent text,
  model text,
  status integer default 0,
  ms integer default 0,
  tries integer default 0,
  ttft_ms integer default 0,
  first_byte_ms integer default 0,
  flow_ms integer default 0,
  input_tokens integer default 0,
  output_tokens integer default 0,
  cache_read integer default 0,
  cache_write integer default 0,
  reasoning integer default 0,
  up_bytes integer default 0,
  error text
);
create index if not exists idx_gw_request_ts on gw_request(ts);
create table if not exists gw_attempt (
  req_id text not null,
  idx integer not null,
  ts integer not null,
  account text,
  model text,
  status integer default 0,
  ms integer default 0,
  ttft_ms integer default 0,
  err text,
  retry_after_ms integer default 0,
  cooldown_ms integer default 0,
  skipped integer default 0,
  primary key (req_id, idx)
);
create index if not exists idx_gw_attempt_ts on gw_attempt(ts);`); err != nil {
		db.Close()
		return nil, err
	}
	if err := createScanSchema(db); err != nil {
		db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

func (s *Store) Insert(u UsageRow) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`insert or ignore into gw_usage
(request_id, ts, model, source, input_tokens, output_tokens, cache_read, cache_write, reasoning, requests, cost_usd, estimated, status, latency_ms)
values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		u.RequestID, u.TS, u.Model, u.Source, u.InputTokens, u.OutputTokens,
		u.CacheRead, u.CacheWrite, u.Reasoning, u.Requests, u.CostUSD,
		boolInt(u.Estimated), u.Status, u.LatencyMS)
	return err
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func (s *Store) Recent(limit int) ([]UsageRow, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	return s.query(`select request_id, ts, model, source, input_tokens, output_tokens,
cache_read, cache_write, reasoning, requests, cost_usd, estimated, status, latency_ms
from gw_usage order by ts desc limit ?`, limit)
}

func (s *Store) RowsSince(since int64) ([]UsageRow, error) {
	return s.query(`select request_id, ts, model, source, input_tokens, output_tokens,
cache_read, cache_write, reasoning, requests, cost_usd, estimated, status, latency_ms
from gw_usage where ts >= ? order by ts desc`, since)
}

func (s *Store) query(sqlText string, args ...any) ([]UsageRow, error) {
	rows, err := s.db.Query(sqlText, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []UsageRow{}
	for rows.Next() {
		var u UsageRow
		var est int
		if err := rows.Scan(&u.RequestID, &u.TS, &u.Model, &u.Source, &u.InputTokens,
			&u.OutputTokens, &u.CacheRead, &u.CacheWrite, &u.Reasoning, &u.Requests,
			&u.CostUSD, &est, &u.Status, &u.LatencyMS); err != nil {
			return nil, err
		}
		u.Estimated = est == 1
		out = append(out, u)
	}
	return out, rows.Err()
}

func (s *Store) Close() error { return s.db.Close() }

// ---------- 请求轨迹 ----------

// InsertTrace 写入一条请求轨迹与它的全部尝试（同一事务，避免只写了半边）。
func (s *Store) InsertTrace(t TraceRequest) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`insert or replace into gw_request
(id, ts, endpoint, agent, model, status, ms, tries, ttft_ms, first_byte_ms, flow_ms,
 input_tokens, output_tokens, cache_read, cache_write, reasoning, up_bytes, error)
values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		t.ID, t.TS, t.Endpoint, t.Agent, t.Model, t.Status, t.MS, t.Tries, t.TTFTMS,
		t.FirstByteMS, t.FlowMS, t.InputTokens, t.OutputTokens, t.CacheRead, t.CacheWrite,
		t.Reasoning, t.UpBytes, t.Error); err != nil {
		return err
	}
	for _, a := range t.Attempts {
		if _, err := tx.Exec(`insert or replace into gw_attempt
(req_id, idx, ts, account, model, status, ms, ttft_ms, err, retry_after_ms, cooldown_ms, skipped)
values (?,?,?,?,?,?,?,?,?,?,?,?)`,
			t.ID, a.Index, t.TS, a.Account, a.Model, a.Status, a.MS, a.TTFTMS,
			a.Error, a.RetryAfterMS, a.CooldownMS, boolInt(a.Skipped)); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	// 最多每 30 分钟裁一次，保留近 7 天。
	if time.Since(s.lastPrune) > 30*time.Minute {
		s.lastPrune = time.Now()
		_ = s.pruneLocked(time.Now().Add(-traceRetention).UnixMilli())
	}
	return nil
}

// RecentTraces 返回最近的请求轨迹（含各自尝试），供观测页直接渲染。
func (s *Store) RecentTraces(limit int) ([]TraceRequest, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.Query(`select id, ts, endpoint, agent, model, status, ms, tries, ttft_ms,
first_byte_ms, flow_ms, input_tokens, output_tokens, cache_read, cache_write, reasoning, up_bytes, error
from gw_request order by ts desc limit ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TraceRequest{}
	for rows.Next() {
		var t TraceRequest
		if err := rows.Scan(&t.ID, &t.TS, &t.Endpoint, &t.Agent, &t.Model, &t.Status, &t.MS, &t.Tries,
			&t.TTFTMS, &t.FirstByteMS, &t.FlowMS, &t.InputTokens, &t.OutputTokens, &t.CacheRead,
			&t.CacheWrite, &t.Reasoning, &t.UpBytes, &t.Error); err != nil {
			return nil, err
		}
		t.Attempts = []Attempt{}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	byID := make(map[string]*TraceRequest, len(out))
	ids := make([]any, 0, len(out))
	for i := range out {
		byID[out[i].ID] = &out[i]
		ids = append(ids, out[i].ID)
	}
	if len(ids) == 0 {
		return out, nil
	}
	q := `select req_id, idx, account, model, status, ms, ttft_ms, err, retry_after_ms, cooldown_ms, skipped
from gw_attempt where req_id in (?` + strings.Repeat(",?", len(ids)-1) + `) order by req_id, idx`
	arows, err := s.db.Query(q, ids...)
	if err != nil {
		return nil, err
	}
	defer arows.Close()
	for arows.Next() {
		var (
			reqID string
			a     Attempt
			skip  int
		)
		if err := arows.Scan(&reqID, &a.Index, &a.Account, &a.Model, &a.Status, &a.MS, &a.TTFTMS,
			&a.Error, &a.RetryAfterMS, &a.CooldownMS, &skip); err != nil {
			return nil, err
		}
		a.Skipped = skip == 1
		if t := byID[reqID]; t != nil {
			t.Attempts = append(t.Attempts, a)
		}
	}
	return out, arows.Err()
}

// TraceStats 汇总一个时间窗口内的观测指标。
func (s *Store) TraceStats(since int64) (TraceStats, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	row := s.db.QueryRow(`select count(*),
coalesce(sum(case when status = 0 or status >= 400 then 1 else 0 end), 0),
coalesce(sum(case when tries > 1 then 1 else 0 end), 0),
coalesce(avg(case when ttft_ms > 0 then ttft_ms end), 0),
coalesce(avg(ms), 0)
from gw_request where ts >= ?`, since)
	var st TraceStats
	if err := row.Scan(&st.Requests, &st.Failures, &st.Retried, &st.AvgTTFTMS, &st.AvgMS); err != nil {
		return st, err
	}
	return st, nil
}

// AccountAttemptStat 是账号面板上的一小时成败计数。
func (s *Store) AccountAttemptStats(since int64) (map[string]AccountAttemptStat, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.Query(`select account,
coalesce(sum(case when status >= 200 and status < 300 then 1 else 0 end), 0),
coalesce(sum(case when status = 0 or status >= 400 then 1 else 0 end), 0)
from gw_attempt where ts >= ? and skipped = 0 and account != '' group by account`, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]AccountAttemptStat{}
	for rows.Next() {
		var (
			id string
			st AccountAttemptStat
		)
		if err := rows.Scan(&id, &st.OK, &st.Fail); err != nil {
			return nil, err
		}
		out[id] = st
	}
	return out, rows.Err()
}

// PruneTraces 删除早于 before 的轨迹，避免库无限增长。
func (s *Store) PruneTraces(before int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.pruneLocked(before)
}

func (s *Store) pruneLocked(before int64) error {
	if _, err := s.db.Exec(`delete from gw_attempt where ts < ?`, before); err != nil {
		return err
	}
	_, err := s.db.Exec(`delete from gw_request where ts < ?`, before)
	return err
}
