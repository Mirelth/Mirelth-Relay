package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

const maxBody = 32 << 20

type Gateway struct {
	cfg    func() *Config
	store  *Store
	router *Router
	client *http.Client
	mu     sync.Mutex
	srv    *http.Server
	ln     net.Listener
	port   int
}

func newGateway(cfg func() *Config, store *Store, router *Router) *Gateway {
	if router == nil {
		router = NewRouter("")
	}
	return &Gateway{
		cfg:    cfg,
		store:  store,
		router: router,
		// 不设整体 Timeout：流式响应不能被总时长截断，等响应头的超时由 dispatch 单独控。
		client: &http.Client{Transport: &http.Transport{
			Proxy:               http.ProxyFromEnvironment,
			MaxIdleConnsPerHost: 16,
			IdleConnTimeout:     90 * time.Second,
		}},
	}
}

func (g *Gateway) Start() error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.ln != nil {
		return nil
	}
	base := g.cfg().Port
	for i := 0; i < 10; i++ {
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", base+i))
		if err != nil {
			continue
		}
		g.ln, g.port = ln, base+i
		g.srv = &http.Server{Handler: g, ReadHeaderTimeout: 15 * time.Second}
		go func() { _ = g.srv.Serve(ln) }()
		return nil
	}
	return fmt.Errorf("127.0.0.1:%d 起的 10 个端口都被占用", base)
}

func (g *Gateway) Stop() {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.srv != nil {
		_ = g.srv.Close()
	}
	g.ln, g.srv = nil, nil
}

func (g *Gateway) Addr() string {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.ln == nil {
		return ""
	}
	return fmt.Sprintf("http://127.0.0.1:%d/v1", g.port)
}

func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "authorization, x-api-key, content-type")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	cfg := g.cfg()
	if !authorized(r, cfg.APIKey) {
		writeJSON(w, http.StatusUnauthorized, openAIError("invalid api key", "authentication_error"))
		return
	}
	path := strings.TrimSuffix(r.URL.Path, "/")
	switch {
	case r.Method == http.MethodGet && (path == "/v1/models" || path == "/models"):
		g.listModels(w, cfg)
	case r.Method == http.MethodPost && (path == "/v1/chat/completions" || path == "/chat/completions"):
		g.chat(w, r, cfg)
	default:
		writeJSON(w, http.StatusNotFound, openAIError("unknown route", "invalid_request_error"))
	}
}

func authorized(r *http.Request, key string) bool {
	got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if got == "" {
		got = r.Header.Get("x-api-key")
	}
	if got == "" || key == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(key)) == 1
}

func (g *Gateway) listModels(w http.ResponseWriter, cfg *Config) {
	type item struct {
		ID      string `json:"id"`
		Object  string `json:"object"`
		OwnedBy string `json:"owned_by"`
	}
	data := []item{}
	seen := map[string]bool{}
	for _, u := range cfg.Upstreams {
		if !u.Enabled {
			continue
		}
		for _, model := range u.servedModels() {
			if model == "" || seen[model] {
				continue
			}
			seen[model] = true
			data = append(data, item{ID: model, Object: "model", OwnedBy: u.Name})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"object": "list", "data": data})
}

// ---------- 请求入口 ----------

func (g *Gateway) chat(w http.ResponseWriter, r *http.Request, cfg *Config) {
	start := time.Now()
	reqID := newRequestID()
	source := r.Header.Get("X-Relay-Source")
	if source == "" {
		source = "http"
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBody))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, openAIError("cannot read request body", "invalid_request_error"))
		return
	}
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		writeJSON(w, http.StatusBadRequest, openAIError("invalid json body", "invalid_request_error"))
		return
	}
	model, _ := payload["model"].(string)
	stream, _ := payload["stream"].(bool)

	// dispatch 只在拿到可用响应头时才返回，所以以下换账号过程对客户端完全透明。
	hit, attempts, err := g.dispatch(r, cfg, model, payload, stream)
	if err != nil {
		status := http.StatusServiceUnavailable
		var giveUp *giveUpError
		if errors.As(err, &giveUp) {
			// 4xx 非限流是调用方自己的问题，上游原话比我们的包装有用。
			status = http.StatusBadGateway
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			_, _ = w.Write(giveUp.body)
		} else {
			msg := err.Error()
			if errors.Is(err, errNoUpstream) {
				msg = "no enabled upstream for model " + model
			}
			writeJSON(w, status, openAIError(msg, "server_error"))
		}
		elapsed := time.Since(start).Milliseconds()
		g.record(UsageRow{RequestID: reqID, TS: start.UnixMilli(), Model: model, Source: source,
			Status: failureStatus(err), Requests: 1, LatencyMS: elapsed})
		g.saveTrace(TraceRequest{ID: reqID, TS: start.UnixMilli(), Endpoint: r.URL.Path,
			Agent: agentOf(r), Model: model, Status: status, MS: elapsed, Tries: countTries(attempts),
			Error: err.Error(), Attempts: attempts})
		return
	}
	defer func() {
		_ = hit.resp.Body.Close()
		hit.cancel()
		g.router.Release(hit.up.ID)
	}()

	g.router.Served(hit.up.ID, hit.resp.StatusCode)
	// 把「换了几次账号」直接告诉调用方，排查时不必先看页面。
	w.Header().Set("X-Relay-Request-Id", reqID)
	w.Header().Set("X-Relay-Account", hit.up.Name)
	w.Header().Set("X-Relay-Attempts", itoa(int64(hit.trace.Index)))

	upBody := &countingReader{r: hit.resp.Body}
	var row UsageRow
	if stream {
		row = g.chatStream(w, upBody, hit.up, cfg, reqID, start, model, source, &hit.trace)
	} else {
		row = g.chatOnce(w, upBody, hit.up, cfg, reqID, start, model, source, payload)
	}
	g.record(row)

	trace := TraceRequest{ID: reqID, TS: start.UnixMilli(), Endpoint: r.URL.Path, Agent: agentOf(r),
		Model: row.Model, Status: hit.resp.StatusCode, MS: row.LatencyMS, Tries: hit.trace.Index,
		TTFTMS: hit.trace.TTFTMS, FirstByteMS: hit.trace.MS,
		InputTokens: row.InputTokens, OutputTokens: row.OutputTokens, CacheRead: row.CacheRead,
		CacheWrite: row.CacheWrite, Reasoning: row.Reasoning, UpBytes: upBody.n,
		Attempts: append(append([]Attempt{}, attempts...), hit.trace)}
	if stream {
		trace.FlowMS = row.LatencyMS - hit.trace.MS
		if trace.FlowMS < 0 {
			trace.FlowMS = 0
		}
	}
	g.saveTrace(trace)
}

// countTries 统计真正发出的尝试次数（并发限流跳过的算跳过，不算一次尝试）。
func countTries(attempts []Attempt) int {
	n := 0
	for _, a := range attempts {
		if !a.Skipped {
			n++
		}
	}
	return n
}

// failureStatus 给用量账本一个可读的失败归类。
func failureStatus(err error) string {
	var giveUp *giveUpError
	if errors.As(err, &giveUp) {
		return fmt.Sprintf("HTTP %d", giveUp.status)
	}
	if errors.Is(err, errNoUpstream) {
		return "no-upstream"
	}
	return "upstream-error"
}

// ---------- 上游请求构造 ----------

func buildUpstreamRequest(ctx context.Context, up *Upstream, payload map[string]any, stream bool) (*http.Request, error) {
	var url string
	var body []byte
	headers := map[string]string{"Content-Type": "application/json"}

	if up.Kind == "anthropic" {
		url = strings.TrimRight(up.BaseURL, "/") + "/messages"
		if up.APIKey != "" {
			headers["x-api-key"] = up.APIKey
		}
		headers["anthropic-version"] = "2023-06-01"
		body = toAnthropicRequest(payload, stream)
	} else {
		url = strings.TrimRight(up.BaseURL, "/") + "/chat/completions"
		if up.APIKey != "" {
			headers["Authorization"] = "Bearer " + up.APIKey
		}
		p := cloneMap(payload)
		p["stream"] = stream
		if stream {
			p["stream_options"] = map[string]any{"include_usage": true}
		}
		body, _ = json.Marshal(p)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	return req, nil
}

func cloneMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in)+2)
	for k, v := range in {
		out[k] = v
	}
	return out
}

func toAnthropicRequest(payload map[string]any, stream bool) []byte {
	system := ""
	messages := []any{}
	if raw, ok := payload["messages"].([]any); ok {
		for _, m := range raw {
			msg, ok := m.(map[string]any)
			if !ok {
				continue
			}
			role, _ := msg["role"].(string)
			content := contentToString(msg["content"])
			if role == "system" {
				system += content + "\n"
				continue
			}
			if role != "user" && role != "assistant" {
				continue
			}
			messages = append(messages, map[string]any{"role": role, "content": content})
		}
	}
	maxTokens := 4096
	if v, ok := payload["max_tokens"].(float64); ok && v > 0 {
		maxTokens = int(v)
	}
	out := map[string]any{
		"model":      payload["model"],
		"messages":   messages,
		"max_tokens": maxTokens,
		"stream":     stream,
	}
	if system != "" {
		out["system"] = strings.TrimSpace(system)
	}
	if v, ok := payload["temperature"]; ok {
		out["temperature"] = v
	}
	b, _ := json.Marshal(out)
	return b
}

func contentToString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	if parts, ok := v.([]any); ok {
		var sb strings.Builder
		for _, p := range parts {
			if m, ok := p.(map[string]any); ok {
				if t, ok := m["text"].(string); ok {
					sb.WriteString(t)
				}
			}
		}
		return sb.String()
	}
	return ""
}

// ---------- 非流式 ----------

func (g *Gateway) chatOnce(w http.ResponseWriter, body *countingReader, up *Upstream, cfg *Config,
	reqID string, start time.Time, model, source string, payload map[string]any) UsageRow {

	respBytes, err := io.ReadAll(io.LimitReader(body, maxBody))
	if err != nil {
		writeJSON(w, http.StatusBadGateway, openAIError(err.Error(), "server_error"))
		return UsageRow{RequestID: reqID, TS: start.UnixMilli(), Model: model, Source: source,
			Requests: 1, Status: "body-error", LatencyMS: time.Since(start).Milliseconds()}
	}
	var row UsageRow
	if up.Kind == "anthropic" {
		row = usageFromAnthropic(reqID, start, model, source, respBytes, cfg)
		respBytes = fromAnthropic(respBytes, model)
	} else {
		row = usageFromResponse(reqID, start, model, source, payload, respBytes, cfg)
	}
	row.Status = "HTTP 200"
	row.LatencyMS = time.Since(start).Milliseconds()

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Relay-Request-Id", reqID)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(respBytes)
	return row
}

func fromAnthropic(respBytes []byte, fallbackModel string) []byte {
	var in struct {
		ID      string `json:"id"`
		Model   string `json:"model"`
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
		StopReason string `json:"stop_reason"`
		Usage      *struct {
			InputTokens  int64 `json:"input_tokens"`
			OutputTokens int64 `json:"output_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(respBytes, &in); err != nil {
		return respBytes
	}
	text := ""
	for _, c := range in.Content {
		text += c.Text
	}
	model := in.Model
	if model == "" {
		model = fallbackModel
	}
	out := map[string]any{
		"id": in.ID, "object": "chat.completion", "created": time.Now().Unix(), "model": model,
		"choices": []any{map[string]any{
			"index": 0, "message": map[string]any{"role": "assistant", "content": text},
			"finish_reason": in.StopReason,
		}},
	}
	if in.Usage != nil {
		out["usage"] = map[string]any{
			"prompt_tokens": in.Usage.InputTokens, "completion_tokens": in.Usage.OutputTokens,
			"total_tokens": in.Usage.InputTokens + in.Usage.OutputTokens,
		}
	}
	b, _ := json.Marshal(out)
	return b
}

func usageFromAnthropic(reqID string, start time.Time, model, source string, respBytes []byte, cfg *Config) UsageRow {
	row := UsageRow{RequestID: reqID, TS: start.UnixMilli(), Model: model, Source: source, Requests: 1}
	var in struct {
		Model string `json:"model"`
		Usage *struct {
			InputTokens              int64 `json:"input_tokens"`
			OutputTokens             int64 `json:"output_tokens"`
			CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
			CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(respBytes, &in); err == nil {
		if in.Model != "" {
			row.Model = in.Model
		}
		if in.Usage != nil {
			row.InputTokens = in.Usage.InputTokens
			row.OutputTokens = in.Usage.OutputTokens
			row.CacheRead = in.Usage.CacheReadInputTokens
			row.CacheWrite = in.Usage.CacheCreationInputTokens
		} else {
			row.Estimated = true
			row.InputTokens = int64(len(string(respBytes)) / 4)
		}
	} else {
		row.Estimated = true
	}
	row.CostUSD = costUSD(cfg, row.Model, row.InputTokens, row.OutputTokens, row.CacheRead, row.CacheWrite)
	return row
}

// 从上游响应提取真实 usage；上游不返回时按字符数估算并明确标记。
func usageFromResponse(reqID string, start time.Time, model, source string,
	payload map[string]any, respBytes []byte, cfg *Config) UsageRow {

	row := UsageRow{RequestID: reqID, TS: start.UnixMilli(), Model: model,
		Source: source, Requests: 1}
	var parsed struct {
		Model string `json:"model"`
		Usage *struct {
			PromptTokens     int64 `json:"prompt_tokens"`
			CompletionTokens int64 `json:"completion_tokens"`
			PromptDetails    *struct {
				CachedTokens int64 `json:"cached_tokens"`
			} `json:"prompt_tokens_details"`
			CompletionDetails *struct {
				ReasoningTokens int64 `json:"reasoning_tokens"`
			} `json:"completion_tokens_details"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(respBytes, &parsed); err == nil {
		if parsed.Model != "" {
			row.Model = parsed.Model
		}
		if parsed.Usage != nil {
			row.InputTokens = parsed.Usage.PromptTokens
			row.OutputTokens = parsed.Usage.CompletionTokens
			if parsed.Usage.PromptDetails != nil {
				row.CacheRead = parsed.Usage.PromptDetails.CachedTokens
			}
			if parsed.Usage.CompletionDetails != nil {
				row.Reasoning = parsed.Usage.CompletionDetails.ReasoningTokens
			}
		} else {
			row.Estimated = true
			reqChars, _ := json.Marshal(payload)
			row.InputTokens = int64(len(string(reqChars)) / 4)
			row.OutputTokens = int64(len(string(respBytes)) / 4)
		}
	} else {
		row.Estimated = true
	}
	row.CostUSD = costUSD(cfg, row.Model, row.InputTokens, row.OutputTokens, row.CacheRead, row.CacheWrite)
	return row
}

// ---------- 真流式 SSE ----------

func (g *Gateway) chatStream(w http.ResponseWriter, body *countingReader, up *Upstream, cfg *Config,
	reqID string, start time.Time, model, source string, trace *Attempt) UsageRow {

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Relay-Request-Id", reqID)
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)

	// 首个带增量内容的 SSE 帧到达时刻就是 TTFT；观测页靠它算「首字延迟」。
	markFirstToken := func() {
		if trace != nil && trace.TTFTMS == 0 {
			trace.TTFTMS = time.Since(start).Milliseconds()
		}
	}

	emit := func(v any) {
		b, _ := json.Marshal(v)
		_, _ = fmt.Fprintf(w, "data: %s\n\n", b)
		if flusher != nil {
			flusher.Flush()
		}
	}
	chunk := func(delta string, finish any, usage any) {
		payload := map[string]any{
			"id": "chatcmpl-" + reqID[:8], "object": "chat.completion.chunk",
			"created": start.Unix(), "model": model,
			"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": delta}, "finish_reason": finish}},
		}
		if usage != nil {
			payload["choices"] = []any{}
			payload["usage"] = usage
		}
		emit(payload)
	}

	row := UsageRow{RequestID: reqID, TS: start.UnixMilli(), Model: model, Source: source,
		Requests: 1, Status: "stream"}
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	eventName := ""
	charCount := 0
	gotUsage := false

	for scanner.Scan() {
		line := scanner.Text()
		if up.Kind == "anthropic" {
			if strings.HasPrefix(line, "event: ") {
				eventName = strings.TrimPrefix(line, "event: ")
				continue
			}
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			var ev map[string]any
			data := strings.TrimPrefix(line, "data: ")
			if json.Unmarshal([]byte(data), &ev) != nil {
				continue
			}
			switch eventName {
			case "message_start":
				if m, ok := ev["message"].(map[string]any); ok {
					if u, ok := m["usage"].(map[string]any); ok {
						row.InputTokens = jsonInt(u["input_tokens"])
						row.CacheRead = jsonInt(u["cache_read_input_tokens"])
						row.CacheWrite = jsonInt(u["cache_creation_input_tokens"])
						if m2, ok := m["model"].(string); ok && m2 != "" {
							row.Model = m2
						}
						gotUsage = true
					}
				}
			case "content_block_delta":
				if d, ok := ev["delta"].(map[string]any); ok {
					text, _ := d["text"].(string)
					charCount += len(text)
					markFirstToken()
					chunk(text, nil, nil)
				}
			case "message_delta":
				if u, ok := ev["usage"].(map[string]any); ok {
					row.OutputTokens = jsonInt(u["output_tokens"])
					gotUsage = true
				}
				chunk("", "stop", nil)
			}
			continue
		}

		// OpenAI 兼容上游：原样转发 SSE 帧，同时抓取末尾 usage
		_, _ = fmt.Fprintf(w, "%s\n", line)
		if flusher != nil {
			flusher.Flush()
		}
		if strings.Contains(line, "\"delta\"") {
			markFirstToken()
		}
		if !strings.HasPrefix(line, "data: ") || strings.Contains(line, "[DONE]") {
			continue
		}
		var c struct {
			Model string `json:"model"`
			Usage *struct {
				PromptTokens     int64 `json:"prompt_tokens"`
				CompletionTokens int64 `json:"completion_tokens"`
				PromptDetails    *struct {
					CachedTokens int64 `json:"cached_tokens"`
				} `json:"prompt_tokens_details"`
			} `json:"usage"`
		}
		if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &c) == nil && c.Usage != nil {
			if c.Model != "" {
				row.Model = c.Model
			}
			row.InputTokens = c.Usage.PromptTokens
			row.OutputTokens = c.Usage.CompletionTokens
			if c.Usage.PromptDetails != nil {
				row.CacheRead = c.Usage.PromptDetails.CachedTokens
			}
			gotUsage = true
		}
	}

	if up.Kind == "anthropic" {
		chunk("", nil, map[string]any{
			"prompt_tokens": row.InputTokens, "completion_tokens": row.OutputTokens,
			"total_tokens": row.InputTokens + row.OutputTokens,
		})
		_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
		if flusher != nil {
			flusher.Flush()
		}
	}
	if !gotUsage {
		row.Estimated = true
		if row.InputTokens == 0 {
			row.InputTokens = int64(charCount / 4)
		}
		if row.OutputTokens == 0 {
			row.OutputTokens = int64(charCount / 4)
		}
	}
	row.CostUSD = costUSD(cfg, row.Model, row.InputTokens, row.OutputTokens, row.CacheRead, row.CacheWrite)
	row.LatencyMS = time.Since(start).Milliseconds()
	return row
}

func jsonInt(v any) int64 {
	if f, ok := v.(float64); ok {
		return int64(f)
	}
	return 0
}

// ---------- 通用 ----------

func (g *Gateway) record(row UsageRow) {
	if g.store != nil {
		_ = g.store.Insert(row)
	}
	if row.Status == "upstream-error" || row.Status == "no-upstream" {
		notifyThrottled("Relay 网关", "请求失败："+row.Status+" · "+row.Model)
	}
}

func newRequestID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("relay-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

func openAIError(message, typ string) map[string]any {
	return map[string]any{"error": map[string]any{"message": message, "type": typ}}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
