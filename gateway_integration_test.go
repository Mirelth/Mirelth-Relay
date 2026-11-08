package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func testGateway(t *testing.T, upstreamURL, kind, model string) (*Gateway, *Store, *Config) {
	t.Helper()
	cfg := defaultConfig()
	cfg.Upstreams = []Upstream{{
		ID: "mock", Name: "mock", BaseURL: upstreamURL, Model: model,
		Kind: kind, APIKey: "sk-test", Enabled: true,
	}}
	st, err := openStoreAt(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return newGateway(func() *Config { return cfg }, st, NewRouter(filepath.Join(t.TempDir(), "state.json"))), st, cfg
}

func chatRequest(cfg *Config, body string) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	req.Header.Set("Content-Type", "application/json")
	return req
}

func TestOpenAIStreamForwardsSSEAndRecordsUsage(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			t.Errorf("upstream path = %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":3}}\n\n")
		_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer upstream.Close()

	g, st, cfg := testGateway(t, upstream.URL, "openai", "mock-model")
	rec := httptest.NewRecorder()
	g.ServeHTTP(rec, chatRequest(cfg, `{"model":"mock-model","stream":true,"messages":[]}`))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "[DONE]") {
		t.Fatalf("SSE body missing [DONE]: %s", rec.Body.String())
	}
	rows, _ := st.Recent(10)
	if len(rows) != 1 {
		t.Fatalf("usage rows = %d", len(rows))
	}
	if rows[0].InputTokens != 12 || rows[0].OutputTokens != 3 || rows[0].Estimated {
		t.Fatalf("usage = %+v", rows[0])
	}
}

func TestUnauthorizedRequestIsRejected(t *testing.T) {
	g, _, _ := testGateway(t, "http://127.0.0.1:1", "openai", "mock-model")
	req := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	rec := httptest.NewRecorder()
	g.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestAnthropicNonStreamConvertedAndRecorded(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/messages" {
			t.Errorf("upstream path = %s", r.URL.Path)
		}
		if r.Header.Get("x-api-key") == "" {
			t.Error("missing x-api-key header")
		}
		_, _ = fmt.Fprint(w, `{"id":"msg_1","model":"claude-x",`+
			`"content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn",`+
			`"usage":{"input_tokens":10,"output_tokens":4}}`)
	}))
	defer upstream.Close()

	g, st, cfg := testGateway(t, upstream.URL, "anthropic", "claude-x")
	rec := httptest.NewRecorder()
	g.ServeHTTP(rec, chatRequest(cfg, `{"model":"claude-x","messages":[{"role":"user","content":"hi"}]}`))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	choices := out["choices"].([]any)
	content := choices[0].(map[string]any)["message"].(map[string]any)["content"]
	if content != "ok" {
		t.Fatalf("content = %v", content)
	}
	rows, _ := st.Recent(10)
	if len(rows) != 1 || rows[0].InputTokens != 10 || rows[0].OutputTokens != 4 || rows[0].Estimated {
		t.Fatalf("usage rows = %+v", rows)
	}
}

func TestAnthropicStreamConvertedAndRecorded(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "event: message_start\n")
		_, _ = fmt.Fprint(w, "data: {\"message\":{\"model\":\"claude-x\",\"usage\":{\"input_tokens\":20}}}\n\n")
		_, _ = fmt.Fprint(w, "event: content_block_delta\n")
		_, _ = fmt.Fprint(w, "data: {\"delta\":{\"text\":\"hello\"}}\n\n")
		_, _ = fmt.Fprint(w, "event: message_delta\n")
		_, _ = fmt.Fprint(w, "data: {\"usage\":{\"output_tokens\":5}}\n\n")
		_, _ = fmt.Fprint(w, "event: message_stop\n")
		_, _ = fmt.Fprint(w, "data: {}\n\n")
	}))
	defer upstream.Close()

	g, st, cfg := testGateway(t, upstream.URL, "anthropic", "claude-x")
	rec := httptest.NewRecorder()
	g.ServeHTTP(rec, chatRequest(cfg, `{"model":"claude-x","stream":true,"messages":[]}`))

	if !strings.Contains(rec.Body.String(), "hello") || !strings.Contains(rec.Body.String(), "[DONE]") {
		t.Fatalf("stream body = %s", rec.Body.String())
	}
	rows, _ := st.Recent(10)
	if len(rows) != 1 {
		t.Fatalf("usage rows = %d", len(rows))
	}
	if rows[0].InputTokens != 20 || rows[0].OutputTokens != 5 || rows[0].Estimated {
		t.Fatalf("usage = %+v", rows[0])
	}
}
