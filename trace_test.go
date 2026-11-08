package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"
)

func testStore(t *testing.T) *Store {
	t.Helper()
	st, err := openStoreAt(filepath.Join(t.TempDir(), "trace.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

func TestTraceRoundTripKeepsAttemptsInOrder(t *testing.T) {
	st := testStore(t)
	ts := time.Now().UnixMilli()
	trace := TraceRequest{
		ID: "req-1", TS: ts, Endpoint: "/v1/chat/completions", Agent: "claude",
		Model: "m", Status: 200, MS: 1200, Tries: 2, TTFTMS: 300, FirstByteMS: 200,
		FlowMS: 1000, InputTokens: 10, OutputTokens: 20, CacheRead: 3, CacheWrite: 4,
		Reasoning: 5, UpBytes: 4096,
		Attempts: []Attempt{
			{Index: 1, Account: "a", AccountName: "a", Model: "m", Status: 503, MS: 120,
				Error: "Service Unavailable", CooldownMS: 30000},
			{Index: 2, Account: "b", AccountName: "b", Model: "m", Status: 200, MS: 200, TTFTMS: 300},
		},
	}
	if err := st.InsertTrace(trace); err != nil {
		t.Fatal(err)
	}

	got, err := st.RecentTraces(10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("traces = %d", len(got))
	}
	r := got[0]
	if r.ID != "req-1" || r.Tries != 2 || r.TTFTMS != 300 || r.UpBytes != 4096 || r.Agent != "claude" {
		t.Fatalf("trace round trip lost fields: %+v", r)
	}
	if len(r.Attempts) != 2 {
		t.Fatalf("attempts = %d", len(r.Attempts))
	}
	if r.Attempts[0].Account != "a" || r.Attempts[0].Status != 503 || r.Attempts[0].CooldownMS != 30000 {
		t.Fatalf("first attempt = %+v", r.Attempts[0])
	}
	if r.Attempts[1].Account != "b" || r.Attempts[1].Status != 200 {
		t.Fatalf("attempts must come back in try order: %+v", r.Attempts)
	}
}

func TestTraceStatsCountsFailuresAndRetries(t *testing.T) {
	st := testStore(t)
	now := time.Now().UnixMilli()
	rows := []TraceRequest{
		{ID: "1", TS: now, Status: 200, MS: 100, Tries: 1, TTFTMS: 40},
		{ID: "2", TS: now, Status: 200, MS: 200, Tries: 2, TTFTMS: 60},
		{ID: "3", TS: now, Status: 503, MS: 300, Tries: 2},
		{ID: "4", TS: now - 10*24*3600*1000, Status: 500, MS: 900, Tries: 1}, // 窗口外
	}
	for _, r := range rows {
		if err := st.InsertTrace(r); err != nil {
			t.Fatal(err)
		}
	}
	stats, err := st.TraceStats(time.Now().Add(-time.Hour).UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	if stats.Requests != 3 || stats.Failures != 1 || stats.Retried != 2 {
		t.Fatalf("stats = %+v", stats)
	}
	if stats.AvgTTFTMS < 45 || stats.AvgTTFTMS > 55 {
		t.Fatalf("avg ttft = %v, want ~50", stats.AvgTTFTMS)
	}
	if stats.AvgMS < 190 || stats.AvgMS > 210 {
		t.Fatalf("avg ms = %v, want ~200", stats.AvgMS)
	}
}

func TestAccountAttemptStatsAndPrune(t *testing.T) {
	st := testStore(t)
	now := time.Now().UnixMilli()
	trace := TraceRequest{ID: "req", TS: now, Status: 200, Attempts: []Attempt{
		{Index: 1, Account: "a", Status: 503},
		{Index: 2, Account: "b", Status: 200},
		{Index: 3, Account: "c", Status: 0, Skipped: true},
	}}
	if err := st.InsertTrace(trace); err != nil {
		t.Fatal(err)
	}
	stats, err := st.AccountAttemptStats(now - 3600*1000)
	if err != nil {
		t.Fatal(err)
	}
	if stats["a"].Fail != 1 || stats["a"].OK != 0 {
		t.Fatalf("account a = %+v", stats["a"])
	}
	if stats["b"].OK != 1 {
		t.Fatalf("account b = %+v", stats["b"])
	}
	if _, ok := stats["c"]; ok {
		t.Fatal("skipped attempts must not be counted as account failures")
	}

	if err := st.PruneTraces(now + 1); err != nil {
		t.Fatal(err)
	}
	left, _ := st.RecentTraces(10)
	if len(left) != 0 {
		t.Fatalf("prune left %d traces", len(left))
	}
	rows, _ := st.AccountAttemptStats(0)
	if len(rows) != 0 {
		t.Fatalf("prune must clear attempts too: %v", rows)
	}
}

// 端到端：一次经历 failover 的请求必须留下 2 次尝试，并被统计成「发生过重试」。
func TestGatewayRecordsTraceForFailover(t *testing.T) {
	a := jsonUpstream(t, http.StatusServiceUnavailable, `{}`, nil)
	// 首个增量前故意停一下，好让 TTFT 有可断言的量级。
	b := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		time.Sleep(10 * time.Millisecond)
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":1}}\n\n")
		_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	t.Cleanup(b.Close)
	g, st, cfg, _ := failoverGateway(t, account("a", a.URL), account("b", b.URL))

	rec := httptest.NewRecorder()
	req := chatRequest(cfg, `{"model":"m","stream":true,"messages":[]}`)
	req.Header.Set("X-Relay-Agent", "claude")
	g.ServeHTTP(rec, req)

	traces, err := st.RecentTraces(10)
	if err != nil {
		t.Fatal(err)
	}
	if len(traces) != 1 {
		t.Fatalf("traces = %d", len(traces))
	}
	tr := traces[0]
	if tr.Agent != "claude" || tr.Endpoint != "/v1/chat/completions" || tr.Tries != 2 {
		t.Fatalf("trace = %+v", tr)
	}
	if len(tr.Attempts) != 2 || tr.Attempts[0].Account != "a" || tr.Attempts[0].Status != 503 {
		t.Fatalf("first attempt should be the failed one: %+v", tr.Attempts)
	}
	if tr.Attempts[1].Account != "b" || tr.Attempts[1].Status != 200 {
		t.Fatalf("second attempt = %+v", tr.Attempts[1])
	}
	if tr.Attempts[1].TTFTMS < 5 {
		t.Fatalf("second attempt should carry TTFT, got %d", tr.Attempts[1].TTFTMS)
	}
	if tr.TTFTMS < 5 || tr.InputTokens != 3 || tr.OutputTokens != 1 {
		t.Fatalf("trace should carry TTFT and usage: %+v", tr)
	}
	if tr.Status != 200 || tr.UpBytes == 0 {
		t.Fatalf("trace = %+v", tr)
	}

	stats, err := st.TraceStats(time.Now().Add(-time.Hour).UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	if stats.Requests != 1 || stats.Retried != 1 || stats.Failures != 0 {
		t.Fatalf("stats = %+v", stats)
	}
}

func TestGatewayRecordsTraceForFailure(t *testing.T) {
	a := jsonUpstream(t, http.StatusServiceUnavailable, `{}`, nil)
	b := jsonUpstream(t, http.StatusInternalServerError, `{}`, nil)
	g, st, cfg, _ := failoverGateway(t, account("a", a.URL), account("b", b.URL))

	rec := httptest.NewRecorder()
	g.ServeHTTP(rec, chatRequest(cfg, `{"model":"m","messages":[]}`))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d", rec.Code)
	}
	traces, _ := st.RecentTraces(10)
	if len(traces) != 1 {
		t.Fatalf("traces = %d", len(traces))
	}
	tr := traces[0]
	if tr.Status != 503 || tr.Error == "" || len(tr.Attempts) != 2 {
		t.Fatalf("failed request must keep every attempt: %+v", tr)
	}
}
