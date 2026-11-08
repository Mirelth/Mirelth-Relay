package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// 单请求的尝试预算。参照 magpie 的实测形态：真实 failover 只在 429/5xx/超时/鉴权/模型缺失上发生，
// 且一个请求最多换几次账号，不会无限打下去。
const (
	maxTriesPerRequest = 3
	requestBudget      = 60 * time.Second
	headerWait         = 45 * time.Second
	retryAfterCap      = time.Hour
)

// errNoUpstream 表示没有任何启用账号声明能服务该模型。
var errNoUpstream = errors.New("no upstream serves this model")

// Attempt 是一次上游尝试的现场，既用于错误汇总，也是观测页轨迹的一行。
type Attempt struct {
	Index        int    `json:"index"`
	Account      string `json:"account"`
	AccountName  string `json:"accountName"`
	Model        string `json:"model"`
	Status       int    `json:"status"`
	MS           int64  `json:"ms"`
	TTFTMS       int64  `json:"ttftMs"`
	Error        string `json:"error,omitempty"`
	RetryAfterMS int64  `json:"retryAfterMs,omitempty"`
	CooldownMS   int64  `json:"cooldownMs,omitempty"`
	Skipped      bool   `json:"skipped,omitempty"`
}

// giveUpError 表示上游返回的是客户端自身的问题（4xx 非限流），不值得换账号，原样透给调用方。
type giveUpError struct {
	status int
	body   []byte
}

func (e *giveUpError) Error() string {
	return fmt.Sprintf("upstream rejected the request with HTTP %d", e.status)
}

// allFailedError 表示候选集里的账号都试过（或预算耗尽）仍无可用响应。
type allFailedError struct {
	model    string
	attempts []Attempt
}

func (e *allFailedError) Error() string {
	parts := make([]string, 0, len(e.attempts))
	for _, a := range e.attempts {
		switch {
		case a.Skipped:
			parts = append(parts, fmt.Sprintf("%s: skipped (%s)", a.AccountName, a.Error))
		case a.Status != 0:
			parts = append(parts, fmt.Sprintf("%s: HTTP %d", a.AccountName, a.Status))
		default:
			parts = append(parts, fmt.Sprintf("%s: %s", a.AccountName, a.Error))
		}
	}
	if len(parts) == 0 {
		return "every upstream account is cooling down"
	}
	return fmt.Sprintf("all upstreams failed for model %s (%s)", e.model, strings.Join(parts, "; "))
}

// committed 是一次已提交的尝试：响应头已判定为可用，body 还没交给客户端。
// cancel 与并发名额的归属一并移交，由调用方在读完后释放。
type committed struct {
	resp   *http.Response
	up     *Upstream
	cancel context.CancelFunc
	trace  Attempt
}

// dispatch 按候选顺序尝试上游，只在「拿到可用的响应头」时返回。
// 关键约束：在 commit 之前不向客户端写任何字节，所以换账号对调用方完全透明。
func (g *Gateway) dispatch(r *http.Request, cfg *Config, model string, payload map[string]any, stream bool) (*committed, []Attempt, error) {
	cands := g.router.Candidates(cfg, model)
	if len(cands) == 0 {
		return nil, nil, errNoUpstream
	}
	deadline := time.Now().Add(requestBudget)
	attempts := []Attempt{}
	tries := 0

	for _, cand := range cands {
		if tries >= maxTriesPerRequest || time.Now().After(deadline) {
			break
		}
		up := cand.Account
		rec := Attempt{Account: up.ID, AccountName: up.Name, Model: model}

		if !g.router.TryAcquire(up.ID, up.MaxConcurrent) {
			rec.Skipped = true
			rec.Error = "concurrency limit"
			attempts = append(attempts, rec)
			continue
		}
		tries++
		rec.Index = tries

		ctx, cancel := context.WithCancel(r.Context())
		req, err := buildUpstreamRequest(ctx, up, payload, stream)
		if err != nil {
			cancel()
			g.router.Release(up.ID)
			rec.Error = err.Error()
			attempts = append(attempts, rec)
			continue
		}

		begin := time.Now()
		// 只约束「多久拿到响应头」，这样流式 body 不会被整体超时切断。
		headerTO := time.AfterFunc(headerWait, cancel)
		resp, err := g.client.Do(req)
		headerTO.Stop()
		rec.MS = time.Since(begin).Milliseconds()

		if err != nil {
			cancel()
			g.router.Release(up.ID)
			rec.Error = err.Error()
			rec.CooldownMS = millis(g.router.NetworkFailed(up.ID, err.Error()))
			attempts = append(attempts, rec)
			continue
		}

		rec.Status = resp.StatusCode
		switch ClassifyStatus(resp.StatusCode) {
		case ClassSuccess:
			return &committed{resp: resp, up: up, cancel: cancel, trace: rec}, attempts, nil
		case ClassGiveUp:
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
			_ = resp.Body.Close()
			cancel()
			g.router.Release(up.ID)
			attempts = append(attempts, rec)
			return nil, attempts, &giveUpError{status: resp.StatusCode, body: body}
		default:
			_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
			_ = resp.Body.Close()
			cancel()
			g.router.Release(up.ID)
			retryAfter := parseRetryAfter(resp.Header.Get("Retry-After"))
			rec.RetryAfterMS = millis(retryAfter)
			rec.Error = strings.TrimSpace(http.StatusText(resp.StatusCode))
			rec.CooldownMS = millis(g.router.Failed(up.ID, model, resp.StatusCode, retryAfter, rec.Error))
			attempts = append(attempts, rec)
		}
	}

	return nil, attempts, &allFailedError{model: model, attempts: attempts}
}

// parseRetryAfter 支持上游常见的两种写法：秒数与 HTTP 日期。
func parseRetryAfter(v string) time.Duration {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0
	}
	d := time.Duration(0)
	if secs, err := strconv.Atoi(v); err == nil {
		if secs <= 0 {
			return 0
		}
		d = time.Duration(secs) * time.Second
	} else if at, err := http.ParseTime(v); err == nil {
		if left := time.Until(at); left > 0 {
			d = left
		}
	}
	if d > retryAfterCap {
		d = retryAfterCap
	}
	return d
}

func millis(d time.Duration) int64 {
	return d.Milliseconds()
}
