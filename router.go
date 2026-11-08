package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// 冷却与轮转参数。取值参照 magpie 的实测行为：失败账号进入冷却，冷却内的账号排到候选末尾，
// 429 优先服从上游的 Retry-After；连续失败按指数翻倍但设上限，避免一个坏 key 永久下线。
const (
	cooldownBase   = 30 * time.Second
	cooldownMax    = 10 * time.Minute
	authCooldown   = 10 * time.Minute
	unsupportedTTL = 10 * time.Minute
)

// Class 决定一次上游尝试失败后该怎么走。
type Class int

const (
	// ClassSuccess 2xx：可以提交给客户端。
	ClassSuccess Class = iota
	// ClassRetryAccount 换下一个账号再试（限流、上游故障、鉴权、模型不存在、网络错误）。
	ClassRetryAccount
	// ClassGiveUp 客户端自身的错误：把上游响应原样透给客户端，不要再换账号。
	ClassGiveUp
)

// ClassifyStatus 把上游状态码归类。只有明确属于「账号/上游侧」的失败才值得换账号重试。
func ClassifyStatus(status int) Class {
	switch {
	case status >= 200 && status < 300:
		return ClassSuccess
	case status == 408, status == 429:
		return ClassRetryAccount
	case status == 401, status == 403:
		return ClassRetryAccount
	case status == 404:
		// 大多数兼容上游用 404 表示「这个账号没有这个模型」。
		return ClassRetryAccount
	case status >= 500 && status < 600:
		return ClassRetryAccount
	default:
		return ClassGiveUp
	}
}

// AccountState 是一个账号的运行期状态，会被持久化到 state.json，
// 让进程重启后不会立刻把已知的坏账号重新打一遍。
type AccountState struct {
	CooldownUntil    int64            `json:"cooldownUntil,omitempty"`
	LastServedAt     int64            `json:"lastServedAt,omitempty"`
	ConsecutiveFails int              `json:"consecutiveFails,omitempty"`
	AuthFailAt       int64            `json:"authFailAt,omitempty"`
	LastStatus       int              `json:"lastStatus,omitempty"`
	LastError        string           `json:"lastError,omitempty"`
	Unsupported      map[string]int64 `json:"unsupported,omitempty"`
}

// Candidate 是候选集里的一项，附带足够解释「为什么排在这里」的现场信息。
type Candidate struct {
	Account      *Upstream
	Cooling      bool
	CooldownMS   int64
	Fails        int
	LastServedAt int64
}

// Router 负责候选排序、冷却记账与单账号并发限流。所有方法可并发调用。
type Router struct {
	mu       sync.Mutex
	states   map[string]*AccountState
	inflight map[string]int
	path     string
	now      func() time.Time
}

// NewRouter 从磁盘恢复状态；文件缺失或损坏都不影响启动（坏文件按空状态处理）。
func NewRouter(path string) *Router {
	r := &Router{
		states:   map[string]*AccountState{},
		inflight: map[string]int{},
		path:     path,
		now:      time.Now,
	}
	if b, err := os.ReadFile(path); err == nil {
		var saved map[string]*AccountState
		if json.Unmarshal(b, &saved) == nil {
			for id, st := range saved {
				if st != nil {
					r.states[id] = st
				}
			}
		}
	}
	return r
}

func (r *Router) stateLocked(id string) *AccountState {
	st := r.states[id]
	if st == nil {
		st = &AccountState{}
		r.states[id] = st
	}
	return st
}

// Candidates 返回该模型当前可路由的账号，已按尝试顺序排好：
// 不在冷却的优先，其次权重高、最近服务时间早（轮转公平）、连续失败少。
// 声明不支持该模型的账号直接排除。
func (r *Router) Candidates(cfg *Config, model string) []Candidate {
	if cfg == nil {
		return nil
	}
	now := r.now().UnixMilli()
	r.mu.Lock()
	defer r.mu.Unlock()

	out := make([]Candidate, 0, len(cfg.Upstreams))
	for i := range cfg.Upstreams {
		u := &cfg.Upstreams[i]
		if !u.serves(model) {
			continue
		}
		st := r.states[u.ID]
		if st == nil {
			st = &AccountState{}
		}
		if until, bad := st.Unsupported[model]; bad && until > now {
			continue
		}
		c := Candidate{Account: u, Fails: st.ConsecutiveFails, LastServedAt: st.LastServedAt}
		if st.CooldownUntil > now {
			c.Cooling = true
			c.CooldownMS = st.CooldownUntil - now
		}
		out = append(out, c)
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Cooling != b.Cooling {
			return !a.Cooling
		}
		if a.Cooling && a.CooldownMS != b.CooldownMS {
			// 全都在冷却时，先试最早解冻的。
			return a.CooldownMS < b.CooldownMS
		}
		if a.Account.weight() != b.Account.weight() {
			return a.Account.weight() > b.Account.weight()
		}
		if a.LastServedAt != b.LastServedAt {
			return a.LastServedAt < b.LastServedAt
		}
		if a.Fails != b.Fails {
			return a.Fails < b.Fails
		}
		return a.Account.ID < b.Account.ID
	})
	return out
}

// Served 记录一次成功：清冷却、清连续失败、更新最近服务时间。
func (r *Router) Served(id string, status int) {
	r.mu.Lock()
	st := r.stateLocked(id)
	st.CooldownUntil = 0
	st.ConsecutiveFails = 0
	st.AuthFailAt = 0
	st.LastServedAt = r.now().UnixMilli()
	st.LastStatus = status
	st.LastError = ""
	r.saveLocked()
	r.mu.Unlock()
}

// Failed 记录一次失败并算出该账号的冷却：
// 401/403 是鉴权问题，固定长冷却；404 只标记「该账号没有这个模型」，不封账号；
// 其余按连续失败次数指数退避，Retry-After 优先于自算值。
func (r *Router) Failed(id, model string, status int, retryAfter time.Duration, errText string) time.Duration {
	r.mu.Lock()
	defer r.mu.Unlock()
	st := r.stateLocked(id)
	now := r.now()
	st.LastStatus = status
	st.LastError = errText
	if st.Unsupported == nil {
		st.Unsupported = map[string]int64{}
	}

	var wait time.Duration
	switch status {
	case 401, 403:
		st.AuthFailAt = now.UnixMilli()
		wait = authCooldown
	case 404:
		st.Unsupported[model] = now.Add(unsupportedTTL).UnixMilli()
		wait = 0
	default:
		st.ConsecutiveFails++
		wait = cooldownBase << min(st.ConsecutiveFails-1, 8)
		if wait > cooldownMax || wait <= 0 {
			wait = cooldownMax
		}
		if retryAfter > wait {
			wait = retryAfter
		}
	}
	if wait > 0 {
		st.CooldownUntil = now.Add(wait).UnixMilli()
	}
	r.saveLocked()
	return wait
}

// NetworkFailed 记录一次连接层面的失败（超时、拒连、读响应头前断开）。
func (r *Router) NetworkFailed(id, errText string) time.Duration {
	return r.Failed(id, "", 0, 0, errText)
}

// FailDelay 返回该账号当前的冷却剩余时间，供测试与面板使用。
func (r *Router) FailDelay(id string) time.Duration {
	r.mu.Lock()
	defer r.mu.Unlock()
	st := r.states[id]
	if st == nil || st.CooldownUntil == 0 {
		return 0
	}
	left := time.UnixMilli(st.CooldownUntil).Sub(r.now())
	if left < 0 {
		return 0
	}
	return left
}

// TryAcquire 取一个并发名额。limit<=0 表示不限。
func (r *Router) TryAcquire(id string, limit int) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if limit > 0 && r.inflight[id] >= limit {
		return false
	}
	r.inflight[id]++
	return true
}

// Release 归还并发名额。
func (r *Router) Release(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.inflight[id] > 0 {
		r.inflight[id]--
	}
}

// Inflight 返回账号当前占用中的并发数。
func (r *Router) Inflight(id string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.inflight[id]
}

// AccountSnapshot 是账号面板的一行。
type AccountSnapshot struct {
	ID               string   `json:"id"`
	Name             string   `json:"name"`
	Group            string   `json:"group"`
	Models           []string `json:"models"`
	Enabled          bool     `json:"enabled"`
	Weight           int      `json:"weight"`
	MaxConcurrent    int      `json:"maxConcurrent"`
	Inflight         int      `json:"inflight"`
	CoolingForMS     int64    `json:"coolingForMs"`
	AuthFailed       bool     `json:"authFailed"`
	ConsecutiveFails int      `json:"consecutiveFails"`
	LastServedAt     int64    `json:"lastServedAt"`
	LastStatus       int      `json:"lastStatus"`
	LastError        string   `json:"lastError"`
	// 近一小时的尝试成败数（来自 gw_attempt）。
	OKCount   int64 `json:"okCount"`
	FailCount int64 `json:"failCount"`
}

// Snapshot 输出账号面板需要的全部状态，同时按配置顺序保留已下线账号的现场。
func (r *Router) Snapshot(cfg *Config) []AccountSnapshot {
	now := r.now().UnixMilli()
	r.mu.Lock()
	defer r.mu.Unlock()
	out := []AccountSnapshot{}
	if cfg == nil {
		return out
	}
	for i := range cfg.Upstreams {
		u := &cfg.Upstreams[i]
		st := r.states[u.ID]
		if st == nil {
			st = &AccountState{}
		}
		row := AccountSnapshot{
			ID: u.ID, Name: u.Name, Group: u.Group, Models: u.servedModels(),
			Enabled: u.Enabled, Weight: u.weight(), MaxConcurrent: u.MaxConcurrent,
			Inflight: r.inflight[u.ID], ConsecutiveFails: st.ConsecutiveFails,
			LastServedAt: st.LastServedAt, LastStatus: st.LastStatus, LastError: st.LastError,
			AuthFailed: st.AuthFailAt > 0,
		}
		if st.CooldownUntil > now {
			row.CoolingForMS = st.CooldownUntil - now
		}
		out = append(out, row)
	}
	return out
}

// prune 丢掉配置里已不存在的账号状态，避免 state.json 无限增长。
func (r *Router) pruneLocked(cfg *Config) {
	if cfg == nil {
		return
	}
	alive := make(map[string]bool, len(cfg.Upstreams))
	for i := range cfg.Upstreams {
		alive[cfg.Upstreams[i].ID] = true
	}
	for id := range r.states {
		if !alive[id] {
			delete(r.states, id)
		}
	}
}

// Save 主动落盘（配置变更后调用，顺便裁掉已删除账号的状态）。
func (r *Router) Save(cfg *Config) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.pruneLocked(cfg)
	r.saveLocked()
}

// saveLocked 先写临时文件再改名，避免半截 JSON 让下次启动丢掉全部冷却状态。
func (r *Router) saveLocked() {
	if r.path == "" {
		return
	}
	b, err := json.Marshal(r.states)
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(r.path), 0700); err != nil {
		return
	}
	tmp := r.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0600); err != nil {
		return
	}
	_ = os.Rename(tmp, r.path)
}
