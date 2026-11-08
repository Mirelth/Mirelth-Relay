package main

import (
	"path/filepath"
	"testing"
	"time"
)

// testBase 是测试用的固定时钟，让冷却/退避断言不依赖真实时间。
var testBase = time.Date(2026, 11, 8, 12, 0, 0, 0, time.Local)

func testRouter(t *testing.T, path string) *Router {
	t.Helper()
	r := NewRouter(path)
	r.now = func() time.Time { return testBase }
	return r
}

func accountsCfg(list ...Upstream) *Config {
	cfg := defaultConfig()
	cfg.Upstreams = list
	return cfg
}

func TestClassifyStatus(t *testing.T) {
	cases := map[int]Class{
		200: ClassSuccess,
		204: ClassSuccess,
		400: ClassGiveUp,
		408: ClassRetryAccount,
		422: ClassGiveUp,
		429: ClassRetryAccount,
		401: ClassRetryAccount,
		403: ClassRetryAccount,
		404: ClassRetryAccount,
		500: ClassRetryAccount,
		503: ClassRetryAccount,
		504: ClassRetryAccount,
	}
	for status, want := range cases {
		if got := ClassifyStatus(status); got != want {
			t.Errorf("ClassifyStatus(%d) = %v, want %v", status, got, want)
		}
	}
}

func TestCandidatesOrderByWeightThenLeastRecentlyServed(t *testing.T) {
	dir := t.TempDir()
	r := testRouter(t, filepath.Join(dir, "state.json"))
	cfg := accountsCfg(
		Upstream{ID: "low", Enabled: true, Models: []string{"m"}, Weight: 1},
		Upstream{ID: "high", Enabled: true, Models: []string{"m"}, Weight: 5},
		Upstream{ID: "mid", Enabled: true, Models: []string{"m"}, Weight: 3},
	)
	got := ids(r.Candidates(cfg, "m"))
	want := []string{"high", "mid", "low"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("order = %v, want %v", got, want)
		}
	}

	// 同权重时，最近服务过的排到后面（轮转公平）。
	r.mu.Lock()
	r.stateLocked("high").LastServedAt = r.now().UnixMilli()
	r.mu.Unlock()
	cfg.Upstreams[0].Weight = 5 // low 追平 high
	got = ids(r.Candidates(cfg, "m"))
	if got[0] != "low" {
		t.Fatalf("tie-break should prefer least recently served, got %v", got)
	}
}

func TestCandidatesPutCoolingAccountsLast(t *testing.T) {
	r := testRouter(t, "")
	cfg := accountsCfg(
		Upstream{ID: "a", Enabled: true, Models: []string{"m"}, Weight: 9},
		Upstream{ID: "b", Enabled: true, Models: []string{"m"}, Weight: 1},
	)
	r.Failed("a", "m", 503, 0, "boom")

	cands := r.Candidates(cfg, "m")
	if len(cands) != 2 {
		t.Fatalf("cooling accounts must stay in the pool as best effort, got %d", len(cands))
	}
	if cands[0].Account.ID != "b" {
		t.Fatalf("cooling account must sort last, got %v", ids(cands))
	}
	if !cands[1].Cooling || cands[1].CooldownMS <= 0 {
		t.Fatalf("expected cooling metadata: %+v", cands[1])
	}
}

func TestCandidatesExcludeDisabledAndUnsupported(t *testing.T) {
	r := testRouter(t, "")
	cfg := accountsCfg(
		Upstream{ID: "off", Enabled: false, Models: []string{"m"}},
		Upstream{ID: "other-model", Enabled: true, Models: []string{"other"}},
		Upstream{ID: "no-model", Enabled: true, Models: []string{"m"}},
	)
	r.Failed("no-model", "m", 404, 0, "model not found")

	got := ids(r.Candidates(cfg, "m"))
	if len(got) != 0 {
		t.Fatalf("all candidates should be excluded, got %v", got)
	}
	// 404 只针对这个模型，其他模型照样能用。
	cfg.Upstreams[2].Models = append(cfg.Upstreams[2].Models, "n")
	if got := ids(r.Candidates(cfg, "n")); len(got) != 1 || got[0] != "no-model" {
		t.Fatalf("404 must not disable the whole account, got %v", got)
	}
}

func TestCooldownEscalatesAndCaps(t *testing.T) {
	r := testRouter(t, "")

	wants := []time.Duration{30 * time.Second, 60 * time.Second, 120 * time.Second}
	for i, want := range wants {
		got := r.Failed("a", "m", 503, 0, "boom")
		if got != want {
			t.Fatalf("failure %d cooldown = %v, want %v", i+1, got, want)
		}
	}
	// 一直失败最终顶到上限。
	for i := 0; i < 12; i++ {
		r.Failed("a", "m", 503, 0, "boom")
	}
	if got := r.Failed("a", "m", 503, 0, "boom"); got > cooldownMax {
		t.Fatalf("cooldown = %v, must be capped at %v", got, cooldownMax)
	}
	// 成功一次后连续失败归零，退避重新从 base 开始。
	r.Served("a", 200)
	if got := r.Failed("a", "m", 503, 0, "boom"); got != cooldownBase {
		t.Fatalf("cooldown after success = %v, want %v", got, cooldownBase)
	}
}

func TestRetryAfterWinsOverComputedCooldown(t *testing.T) {
	r := testRouter(t, "")
	r.Failed("a", "m", 503, 0, "boom")
	got := r.Failed("a", "m", 429, 5*time.Minute, "rate limited")
	if got != 5*time.Minute {
		t.Fatalf("cooldown = %v, want the upstream Retry-After 5m", got)
	}
	// 自算值更大时不被更小的 Retry-After 缩短。
	r.Served("a", 200)
	for i := 0; i < 4; i++ {
		r.Failed("a", "m", 503, 0, "boom")
	}
	if got := r.Failed("a", "m", 429, time.Second, "rate limited"); got < time.Minute {
		t.Fatalf("cooldown = %v, must not shrink below the computed backoff", got)
	}
}

func TestAuthFailureUsesLongCooldown(t *testing.T) {
	r := testRouter(t, "")
	cfg := accountsCfg(Upstream{ID: "a", Enabled: true, Models: []string{"m"}})
	if got := r.Failed("a", "m", 401, 0, "bad key"); got != authCooldown {
		t.Fatalf("cooldown = %v, want %v", got, authCooldown)
	}
	snap := r.Snapshot(cfg)
	if len(snap) != 1 || !snap[0].AuthFailed {
		t.Fatalf("snapshot must flag the auth failure: %+v", snap)
	}
}

func TestRouterStatePersistsAcrossRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	r := testRouter(t, path)
	cfg := accountsCfg(Upstream{ID: "a", Enabled: true, Models: []string{"m"}})
	r.Failed("a", "m", 401, 0, "bad key")
	r.Served("b", 200)

	reloaded := NewRouter(path)
	reloaded.now = func() time.Time { return testBase }
	if got := reloaded.FailDelay("a"); got <= 0 {
		t.Fatalf("cooldown must survive restart, got %v", got)
	}
	if len(reloaded.Snapshot(cfg)) != 1 || !reloaded.Snapshot(cfg)[0].AuthFailed {
		t.Fatal("auth failure flag must survive restart")
	}
}

func TestRouterPrunesRemovedAccounts(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	r := testRouter(t, path)
	r.Failed("gone", "m", 503, 0, "boom")
	r.Save(accountsCfg(Upstream{ID: "kept", Enabled: true, Models: []string{"m"}}))

	reloaded := NewRouter(path)
	if got := reloaded.FailDelay("gone"); got != 0 {
		t.Fatalf("removed account state must be pruned, got %v", got)
	}
}

func TestTryAcquireRespectsConcurrencyLimit(t *testing.T) {
	r := testRouter(t, "")
	if !r.TryAcquire("a", 1) {
		t.Fatal("first acquire should succeed")
	}
	if r.TryAcquire("a", 1) {
		t.Fatal("second acquire must be refused at the limit")
	}
	r.Release("a")
	if !r.TryAcquire("a", 1) {
		t.Fatal("acquire after release should succeed")
	}
	if !r.TryAcquire("b", 0) {
		t.Fatal("limit 0 means unlimited")
	}
}

func ids(cands []Candidate) []string {
	out := make([]string, 0, len(cands))
	for _, c := range cands {
		out = append(out, c.Account.ID)
	}
	return out
}
