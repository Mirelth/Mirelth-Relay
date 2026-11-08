package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// 任务执行层（对应 src/main/execution-engine.ts）：
// 任务/子任务数据模型、依赖校验、就绪判定、队列，以及「拆解 / 执行」两个真正调 LLM 的动作。
// Electron 侧把执行器注入自它的 llmgw；Go 侧直接调本进程的网关（127.0.0.1:port）。

type SubTask struct {
	ID            string `json:"id"`
	Description   string `json:"description"`
	AssignedAgent string `json:"assignedAgent"`
	Status        string `json:"status"`
	Input         string `json:"input,omitempty"`
	Output        string `json:"output,omitempty"`
	StartedAt     int64  `json:"startedAt,omitempty"`
	CompletedAt   int64  `json:"completedAt,omitempty"`
	Error         string `json:"error,omitempty"`
}

type Task struct {
	ID             string    `json:"id"`
	Title          string    `json:"title"`
	Description    string    `json:"description"`
	Status         string    `json:"status"`
	Mode           string    `json:"mode"`
	SubTasks       []SubTask `json:"subTasks"`
	AssignedAgents []string  `json:"assignedAgents"`
	Dependencies   []string  `json:"dependencies"`
	CreatedAt      int64     `json:"createdAt"`
	CompletedAt    int64     `json:"completedAt,omitempty"`
	Output         string    `json:"output,omitempty"`
}

func tasksPath() string { return filepath.Join(configDir(), "tasks.json") }

func getTasks() []Task {
	tasks := readJSONList[Task](tasksPath())
	for i := range tasks {
		if tasks[i].SubTasks == nil {
			tasks[i].SubTasks = []SubTask{}
		}
		if tasks[i].AssignedAgents == nil {
			tasks[i].AssignedAgents = []string{}
		}
		if tasks[i].Dependencies == nil {
			tasks[i].Dependencies = []string{}
		}
	}
	return tasks
}

func saveTasks(tasks []Task) error { return writeJSONList(tasksPath(), tasks) }

func (a *App) ListTasks() string { return toJSON(getTasks()) }

func (a *App) GetTask(id string) string {
	for _, t := range getTasks() {
		if t.ID == id {
			return toJSON(t)
		}
	}
	return "null"
}

// CreateTask 建任务；mode 缺省按 sequential。
func (a *App) CreateTask(raw string) string {
	var incoming struct {
		Title          string   `json:"title"`
		Description    string   `json:"description"`
		Mode           string   `json:"mode"`
		AssignedAgents []string `json:"assignedAgents"`
		Dependencies   []string `json:"dependencies"`
	}
	if err := json.Unmarshal([]byte(raw), &incoming); err != nil {
		return toJSON(map[string]any{"error": err.Error()})
	}
	if strings.TrimSpace(incoming.Title) == "" {
		return toJSON(map[string]any{"error": "任务标题不能为空"})
	}
	mode := incoming.Mode
	if mode == "" {
		mode = "sequential"
	}
	task := Task{
		ID:    fmt.Sprintf("task-%d-%s", time.Now().UnixMilli(), randomSuffix()),
		Title: incoming.Title, Description: incoming.Description, Status: "pending", Mode: mode,
		SubTasks: []SubTask{}, AssignedAgents: incoming.AssignedAgents,
		Dependencies: incoming.Dependencies, CreatedAt: time.Now().UnixMilli(),
	}
	if task.AssignedAgents == nil {
		task.AssignedAgents = []string{}
	}
	if task.Dependencies == nil {
		task.Dependencies = []string{}
	}
	tasks := getTasks()
	tasks = append(tasks, task)
	if err := saveTasks(tasks); err != nil {
		return toJSON(map[string]any{"error": err.Error()})
	}
	return toJSON(task)
}

func (a *App) UpdateTaskStatus(id, status string) string {
	tasks := getTasks()
	for i := range tasks {
		if tasks[i].ID != id {
			continue
		}
		tasks[i].Status = status
		if status == "completed" {
			tasks[i].CompletedAt = time.Now().UnixMilli()
		}
		_ = saveTasks(tasks)
		return toJSON(tasks[i])
	}
	return "null"
}

func (a *App) AssignSubTask(taskID, subTaskID, agentID string) string {
	tasks := getTasks()
	for i := range tasks {
		if tasks[i].ID != taskID {
			continue
		}
		for j := range tasks[i].SubTasks {
			if tasks[i].SubTasks[j].ID != subTaskID {
				continue
			}
			tasks[i].SubTasks[j].AssignedAgent = agentID
			_ = saveTasks(tasks)
			return toJSON(true)
		}
	}
	return toJSON(false)
}

func (a *App) MonitorTask(id string) string { return a.GetTask(id) }

func (a *App) CancelTask(id string) string {
	tasks := getTasks()
	for i := range tasks {
		if tasks[i].ID != id {
			continue
		}
		tasks[i].Status = "cancelled"
		for j := range tasks[i].SubTasks {
			if tasks[i].SubTasks[j].Status == "running" || tasks[i].SubTasks[j].Status == "pending" {
				tasks[i].SubTasks[j].Status = "failed"
				tasks[i].SubTasks[j].Error = "任务已取消"
			}
		}
		_ = saveTasks(tasks)
		return toJSON(true)
	}
	return toJSON(false)
}

// dependenciesMet 判断依赖任务是否都已完成。
func dependenciesMet(task Task, byID map[string]Task) bool {
	for _, dep := range task.Dependencies {
		if t, ok := byID[dep]; !ok || t.Status != "completed" {
			return false
		}
	}
	return true
}

func (a *App) ReadyTasks() string {
	tasks := getTasks()
	byID := map[string]Task{}
	for _, t := range tasks {
		byID[t.ID] = t
	}
	out := []Task{}
	for _, t := range tasks {
		if t.Status == "pending" && dependenciesMet(t, byID) {
			out = append(out, t)
		}
	}
	return toJSON(out)
}

// ---------- 队列（内存态） ----------

type queueEntry struct {
	taskID   string
	priority int
}

type taskQueue struct {
	mu      sync.Mutex
	entries []queueEntry
	paused  bool
}

var appQueue = &taskQueue{}

func (q *taskQueue) snapshot() (entries []queueEntry, paused bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	return append([]queueEntry{}, q.entries...), q.paused
}

func (a *App) QueueStatus() string {
	entries, paused := appQueue.snapshot()
	queue := make([]string, 0, len(entries))
	for _, e := range entries {
		queue = append(queue, e.taskID)
	}
	return toJSON(map[string]any{
		"running": false, "paused": paused, "pending": len(entries),
		"processing": nil, "queue": queue,
	})
}

func (a *App) QueueEnqueue(taskID string, priority int) string {
	appQueue.mu.Lock()
	defer appQueue.mu.Unlock()
	for i, e := range appQueue.entries {
		if e.taskID == taskID {
			appQueue.entries[i].priority = priority
			return toJSON(true)
		}
	}
	appQueue.entries = append(appQueue.entries, queueEntry{taskID: taskID, priority: priority})
	// 优先级大的排前面，同优先级保持入队顺序
	for i := len(appQueue.entries) - 1; i > 0; i-- {
		if appQueue.entries[i-1].priority < appQueue.entries[i].priority {
			appQueue.entries[i-1], appQueue.entries[i] = appQueue.entries[i], appQueue.entries[i-1]
			continue
		}
		break
	}
	return toJSON(true)
}

func (a *App) QueuePause() string {
	appQueue.mu.Lock()
	appQueue.paused = true
	appQueue.mu.Unlock()
	return toJSON(true)
}

func (a *App) QueueResume() string {
	appQueue.mu.Lock()
	appQueue.paused = false
	appQueue.mu.Unlock()
	return toJSON(true)
}

func (a *App) QueueClear() string {
	appQueue.mu.Lock()
	appQueue.entries = nil
	appQueue.mu.Unlock()
	return toJSON(true)
}

func (a *App) QueueTaskIDs() string {
	entries, _ := appQueue.snapshot()
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		out = append(out, e.taskID)
	}
	return toJSON(out)
}

// ---------- 执行器：真调本进程网关 ----------

// gatewayModel 选一个当前可用的模型：优先显式指定的，其次任一启用账号声明的第一个模型。
func (a *App) gatewayModel(preferred string) string {
	if preferred != "" {
		return preferred
	}
	a.mu.Lock()
	cfg := a.cfg
	a.mu.Unlock()
	if cfg == nil {
		return ""
	}
	for i := range cfg.Upstreams {
		if !cfg.Upstreams[i].Enabled {
			continue
		}
		if names := cfg.Upstreams[i].servedModels(); len(names) > 0 {
			return names[0]
		}
	}
	return ""
}

// callGateway 用本机网关做一次非流式补全；网关未启用或没上游时返回可读错误。
func (a *App) callGateway(model, prompt string) (string, error) {
	if model == "" {
		return "", fmt.Errorf("尚未配置可用模型：请先在「网关」页添加上游账号")
	}
	if gatewayAddr(a.gw) == "" {
		return "", fmt.Errorf("网关未运行：请先在「网关」页启动")
	}
	a.mu.Lock()
	apiKey := ""
	if a.cfg != nil {
		apiKey = a.cfg.APIKey
	}
	a.mu.Unlock()

	payload, _ := json.Marshal(map[string]any{
		"model": model,
		"messages": []any{
			map[string]any{"role": "system", "content": "你是任务执行助手，输出简洁、可直接使用的结果。"},
			map[string]any{"role": "user", "content": prompt},
		},
		"max_tokens": 2048,
	})
	req, err := http.NewRequest(http.MethodPost, gatewayAddr(a.gw)+"/chat/completions", bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	client := &http.Client{Timeout: 180 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("网关返回 HTTP %d：%s", resp.StatusCode, truncate(string(body), 300))
	}

	var parsed struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "", fmt.Errorf("无法解析网关响应")
	}
	if len(parsed.Choices) == 0 {
		return "", fmt.Errorf("网关没有返回内容")
	}
	return parsed.Choices[0].Message.Content, nil
}

// decomposeTask 让模型把任务拆成 3-6 个子任务（要求 JSON 数组，解析失败时按行回退）。
func (a *App) decomposeTask(taskID string) ([]SubTask, error) {
	tasks := getTasks()
	var task *Task
	for i := range tasks {
		if tasks[i].ID == taskID {
			task = &tasks[i]
			break
		}
	}
	if task == nil {
		return nil, fmt.Errorf("任务不存在")
	}
	prompt := fmt.Sprintf(
		"把下面这个开发任务拆成 3-6 个可独立执行的子任务，每行一个，只输出 JSON 数组：[\"子任务1\",\"子任务2\"]\n\n任务：%s\n说明：%s",
		task.Title, task.Description)
	out, err := a.callGateway(a.gatewayModel(""), prompt)
	if err != nil {
		return nil, err
	}

	descriptions := []string{}
	if parsed := parseStringArray(out); len(parsed) > 0 {
		descriptions = parsed
	} else {
		for _, line := range strings.Split(out, "\n") {
			line = strings.TrimSpace(strings.TrimLeft(line, "-*0123456789. "))
			if line != "" {
				descriptions = append(descriptions, line)
			}
		}
	}
	if len(descriptions) == 0 {
		return nil, fmt.Errorf("模型没有给出可用的子任务")
	}

	subTasks := make([]SubTask, 0, len(descriptions))
	for i, desc := range descriptions {
		subTasks = append(subTasks, SubTask{
			ID:            fmt.Sprintf("sub-%d-%d", time.Now().UnixMilli(), i),
			Description:   desc,
			AssignedAgent: firstAgent(task.AssignedAgents),
			Status:        "pending",
		})
	}
	task.SubTasks = subTasks
	if err := saveTasks(tasks); err != nil {
		return nil, err
	}
	return subTasks, nil
}

func (a *App) DecomposeTask(taskID string) string {
	subTasks, err := a.decomposeTask(taskID)
	if err != nil {
		return toJSON(map[string]any{"error": err.Error()})
	}
	return toJSON(subTasks)
}

func parseStringArray(raw string) []string {
	start := strings.Index(raw, "[")
	end := strings.LastIndex(raw, "]")
	if start < 0 || end <= start {
		return nil
	}
	var out []string
	if json.Unmarshal([]byte(raw[start:end+1]), &out) != nil {
		return nil
	}
	return out
}

func firstAgent(agents []string) string {
	if len(agents) > 0 {
		return agents[0]
	}
	return ""
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// ExecuteSubTask：约束校验 → 调网关 → 信任度回写；失败记摩擦点。
func (a *App) ExecuteSubTask(taskID, subTaskID string) string {
	tasks := getTasks()
	ti := -1
	for i := range tasks {
		if tasks[i].ID == taskID {
			ti = i
			break
		}
	}
	if ti < 0 {
		return toJSON(map[string]any{"error": "任务不存在"})
	}
	si := -1
	for i := range tasks[ti].SubTasks {
		if tasks[ti].SubTasks[i].ID == subTaskID {
			si = i
			break
		}
	}
	if si < 0 {
		return toJSON(map[string]any{"error": "子任务不存在"})
	}

	agent := tasks[ti].SubTasks[si].AssignedAgent
	warnings := []string{}
	for _, v := range validateConstraints(agent, ConstraintContext{}) {
		allowed, msg := handleViolation(v)
		if !allowed {
			tasks[ti].SubTasks[si].Status = "failed"
			tasks[ti].SubTasks[si].Error = msg
			_ = saveTasks(tasks)
			return toJSON(map[string]any{"error": msg})
		}
		if msg != "" {
			warnings = append(warnings, msg)
		}
	}

	model := a.gatewayModel("")
	tasks[ti].SubTasks[si].Status = "running"
	tasks[ti].SubTasks[si].StartedAt = time.Now().UnixMilli()
	_ = saveTasks(tasks)

	started := time.Now()
	output, err := a.callGateway(model, tasks[ti].SubTasks[si].Description)
	if err != nil {
		tasks[ti].SubTasks[si].Status = "failed"
		tasks[ti].SubTasks[si].Error = err.Error()
		tasks[ti].SubTasks[si].CompletedAt = time.Now().UnixMilli()
		_ = saveTasks(tasks)
		updateTrustScore(agent, false, float64(time.Since(started).Milliseconds()))
		recordFrictionPoint(FrictionPoint{
			ID: "fp-" + randomSuffix(), AgentID: agent, TaskID: taskID,
			Description: err.Error(), Category: "error", CreatedAt: time.Now().UnixMilli(),
		})
		return toJSON(map[string]any{"error": err.Error()})
	}

	if len(warnings) > 0 {
		output = strings.Join(warnings, "；") + "\n" + output
	}
	tasks[ti].SubTasks[si].Status = "completed"
	tasks[ti].SubTasks[si].Output = output
	tasks[ti].SubTasks[si].CompletedAt = time.Now().UnixMilli()
	// 子任务全完成则任务完成
	allDone := true
	for _, st := range tasks[ti].SubTasks {
		if st.Status != "completed" {
			allDone = false
			break
		}
	}
	if allDone {
		tasks[ti].Status = "completed"
		tasks[ti].CompletedAt = time.Now().UnixMilli()
	}
	_ = saveTasks(tasks)
	updateTrustScore(agent, true, float64(time.Since(started).Milliseconds()))
	return toJSON(map[string]any{"output": output})
}
