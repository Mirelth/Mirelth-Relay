package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// MCP 连通性探测（对应 src/main/mcp-health.ts）：
//   - http/sse：发一个轻量 initialize，收到任何 HTTP 响应就算在线（404/405 也说明服务在监听）；
//     在线时再发 tools/list 拉工具清单。
//   - stdio：只判断命令是否存在于磁盘，绝不真正拉起子进程。
const (
	mcpProbeTimeout = 4 * time.Second
	mcpProbeBatch   = 6
)

var mcpClient = &http.Client{Timeout: mcpProbeTimeout}

func mcpInitializeBody() []byte {
	return []byte(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{` +
		`"protocolVersion":"2024-11-05","capabilities":{},` +
		`"clientInfo":{"name":"relay","version":"1.0.0"}}}`)
}

// probeMCPHTTP 返回状态与可直接展示的说明。
func probeMCPHTTP(endpoint string) (string, string) {
	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(mcpInitializeBody()))
	if err != nil {
		return "offline", err.Error()
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("accept", "application/json, text/event-stream")

	resp, err := mcpClient.Do(req)
	if err != nil {
		return "offline", err.Error()
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64*1024))

	switch resp.StatusCode {
	case http.StatusBadRequest, http.StatusUnauthorized, http.StatusNotFound,
		http.StatusMethodNotAllowed, http.StatusNotAcceptable:
		return "online", fmt.Sprintf("HTTP %d", resp.StatusCode)
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return "online", fmt.Sprintf("HTTP %d", resp.StatusCode)
	}
	return "offline", fmt.Sprintf("HTTP %d", resp.StatusCode)
}

// listMCPHTTPTools 拉工具清单；服务返回 SSE 时取第一个 '{' 之后的内容再解析。
func listMCPHTTPTools(endpoint string) []McpTool {
	body := []byte(`{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`)
	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("accept", "application/json, text/event-stream")

	resp, err := mcpClient.Do(req)
	if err != nil {
		return nil
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))

	text := string(raw)
	start := strings.Index(text, "{")
	if start < 0 {
		return nil
	}
	var parsed struct {
		Result struct {
			Tools []struct {
				Name        string `json:"name"`
				Description string `json:"description"`
			} `json:"tools"`
		} `json:"result"`
	}
	if json.Unmarshal([]byte(text[start:]), &parsed) != nil {
		return nil
	}
	out := make([]McpTool, 0, len(parsed.Result.Tools))
	for _, t := range parsed.Result.Tools {
		name := t.Name
		if name == "" {
			name = "unknown"
		}
		desc := t.Description
		if len(desc) > 160 {
			desc = desc[:160]
		}
		out = append(out, McpTool{Name: name, Description: desc})
	}
	return out
}

// probeMCPStdio 只做「命令是否存在」的判断，结果一律 unverified——没连上就不冒充在线。
func probeMCPStdio(command string) (string, string) {
	fields := strings.Fields(command)
	if len(fields) == 0 {
		return "unverified", "无法识别的传输类型"
	}
	bin := fields[0]
	if strings.HasPrefix(bin, "/") || strings.HasPrefix(bin, "~") {
		path := bin
		if strings.HasPrefix(path, "~") {
			path = homeDir() + strings.TrimPrefix(path, "~")
		}
		if exists(path) {
			return "unverified", "命令存在（stdio 未连接）"
		}
		return "unverified", "命令不存在"
	}
	if resolveBin(bin) != "" {
		return "unverified", "命令存在（stdio 未连接）"
	}
	return "unverified", "stdio 服务未验证连接"
}

// checkMCPHealth 探测一个 MCP 条目并回写状态。
func (a *App) checkMCPHealth(serverID string) {
	if a.store == nil {
		return
	}
	servers, err := a.store.ListMCP("")
	if err != nil {
		return
	}
	var server *McpServer
	for i := range servers {
		if servers[i].ID == serverID {
			server = &servers[i]
			break
		}
	}
	if server == nil {
		return
	}
	if !server.Enabled {
		_ = a.store.UpdateMcpStatus(serverID, "disabled", "已在智能体配置中禁用", server.Tools)
		return
	}
	switch server.Transport {
	case "http", "sse":
		if server.Endpoint == "" {
			_ = a.store.UpdateMcpStatus(serverID, "unverified", "无 endpoint", server.Tools)
			return
		}
		status, detail := probeMCPHTTP(server.Endpoint)
		tools := server.Tools
		if status == "online" {
			if got := listMCPHTTPTools(server.Endpoint); len(got) > 0 {
				tools = got
			}
		}
		_ = a.store.UpdateMcpStatus(serverID, status, detail, tools)
	case "stdio":
		if server.Endpoint == "" {
			_ = a.store.UpdateMcpStatus(serverID, "unverified", "无法识别的传输类型", server.Tools)
			return
		}
		status, detail := probeMCPStdio(server.Endpoint)
		_ = a.store.UpdateMcpStatus(serverID, status, detail, server.Tools)
	default:
		_ = a.store.UpdateMcpStatus(serverID, "unverified", "无法识别的传输类型", server.Tools)
	}
}

// CheckMcp 探测单个条目并返回完整清单（页面「检测」按钮）。
func (a *App) CheckMcp(serverID string) string {
	a.checkMCPHealth(serverID)
	return a.GetMcpServers("")
}

// CheckAllMcp 按批探测（每批 6 个并发），返回对应范围的清单。
func (a *App) CheckAllMcp(agentID string) string {
	if a.store == nil {
		return "[]"
	}
	servers, err := a.store.ListMCP(agentID)
	if err != nil {
		return "[]"
	}
	for i := 0; i < len(servers); i += mcpProbeBatch {
		end := i + mcpProbeBatch
		if end > len(servers) {
			end = len(servers)
		}
		done := make(chan struct{}, end-i)
		for _, s := range servers[i:end] {
			go func(id string) {
				defer func() { done <- struct{}{} }()
				a.checkMCPHealth(id)
			}(s.ID)
		}
		for j := i; j < end; j++ {
			<-done
		}
	}
	return a.GetMcpServers(agentID)
}

// UpdateMcpStatus 回写探测结果（last_checked 用 RFC3339）。
func (s *Store) UpdateMcpStatus(id, status, detail string, tools []McpTool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if tools == nil {
		tools = []McpTool{}
	}
	encoded, err := json.Marshal(tools)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`update agent_mcp set status = ?, status_detail = ?, tools_json = ?, last_checked = ?
where id = ?`, status, nullIfEmpty(detail), string(encoded),
		time.Now().Format(time.RFC3339), id)
	return err
}
