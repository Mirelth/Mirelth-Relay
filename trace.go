package main

import (
	"io"
	"net/http"
	"strings"
	"time"
)

// 轨迹保留窗口：够排查近一周，也不至于让 relay.db 无限增长。
const traceRetention = 7 * 24 * time.Hour

// TraceRequest 是一条被观测的网关请求：一次请求可能在多个账号上尝试过。
type TraceRequest struct {
	ID           string    `json:"id"`
	TS           int64     `json:"ts"`
	Endpoint     string    `json:"endpoint"`
	Agent        string    `json:"agent"`
	Model        string    `json:"model"`
	Status       int       `json:"status"`
	MS           int64     `json:"ms"`
	Tries        int       `json:"tries"`
	TTFTMS       int64     `json:"ttftMs"`
	FirstByteMS  int64     `json:"firstByteMs"`
	FlowMS       int64     `json:"flowMs"`
	InputTokens  int64     `json:"inputTokens"`
	OutputTokens int64     `json:"outputTokens"`
	CacheRead    int64     `json:"cacheRead"`
	CacheWrite   int64     `json:"cacheWrite"`
	Reasoning    int64     `json:"reasoning"`
	UpBytes      int64     `json:"upBytes"`
	Error        string    `json:"error,omitempty"`
	Attempts     []Attempt `json:"attempts"`
}

// TraceStats 是观测页顶部的窗口指标。
type TraceStats struct {
	Requests  int64   `json:"requests"`
	Failures  int64   `json:"failures"`
	Retried   int64   `json:"retried"`
	AvgTTFTMS float64 `json:"avgTtftMs"`
	AvgMS     float64 `json:"avgMs"`
}

// AccountAttemptStat 是账号面板用的一小时成败计数。
type AccountAttemptStat struct {
	OK   int64 `json:"ok"`
	Fail int64 `json:"fail"`
}

// countingReader 统计上游实际回传的字节数（面板与排障都要看响应体积）。
type countingReader struct {
	r io.Reader
	n int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}

// agentOf 归类调用方：优先显式头，其次来源头，最后退回 User-Agent 的产品名。
func agentOf(r *http.Request) string {
	for _, h := range []string{"X-Relay-Agent", "X-Relay-Source"} {
		if v := strings.TrimSpace(r.Header.Get(h)); v != "" {
			return clip(v, 32)
		}
	}
	ua := strings.TrimSpace(r.Header.Get("User-Agent"))
	if ua == "" {
		return "http"
	}
	if i := strings.IndexAny(ua, "/ "); i > 0 {
		ua = ua[:i]
	}
	return clip(ua, 32)
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// saveTrace 落盘一条轨迹；失败不影响请求，只记在用量账本之外。
func (g *Gateway) saveTrace(t TraceRequest) {
	if g.store == nil {
		return
	}
	if t.Attempts == nil {
		t.Attempts = []Attempt{}
	}
	_ = g.store.InsertTrace(t)
}
