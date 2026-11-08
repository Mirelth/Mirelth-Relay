package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestProbeMCPHTTPTreatsAnyResponseAsOnline(t *testing.T) {
	cases := []struct {
		code   int
		status string
	}{
		{http.StatusOK, "online"},
		{http.StatusBadRequest, "online"},
		{http.StatusUnauthorized, "online"},
		{http.StatusNotFound, "online"},
		{http.StatusMethodNotAllowed, "online"},
		{http.StatusInternalServerError, "offline"},
		{http.StatusBadGateway, "offline"},
	}
	for _, c := range cases {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				t.Errorf("probe must use POST, got %s", r.Method)
			}
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("probe body must be json: %v", err)
			}
			if body["method"] != "initialize" {
				t.Errorf("probe method = %v", body["method"])
			}
			w.WriteHeader(c.code)
			_, _ = fmt.Fprint(w, `{}`)
		}))
		status, detail := probeMCPHTTP(srv.URL)
		srv.Close()
		if status != c.status {
			t.Errorf("HTTP %d → %s, want %s", c.code, status, c.status)
		}
		if !strings.Contains(detail, fmt.Sprint(c.code)) {
			t.Errorf("detail %q should mention the status code", detail)
		}
	}
}

func TestProbeMCPHTTPOfflineWhenUnreachable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := srv.URL
	srv.Close() // 端口关闭
	status, detail := probeMCPHTTP(url)
	if status != "offline" || detail == "" {
		t.Fatalf("status=%s detail=%q", status, detail)
	}
}

func TestListMCPHTTPToolsParsesJSONAndSSE(t *testing.T) {
	toolsJSON := `{"jsonrpc":"2.0","id":2,"result":{"tools":[` +
		`{"name":"read_file","description":"读文件"},` +
		`{"name":"","description":"` + strings.Repeat("x", 200) + `"}]}}`

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["method"] != "tools/list" {
			t.Errorf("tools probe method = %v", body["method"])
		}
		w.Header().Set("content-type", "text/event-stream")
		// SSE 前缀：解析器应跳过直到第一个 '{'
		_, _ = fmt.Fprint(w, "event: message\ndata: "+toolsJSON+"\n\n")
	}))
	defer srv.Close()

	tools := listMCPHTTPTools(srv.URL)
	if len(tools) != 2 {
		t.Fatalf("tools = %#v", tools)
	}
	if tools[0].Name != "read_file" || tools[0].Description != "读文件" {
		t.Fatalf("first tool = %+v", tools[0])
	}
	if tools[1].Name != "unknown" {
		t.Fatalf("empty name should fall back to unknown: %+v", tools[1])
	}
	if len(tools[1].Description) != 160 {
		t.Fatalf("description should be truncated to 160, got %d", len(tools[1].Description))
	}
}

func TestListMCPHTTPToolsEmptyOnGarbage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprint(w, "not json at all")
	}))
	defer srv.Close()
	if tools := listMCPHTTPTools(srv.URL); len(tools) != 0 {
		t.Fatalf("garbage body must yield no tools: %#v", tools)
	}
}

func TestProbeMCPStdio(t *testing.T) {
	dir := t.TempDir()
	existing := filepath.Join(dir, "server-bin")
	if err := os.WriteFile(existing, []byte("#!/bin/sh\n"), 0755); err != nil {
		t.Fatal(err)
	}

	if status, detail := probeMCPStdio(existing + " --flag"); status != "unverified" ||
		!strings.Contains(detail, "命令存在") {
		t.Fatalf("existing bin: %s / %s", status, detail)
	}
	if _, detail := probeMCPStdio(filepath.Join(dir, "missing-bin")); !strings.Contains(detail, "命令不存在") {
		t.Fatalf("missing bin detail = %s", detail)
	}
	// 普通名字走 PATH 解析：清空 PATH 后应回落成「未验证连接」
	t.Setenv("PATH", t.TempDir())
	if status, detail := probeMCPStdio("definitely-not-a-real-mcp-server"); status != "unverified" ||
		!strings.Contains(detail, "未验证连接") {
		t.Fatalf("plain name: %s / %s", status, detail)
	}
	// ~ 展开
	t.Setenv("HOME", dir)
	if _, detail := probeMCPStdio("~/server-bin"); !strings.Contains(detail, "命令存在") {
		t.Fatalf("tilde expansion failed: %s", detail)
	}
}

func mcpFixture(id, name, transport, endpoint string, enabled bool) AgentSnapshot {
	snap := snapshotFixture("agent-x", "Agent X", true, "installed")
	snap.MCPServers = []RawMcp{{
		Name: name, Transport: transport, Endpoint: endpoint, Enabled: enabled, Tools: []McpTool{},
	}}
	snap.Info.ID = "agent-x"
	return snap
}

func TestMcpHealthUpdatesCache(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["method"] == "tools/list" {
			_, _ = fmt.Fprint(w, `{"result":{"tools":[{"name":"t1","description":"d1"}]}}`)
			return
		}
		_, _ = fmt.Fprint(w, `{}`)
	}))
	defer srv.Close()

	st := testStore(t)
	if err := st.SaveSnapshot(mcpFixture("agent-x", "online-server", "http", srv.URL, true)); err != nil {
		t.Fatal(err)
	}
	app := &App{store: st}
	app.checkMCPHealth("agent-x:online-server")

	servers, err := st.ListMCP("agent-x")
	if err != nil {
		t.Fatal(err)
	}
	if len(servers) != 1 {
		t.Fatalf("servers = %#v", servers)
	}
	got := servers[0]
	if got.Status != "online" || got.LastChecked == "" {
		t.Fatalf("status = %+v", got)
	}
	if len(got.Tools) != 1 || got.Tools[0].Name != "t1" {
		t.Fatalf("tools should be refreshed: %+v", got.Tools)
	}
}

func TestMcpHealthDisabledAndUnknownTransport(t *testing.T) {
	st := testStore(t)
	snap := mcpFixture("agent-x", "off-server", "http", "https://127.0.0.1:1/mcp", false)
	if err := st.SaveSnapshot(snap); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveSnapshot(AgentSnapshot{
		Info:       AgentInfo{ID: "agent-y", Name: "Y", Kind: "cli", Detected: true},
		MCPServers: []RawMcp{{Name: "weird", Transport: "carrier-pigeon", Enabled: true}},
	}); err != nil {
		t.Fatal(err)
	}

	app := &App{store: st}
	app.checkMCPHealth("agent-x:off-server")
	app.checkMCPHealth("agent-y:weird")

	servers, _ := st.ListMCP("")
	byID := map[string]McpServer{}
	for _, s := range servers {
		byID[s.ID] = s
	}
	if got := byID["agent-x:off-server"]; got.Status != "disabled" {
		t.Fatalf("disabled server = %+v", got)
	}
	if got := byID["agent-y:weird"]; got.Status != "unverified" || !strings.Contains(got.StatusDetail, "无法识别") {
		t.Fatalf("unknown transport = %+v", got)
	}
	// 不存在的 id 不应 panic 或写脏数据
	app.checkMCPHealth("no-such-server")
}

func TestCheckAllMcpRespectsAgentFilter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprint(w, `{}`)
	}))
	defer srv.Close()

	st := testStore(t)
	for _, id := range []string{"agent-a", "agent-b"} {
		snap := snapshotFixture(id, id, true, "installed")
		snap.MCPServers = []RawMcp{{Name: "s", Transport: "http", Endpoint: srv.URL, Enabled: true}}
		if err := st.SaveSnapshot(snap); err != nil {
			t.Fatal(err)
		}
	}

	app := &App{store: st}
	var listed []McpServer
	if err := json.Unmarshal([]byte(app.CheckAllMcp("agent-a")), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed) != 1 || listed[0].AgentID != "agent-a" || listed[0].Status != "online" {
		t.Fatalf("filtered list = %#v", listed)
	}

	all, err := st.ListMCP("")
	if err != nil {
		t.Fatal(err)
	}
	byAgent := map[string]string{}
	for _, s := range all {
		byAgent[s.AgentID] = s.Status
	}
	if byAgent["agent-a"] != "online" {
		t.Fatalf("agent-a should be online: %v", byAgent)
	}
	if byAgent["agent-b"] != "unverified" {
		t.Fatalf("agent-b must stay untouched: %v", byAgent)
	}
}
