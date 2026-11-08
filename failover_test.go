package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// failoverGateway 用给定账号搭一个真网关，账号顺序即 ID 字典序（同权重同服务时间时的兜底顺序）。
func failoverGateway(t *testing.T, accounts ...Upstream) (*Gateway, *Store, *Config, *Router) {
	t.Helper()
	cfg := defaultConfig()
	cfg.Upstreams = accounts
	st, err := openStoreAt(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	router := NewRouter(filepath.Join(t.TempDir(), "state.json"))
	return newGateway(func() *Config { return cfg }, st, router), st, cfg, router
}

// jsonUpstream 返回固定状态码与 body 的假上游，并统计命中次数。
func jsonUpstream(t *testing.T, status int, body string, hits *int) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hits != nil {
			*hits++
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = fmt.Fprint(w, body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func account(id, url string) Upstream {
	return Upstream{ID: id, Name: id, BaseURL: url, Model: "m", Models: []string{"m"}, Enabled: true}
}

const okChatBody = `{"model":"m","choices":[{"message":{"content":"hello"}}],"usage":{"prompt_tokens":5,"completion_tokens":2}}`

func TestFailoverMovesToNextAccountOnRetryableStatus(t *testing.T) {
	aHits, bHits := 0, 0
	a := jsonUpstream(t, http.StatusServiceUnavailable, `{"error":"overloaded"}`, &aHits)
	b := jsonUpstream(t, http.StatusOK, okChatBody, &bHits)

	g, st, cfg, router := failoverGateway(t, account("a", a.URL), account("b", b.URL))
	rec := httptest.NewRecorder()
	g.ServeHTTP(rec, chatRequest(cfg, `{"model":"m","messages":[]}`))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "hello") {
		t.Fatalf("body should come from the second account: %s", rec.Body.String())
	}
	if aHits != 1 || bHits != 1 {
		t.Fatalf("hits a=%d b=%d", aHits, bHits)
	}
	if got := rec.Header().Get("X-Relay-Account"); got != "b" {
		t.Fatalf("X-Relay-Account = %q, want b", got)
	}
	if got := rec.Header().Get("X-Relay-Attempts"); got != "2" {
		t.Fatalf("X-Relay-Attempts = %q, want 2", got)
	}
	if router.FailDelay("a") <= 0 {
		t.Fatal("failed account must enter cooldown")
	}
	rows, _ := st.Recent(10)
	if len(rows) != 1 || rows[0].Model != "m" || rows[0].InputTokens != 5 {
		t.Fatalf("usage must be recorded from the account that served: %+v", rows)
	}
}

func TestFailoverHonorsRetryAfter(t *testing.T) {
	a := jsonUpstream(t, http.StatusTooManyRequests, `{"error":"rate limited"}`, nil)
	b := jsonUpstream(t, http.StatusOK, okChatBody, nil)
	g, _, cfg, router := failoverGateway(t, account("a", a.URL), account("b", b.URL))

	// Retry-After 是 3 秒，比 base 30 秒小，所以冷却应取更长的自算值。
	rec := httptest.NewRecorder()
	req := chatRequest(cfg, `{"model":"m","messages":[]}`)
	g.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if got := router.FailDelay("a"); got < cooldownBase-time.Second {
		t.Fatalf("cooldown = %v, want at least %v", got, cooldownBase)
	}

}

// Retry-After 比自算退避更大时必须服从上游，否则限流账号会被过早重打。
func TestRetryAfterLargerThanBackoffWins(t *testing.T) {
	limited := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "120")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = fmt.Fprint(w, `{"error":"rate limited"}`)
	}))
	t.Cleanup(limited.Close)
	live := jsonUpstream(t, http.StatusOK, okChatBody, nil)

	g, _, cfg, router := failoverGateway(t, account("a", limited.URL), account("b", live.URL))
	rec := httptest.NewRecorder()
	g.ServeHTTP(rec, chatRequest(cfg, `{"model":"m","messages":[]}`))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if got := router.FailDelay("a"); got < 100*time.Second {
		t.Fatalf("cooldown = %v, want the Retry-After 120s to win", got)
	}
}

func TestClientErrorsAreNotRetried(t *testing.T) {
	aHits, bHits := 0, 0
	a := jsonUpstream(t, http.StatusBadRequest, `{"error":"bad request from sender"}`, &aHits)
	b := jsonUpstream(t, http.StatusOK, okChatBody, &bHits)
	g, _, cfg, _ := failoverGateway(t, account("a", a.URL), account("b", b.URL))

	rec := httptest.NewRecorder()
	g.ServeHTTP(rec, chatRequest(cfg, `{"model":"m","messages":[]}`))

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 passing the upstream error through", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "bad request from sender") {
		t.Fatalf("upstream error body must be preserved: %s", rec.Body.String())
	}
	if bHits != 0 {
		t.Fatal("a client error must not be retried on another account")
	}
}

func TestAllAccountsFailingReturnsAggregatedError(t *testing.T) {
	a := jsonUpstream(t, http.StatusServiceUnavailable, `{}`, nil)
	b := jsonUpstream(t, http.StatusInternalServerError, `{}`, nil)
	g, _, cfg, _ := failoverGateway(t, account("a", a.URL), account("b", b.URL))

	rec := httptest.NewRecorder()
	g.ServeHTTP(rec, chatRequest(cfg, `{"model":"m","messages":[]}`))

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
	var out struct {
		Error struct{ Message string } `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("bad json: %s", rec.Body.String())
	}
	if !strings.Contains(out.Error.Message, "a: HTTP 503") || !strings.Contains(out.Error.Message, "b: HTTP 500") {
		t.Fatalf("aggregated message should name every account: %q", out.Error.Message)
	}
}

func TestStreamingFailoverWritesNothingBeforeCommit(t *testing.T) {
	a := jsonUpstream(t, http.StatusServiceUnavailable, `{"error":"overloaded"}`, nil)
	b := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n")
		_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	t.Cleanup(b.Close)

	g, _, cfg, _ := failoverGateway(t, account("a", a.URL), account("b", b.URL))
	rec := httptest.NewRecorder()
	g.ServeHTTP(rec, chatRequest(cfg, `{"model":"m","stream":true,"messages":[]}`))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	body := rec.Body.String()
	if strings.Contains(body, "overloaded") {
		t.Fatalf("failed attempt must not leak into the stream: %s", body)
	}
	if !strings.Contains(body, "hi") || !strings.Contains(body, "[DONE]") {
		t.Fatalf("stream should come from the second account: %s", body)
	}
	if got := rec.Header().Get("X-Relay-Attempts"); got != "2" {
		t.Fatalf("X-Relay-Attempts = %q, want 2", got)
	}
}

func TestUnreachableUpstreamFailsOver(t *testing.T) {
	dead := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	deadURL := dead.URL
	dead.Close() // 端口关闭 → 连接被拒，属于网络层失败
	live := jsonUpstream(t, http.StatusOK, okChatBody, nil)

	g, _, cfg, router := failoverGateway(t, account("a", deadURL), account("b", live.URL))
	rec := httptest.NewRecorder()
	g.ServeHTTP(rec, chatRequest(cfg, `{"model":"m","messages":[]}`))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if router.FailDelay("a") <= 0 {
		t.Fatal("network failure must put the account into cooldown")
	}
}

func TestAuthFailureCoolsAccountAndSkipsItNextTime(t *testing.T) {
	aHits, bHits := 0, 0
	a := jsonUpstream(t, http.StatusUnauthorized, `{"error":"bad key"}`, &aHits)
	b := jsonUpstream(t, http.StatusOK, okChatBody, &bHits)
	g, _, cfg, router := failoverGateway(t, account("a", a.URL), account("b", b.URL))

	first := httptest.NewRecorder()
	g.ServeHTTP(first, chatRequest(cfg, `{"model":"m","messages":[]}`))
	if first.Code != http.StatusOK || aHits != 1 || bHits != 1 {
		t.Fatalf("first request: status=%d a=%d b=%d", first.Code, aHits, bHits)
	}
	if got, want := router.FailDelay("a"), authCooldown; got < want-time.Second {
		t.Fatalf("auth cooldown = %v, want ~%v", got, want)
	}

	second := httptest.NewRecorder()
	g.ServeHTTP(second, chatRequest(cfg, `{"model":"m","messages":[]}`))
	if aHits != 1 {
		t.Fatalf("cooling account must not be retried first, a hits = %d", aHits)
	}
	if got := second.Header().Get("X-Relay-Attempts"); got != "1" {
		t.Fatalf("second request attempts = %q, want 1", got)
	}
}

func TestNoUpstreamForModel(t *testing.T) {
	a := jsonUpstream(t, http.StatusOK, okChatBody, nil)
	g, _, cfg, _ := failoverGateway(t, account("a", a.URL))

	rec := httptest.NewRecorder()
	g.ServeHTTP(rec, chatRequest(cfg, `{"model":"unknown-model","messages":[]}`))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "no enabled upstream for model unknown-model") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestParseRetryAfter(t *testing.T) {
	if got := parseRetryAfter("7"); got != 7*time.Second {
		t.Fatalf("seconds form = %v", got)
	}
	if got := parseRetryAfter(""); got != 0 {
		t.Fatalf("empty = %v", got)
	}
	if got := parseRetryAfter("0"); got != 0 {
		t.Fatalf("zero = %v", got)
	}
	if got := parseRetryAfter("not-a-number"); got != 0 {
		t.Fatalf("garbage = %v", got)
	}
	future := time.Now().Add(90 * time.Second).UTC().Format(http.TimeFormat)
	if got := parseRetryAfter(future); got < 80*time.Second {
		t.Fatalf("http-date form = %v", got)
	}
	if got := parseRetryAfter("999999"); got != retryAfterCap {
		t.Fatalf("absurd Retry-After must be capped, got %v", got)
	}
}

// 本地故障演练：真监听端口 + 真 HTTP 客户端，第一个账号 503/429、第二个账号正常。
// 等价于「把网关跑起来敲一次」，只是全程自动化。
func TestGatewayDrillOnRealPort(t *testing.T) {
	a := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "30")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = fmt.Fprint(w, `{"error":"rate limited"}`)
	}))
	t.Cleanup(a.Close)
	b := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"drill\"}}]}\n\n")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":2}}\n\n")
		_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	t.Cleanup(b.Close)

	g, st, cfg, router := failoverGateway(t, account("a", a.URL), account("b", b.URL))
	cfg.Port = 18791
	if err := g.Start(); err != nil {
		t.Fatalf("start gateway: %v", err)
	}
	t.Cleanup(g.Stop)
	addr := g.Addr()
	if addr == "" {
		t.Fatal("gateway did not report an address")
	}

	body := strings.NewReader(`{"model":"m","stream":true,"messages":[{"role":"user","content":"hi"}]}`)
	req, err := http.NewRequest(http.MethodPost, addr+"/chat/completions", body)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Relay-Agent", "drill")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("drill request: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	payload, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d body = %s", resp.StatusCode, payload)
	}
	if !strings.Contains(string(payload), "drill") || strings.Contains(string(payload), "rate limited") {
		t.Fatalf("stream must come only from the healthy account: %s", payload)
	}
	if got := resp.Header.Get("X-Relay-Account"); got != "b" {
		t.Fatalf("X-Relay-Account = %q", got)
	}
	if got := resp.Header.Get("X-Relay-Attempts"); got != "2" {
		t.Fatalf("X-Relay-Attempts = %q", got)
	}
	if got := router.FailDelay("a"); got < 25*time.Second {
		t.Fatalf("throttled account cooldown = %v", got)
	}

	// 第二次请求应该只打 b：冷却中的账号排在最后。
	traces, _ := st.RecentTraces(5)
	if len(traces) != 1 || traces[0].Agent != "drill" || len(traces[0].Attempts) != 2 {
		t.Fatalf("drill must leave one trace with two attempts: %+v", traces)
	}
}
