package main

import (
	"encoding/json"
	"testing"
	"time"
)

func TestToAnthropicRequest(t *testing.T) {
	payload := map[string]any{
		"model":      "claude-sonnet-4",
		"max_tokens": float64(1024),
		"messages": []any{
			map[string]any{"role": "system", "content": "You are helpful"},
			map[string]any{"role": "user", "content": "hello"},
		},
	}
	var out map[string]any
	if err := json.Unmarshal(toAnthropicRequest(payload, true), &out); err != nil {
		t.Fatal(err)
	}
	if out["system"] != "You are helpful" {
		t.Fatalf("system = %v", out["system"])
	}
	if out["max_tokens"] != float64(1024) || out["stream"] != true {
		t.Fatalf("unexpected request: %+v", out)
	}
	msgs, _ := out["messages"].([]any)
	if len(msgs) != 1 {
		t.Fatalf("system message should be extracted, got %d messages", len(msgs))
	}
}

func TestFromAnthropic(t *testing.T) {
	in := []byte(`{"id":"msg_1","model":"claude-sonnet-4","content":[{"type":"text","text":"Hi"}],` +
		`"stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":4}}`)
	var out map[string]any
	if err := json.Unmarshal(fromAnthropic(in, "fallback"), &out); err != nil {
		t.Fatal(err)
	}
	choices, _ := out["choices"].([]any)
	if len(choices) != 1 {
		t.Fatal("should contain one choice")
	}
	msg := choices[0].(map[string]any)["message"].(map[string]any)
	if msg["content"] != "Hi" {
		t.Fatalf("content = %v", msg["content"])
	}
	usage := out["usage"].(map[string]any)
	if usage["prompt_tokens"] != float64(10) || usage["completion_tokens"] != float64(4) {
		t.Fatalf("usage = %+v", usage)
	}
}

func TestUsageFromAnthropic(t *testing.T) {
	in := []byte(`{"model":"claude-sonnet-4","usage":{"input_tokens":100,"output_tokens":20,` +
		`"cache_read_input_tokens":30,"cache_creation_input_tokens":5}}`)
	row := usageFromAnthropic("r", time.Now(), "claude", "http", in, defaultConfig())
	if row.InputTokens != 100 || row.OutputTokens != 20 || row.CacheRead != 30 || row.CacheWrite != 5 {
		t.Fatalf("row = %+v", row)
	}
	if row.Total() != 155 || row.Estimated {
		t.Fatalf("total = %d estimated = %v", row.Total(), row.Estimated)
	}
}

func TestNewerVersion(t *testing.T) {
	cases := []struct {
		latest, current string
		want            bool
	}{
		{"1.4.0", "1.3.1", true},
		{"v2.0.0", "1.9.9", true},
		{"1.3.1", "1.3.1", false},
		{"1.2.0", "1.3.1", false},
	}
	for _, c := range cases {
		if got := newerVersion(c.latest, c.current); got != c.want {
			t.Errorf("newerVersion(%s, %s) = %v", c.latest, c.current, got)
		}
	}
}
