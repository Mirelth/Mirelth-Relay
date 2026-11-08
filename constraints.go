package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// 约束与信任度（对应 src/main/{constraints,trust-scoring}.ts）。

type ConstraintConfig struct {
	MaxTokensPerDay int      `json:"maxTokensPerDay,omitempty"`
	AllowedModels   []string `json:"allowedModels,omitempty"`
	MaxCostPerDay   float64  `json:"maxCostPerDay,omitempty"`
	AllowedHours    []int    `json:"allowedHours,omitempty"`
}

type AgentConstraint struct {
	ID        string           `json:"id"`
	AgentID   string           `json:"agentId"`
	Type      string           `json:"type"` // token-limit | model-whitelist | cost-cap | time-window
	Config    ConstraintConfig `json:"config"`
	Action    string           `json:"action"` // block | warn | log
	Enabled   bool             `json:"enabled"`
	CreatedAt int64            `json:"createdAt"`
}

type ConstraintViolation struct {
	ConstraintID string `json:"constraintId"`
	AgentID      string `json:"agentId"`
	Type         string `json:"type"`
	Action       string `json:"action"`
	Message      string `json:"message"`
	Timestamp    int64  `json:"timestamp"`
}

type ConstraintContext struct {
	Model       string  `json:"model"`
	TokensToday int64   `json:"tokensToday"`
	CostToday   float64 `json:"costToday"`
	CurrentHour int     `json:"currentHour"`
	hasHour     bool
}

type TrustScore struct {
	AgentID         string  `json:"agentId"`
	Score           float64 `json:"score"`
	TotalTasks      int     `json:"totalTasks"`
	SuccessfulTasks int     `json:"successfulTasks"`
	FailedTasks     int     `json:"failedTasks"`
	AvgDuration     float64 `json:"avgDuration"`
	LastUpdated     int64   `json:"lastUpdated"`
}

type FrictionPoint struct {
	ID          string `json:"id"`
	AgentID     string `json:"agentId"`
	TaskID      string `json:"taskId,omitempty"`
	Description string `json:"description"`
	Category    string `json:"category"`
	Resolution  string `json:"resolution,omitempty"`
	CreatedAt   int64  `json:"createdAt"`
}

func constraintsPath() string    { return filepath.Join(configDir(), "constraints.json") }
func trustScoresPath() string    { return filepath.Join(configDir(), "trust-scores.json") }
func frictionPointsPath() string { return filepath.Join(configDir(), "friction-points.json") }

// readJSONList 读一个 JSON 数组文件；缺失或损坏都当作空列表。
func readJSONList[T any](path string) []T {
	b, err := os.ReadFile(path)
	if err != nil {
		return []T{}
	}
	var list []T
	if json.Unmarshal(b, &list) != nil || list == nil {
		return []T{}
	}
	return list
}

func writeJSONList(path string, v any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(b, '\n'), 0600)
}

func getConstraints() []AgentConstraint { return readJSONList[AgentConstraint](constraintsPath()) }

func saveConstraints(list []AgentConstraint) error { return writeJSONList(constraintsPath(), list) }

func (a *App) ListConstraints() string { return toJSON(getConstraints()) }

func (a *App) AddConstraint(raw string) string {
	var incoming AgentConstraint
	if err := json.Unmarshal([]byte(raw), &incoming); err != nil {
		return toJSON(map[string]any{"error": err.Error()})
	}
	if strings.TrimSpace(incoming.AgentID) == "" || strings.TrimSpace(incoming.Type) == "" {
		return toJSON(map[string]any{"error": "缺少 agentId 或 type"})
	}
	list := getConstraints()
	incoming.ID = fmt.Sprintf("constraint-%d-%s", time.Now().UnixMilli(), randomSuffix())
	incoming.CreatedAt = time.Now().UnixMilli()
	list = append(list, incoming)
	if err := saveConstraints(list); err != nil {
		return toJSON(map[string]any{"error": err.Error()})
	}
	return toJSON(incoming)
}

func (a *App) UpdateConstraint(id, raw string) string {
	var updates map[string]any
	if err := json.Unmarshal([]byte(raw), &updates); err != nil {
		return toJSON(map[string]any{"error": err.Error()})
	}
	list := getConstraints()
	for i := range list {
		if list[i].ID != id {
			continue
		}
		applyConstraintUpdates(&list[i], updates)
		if err := saveConstraints(list); err != nil {
			return toJSON(map[string]any{"error": err.Error()})
		}
		return toJSON(list[i])
	}
	return "null"
}

// applyConstraintUpdates 只覆盖前端实际传上来的字段，避免把没提到的配置清零。
func applyConstraintUpdates(c *AgentConstraint, updates map[string]any) {
	if v, ok := updates["agentId"].(string); ok {
		c.AgentID = v
	}
	if v, ok := updates["type"].(string); ok {
		c.Type = v
	}
	if v, ok := updates["action"].(string); ok {
		c.Action = v
	}
	if v, ok := updates["enabled"].(bool); ok {
		c.Enabled = v
	}
	if raw, ok := updates["config"].(map[string]any); ok {
		if v, ok := raw["maxTokensPerDay"]; ok {
			c.Config.MaxTokensPerDay = int(intOf(v))
		}
		if v, ok := raw["maxCostPerDay"]; ok {
			c.Config.MaxCostPerDay = floatOf(v)
		}
		if v, ok := raw["allowedModels"].([]any); ok {
			c.Config.AllowedModels = stringSlice(v)
		}
		if v, ok := raw["allowedHours"].([]any); ok {
			hours := []int{}
			for _, item := range v {
				hours = append(hours, int(intOf(item)))
			}
			c.Config.AllowedHours = hours
		}
	}
}

func (a *App) DeleteConstraint(id string) string {
	list := getConstraints()
	kept := make([]AgentConstraint, 0, len(list))
	for _, c := range list {
		if c.ID != id {
			kept = append(kept, c)
		}
	}
	if len(kept) == len(list) {
		return toJSON(false)
	}
	if err := saveConstraints(kept); err != nil {
		return toJSON(map[string]any{"error": err.Error()})
	}
	return toJSON(true)
}

func (a *App) AgentConstraints(agentID string) string {
	out := []AgentConstraint{}
	for _, c := range getConstraints() {
		if c.AgentID == agentID && c.Enabled {
			out = append(out, c)
		}
	}
	return toJSON(out)
}

// checkConstraint 逐条判定；只在明确违反时产出 violation。
func checkConstraint(c AgentConstraint, ctx ConstraintContext) *ConstraintViolation {
	var message string
	switch c.Type {
	case "token-limit":
		limit := c.Config.MaxTokensPerDay
		if limit > 0 && ctx.TokensToday >= int64(limit) {
			message = fmt.Sprintf("Token 用量已达上限：%d / %d", ctx.TokensToday, limit)
		}
	case "model-whitelist":
		allowed := c.Config.AllowedModels
		if len(allowed) > 0 {
			ok := false
			for _, m := range allowed {
				if strings.Contains(ctx.Model, m) {
					ok = true
					break
				}
			}
			if !ok {
				message = fmt.Sprintf("模型不在白名单：%s，允许：%s", ctx.Model, strings.Join(allowed, ", "))
			}
		}
	case "cost-cap":
		cap := c.Config.MaxCostPerDay
		if cap > 0 && ctx.CostToday >= cap {
			message = fmt.Sprintf("成本已达上限：$%.2f / $%.2f", ctx.CostToday, cap)
		}
	case "time-window":
		if len(c.Config.AllowedHours) == 2 {
			from, to := c.Config.AllowedHours[0], c.Config.AllowedHours[1]
			hour := ctx.CurrentHour
			if !ctx.hasHour {
				hour = time.Now().Hour()
			}
			if hour < from || hour >= to {
				message = fmt.Sprintf("当前时间 %d:00 不在允许时段 %d:00-%d:00", hour, from, to)
			}
		}
	}
	if message == "" {
		return nil
	}
	return &ConstraintViolation{
		ConstraintID: c.ID, AgentID: c.AgentID, Type: c.Type, Action: c.Action,
		Message: message, Timestamp: time.Now().UnixMilli(),
	}
}

// validateConstraints 返回该智能体当前所有违反项。
func validateConstraints(agentID string, ctx ConstraintContext) []ConstraintViolation {
	out := []ConstraintViolation{}
	for _, c := range getConstraints() {
		if c.AgentID != agentID || !c.Enabled {
			continue
		}
		if v := checkConstraint(c, ctx); v != nil {
			out = append(out, *v)
		}
	}
	return out
}

// handleViolation 把违反项翻译成「是否放行 + 给用户看的话」。
func handleViolation(v ConstraintViolation) (bool, string) {
	switch v.Action {
	case "block":
		return false, "操作被阻止：" + v.Message
	case "warn":
		return true, "警告：" + v.Message
	default:
		return true, ""
	}
}

func (a *App) ValidateConstraints(agentID, ctxRaw string) string {
	var ctx ConstraintContext
	if ctxRaw != "" {
		var probe map[string]any
		if json.Unmarshal([]byte(ctxRaw), &probe) == nil {
			_ = json.Unmarshal([]byte(ctxRaw), &ctx)
			// 只有前端显式给了 currentHour 才用它，否则按本机当前时间判定
			_, ctx.hasHour = probe["currentHour"]
		}
	}
	violations := validateConstraints(agentID, ctx)
	allowed := true
	messages := []string{}
	for _, v := range violations {
		ok, msg := handleViolation(v)
		if !ok {
			allowed = false
		}
		if msg != "" {
			messages = append(messages, msg)
		}
	}
	return toJSON(map[string]any{
		"allowed": allowed, "violations": violations, "message": strings.Join(messages, "；"),
	})
}

// ---------- 信任度 ----------

func getTrustScores() []TrustScore { return readJSONList[TrustScore](trustScoresPath()) }

func saveTrustScores(list []TrustScore) error { return writeJSONList(trustScoresPath(), list) }

func (a *App) TrustScores() string { return toJSON(getTrustScores()) }

func (a *App) AgentTrustScore(agentID string) string {
	for _, s := range getTrustScores() {
		if s.AgentID == agentID {
			return toJSON(s)
		}
	}
	return "null"
}

// updateTrustScore：信任度 = 成功率*0.7 + 时间因子*0.3（1 分钟内完成为满分）。
func updateTrustScore(agentID string, success bool, durationMS float64) TrustScore {
	scores := getTrustScores()
	var target *TrustScore
	for i := range scores {
		if scores[i].AgentID == agentID {
			target = &scores[i]
			break
		}
	}
	if target == nil {
		scores = append(scores, TrustScore{
			AgentID: agentID, Score: 0.5, LastUpdated: time.Now().UnixMilli(),
		})
		target = &scores[len(scores)-1]
	}

	target.TotalTasks++
	if success {
		target.SuccessfulTasks++
	} else {
		target.FailedTasks++
	}
	const alpha = 0.1
	target.AvgDuration = target.AvgDuration*(1-alpha) + durationMS*alpha

	successRate := 0.5
	if target.TotalTasks > 0 {
		successRate = float64(target.SuccessfulTasks) / float64(target.TotalTasks)
	}
	timeFactor := 1 - target.AvgDuration/60000
	if timeFactor < 0 {
		timeFactor = 0
	}
	target.Score = successRate*0.7 + timeFactor*0.3
	target.LastUpdated = time.Now().UnixMilli()

	_ = saveTrustScores(scores)
	return *target
}

func (a *App) UpdateTrust(agentID string, success bool, durationMS float64) string {
	return toJSON(updateTrustScore(agentID, success, durationMS))
}

func recordFrictionPoint(point FrictionPoint) {
	points := readJSONList[FrictionPoint](frictionPointsPath())
	points = append(points, point)
	if len(points) > 1000 {
		points = points[len(points)-1000:]
	}
	_ = writeJSONList(frictionPointsPath(), points)
}

func (a *App) FrictionStats(agentID string) string {
	points := readJSONList[FrictionPoint](frictionPointsPath())
	byCategory := map[string]int{}
	total := 0
	for _, p := range points {
		if agentID != "" && p.AgentID != agentID {
			continue
		}
		total++
		byCategory[p.Category]++
	}
	return toJSON(map[string]any{"total": total, "byCategory": byCategory})
}

func (a *App) RankByTrust(agentIDs []string) string {
	scores := getTrustScores()
	byID := map[string]float64{}
	for _, s := range scores {
		byID[s.AgentID] = s.Score
	}
	out := make([]map[string]any, 0, len(agentIDs))
	for _, id := range agentIDs {
		score, ok := byID[id]
		if !ok {
			score = 0.5
		}
		out = append(out, map[string]any{"agentId": id, "score": score})
	}
	sort.SliceStable(out, func(i, j int) bool {
		return floatOf(out[i]["score"]) > floatOf(out[j]["score"])
	})
	return toJSON(out)
}

// randomSuffix 给 id 补一段随机尾巴，避免同一毫秒内创建的两条记录撞 id。
func randomSuffix() string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	n := time.Now().UnixNano()
	out := make([]byte, 7)
	for i := range out {
		out[i] = alphabet[n%int64(len(alphabet))]
		n /= int64(len(alphabet))
	}
	return string(out)
}
