package main

import (
	"math"
	"strings"
	"testing"
	"time"
)

func TestUsageFromResponse(t *testing.T) {
	cfg := defaultConfig()
	resp := []byte(`{"model":"qwen3.8-max","usage":{"prompt_tokens":120,"completion_tokens":30,` +
		`"prompt_tokens_details":{"cached_tokens":40},"completion_tokens_details":{"reasoning_tokens":5}}}`)
	row := usageFromResponse("req-1", time.Now(), "qwen3.8-max", "http",
		map[string]any{"model": "qwen3.8-max"}, resp, cfg)

	if row.Model != "qwen3.8-max" || row.InputTokens != 120 || row.OutputTokens != 30 ||
		row.CacheRead != 40 || row.Reasoning != 5 {
		t.Fatalf("unexpected usage row: %+v", row)
	}
	if row.Estimated {
		t.Fatal("usage returned by upstream must not be marked as estimated")
	}
	if row.Total() != 195 {
		t.Fatalf("total tokens = %d, want 195", row.Total())
	}
}

func TestUsageFallbackIsMarkedEstimated(t *testing.T) {
	cfg := defaultConfig()
	resp := []byte(`{"choices":[{"message":{"content":"hello"}}]}`)
	payload := map[string]any{"messages": []any{map[string]any{"content": "hi there"}}}
	row := usageFromResponse("req-2", time.Now(), "unknown-model", "http", payload, resp, cfg)

	if !row.Estimated {
		t.Fatal("missing upstream usage must be marked as estimated")
	}
	if row.InputTokens <= 0 {
		t.Fatal("estimated input tokens should be positive")
	}
}

func TestCostUSD(t *testing.T) {
	cfg := defaultConfig()
	got := costUSD(cfg, "gpt-4o-mini", 1_000_000, 0, 0, 0)
	if math.Abs(got-0.15) > 1e-9 {
		t.Fatalf("cost = %f, want 0.15", got)
	}
	if costUSD(cfg, "no-such-model", 1_000_000, 0, 0, 0) != 0 {
		t.Fatal("unpriced model should return zero cost")
	}
}

func TestMaskKey(t *testing.T) {
	masked := maskKey("atgw-abcdefgh12345678")
	if !strings.Contains(masked, "****") || strings.Contains(masked, "12345678") {
		t.Fatalf("key not masked properly: %s", masked)
	}
}

func TestUpstreamSelection(t *testing.T) {
	cfg := defaultConfig()
	cfg.Upstreams = []Upstream{
		{ID: "a", Model: "gpt-4o", Enabled: false},
		{ID: "b", Model: "deepseek-chat", Enabled: true},
	}
	if u := cfg.upstreamByModel("deepseek-chat"); u == nil || u.ID != "b" {
		t.Fatal("should select enabled upstream by model")
	}
	if u := cfg.upstreamByModel("gpt-4o"); u != nil {
		t.Fatal("disabled upstream must not be selected")
	}
}
