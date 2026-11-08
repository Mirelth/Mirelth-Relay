package main

import (
	"context"
	"encoding/json"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

type App struct {
	ctx        context.Context
	mu         sync.Mutex
	cfg        *Config
	store      *Store
	gw         *Gateway
	router     *Router
	startupErr string
	// configWarning 是非致命的配置问题（如升级写盘失败），以黄条形式提醒而不阻断启动。
	configWarning string
}

func NewApp() *App { return &App{} }

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	cfg, warning, err := loadConfig()
	if err != nil {
		a.startupErr = err.Error()
		cfg = defaultConfig()
	}
	a.configWarning = warning
	a.cfg = cfg

	st, err := openStore()
	if err != nil {
		a.startupErr = err.Error()
		return
	}
	a.store = st
	a.router = NewRouter(filepath.Join(configDir(), "state.json"))
	a.gw = newGateway(func() *Config { return a.cfg }, st, a.router)
	if err := a.gw.Start(); err != nil {
		a.startupErr = err.Error()
	}
	// 启动后后台扫一次：界面先出缓存，扫描完发事件刷新。
	go func() {
		a.scanAndCache("")
		if a.ctx != nil {
			runtime.EventsEmit(a.ctx, "scan:completed")
		}
	}()
}

// 窗口关闭后隐藏到后台，可由 Dock/菜单重新显示。
func (a *App) ShowWindow() {
	if a.ctx != nil {
		runtime.WindowShow(a.ctx)
	}
}

func (a *App) shutdown(_ context.Context) {
	if a.gw != nil {
		a.gw.Stop()
	}
	if a.store != nil {
		_ = a.store.Close()
	}
}

type SeriesPoint struct {
	Key      string  `json:"key"`
	Tokens   int64   `json:"tokens"`
	Requests int64   `json:"requests"`
	CostCNY  float64 `json:"costCny"`
}

type Overview struct {
	TodayTokens   int64         `json:"todayTokens"`
	WeekTokens    int64         `json:"weekTokens"`
	TotalTokens   int64         `json:"totalTokens"`
	TotalRequests int64         `json:"totalRequests"`
	EstCostCNY    float64       `json:"estCostCny"`
	ModelCount    int           `json:"modelCount"`
	GatewayAddr   string        `json:"gatewayAddr"`
	StartupError  string        `json:"startupError"`
	ConfigWarning string        `json:"configWarning"`
	Series        []SeriesPoint `json:"series"`
	TopModels     []SeriesPoint `json:"topModels"`
}

func (a *App) GetOverview() string {
	o := Overview{GatewayAddr: gatewayAddr(a.gw), StartupError: a.startupErr,
		ConfigWarning: a.configWarning,
		Series:        []SeriesPoint{}, TopModels: []SeriesPoint{}}
	if a.store == nil {
		return toJSON(o)
	}
	since := startOfDay().AddDate(0, 0, -13).UnixMilli()
	rows, err := a.store.RowsSince(since)
	if err != nil {
		o.StartupError = err.Error()
		return toJSON(o)
	}
	today := startOfDay().UnixMilli()
	week := startOfDay().AddDate(0, 0, -6).UnixMilli()
	models := map[string]bool{}
	for _, r := range rows {
		o.TotalTokens += r.Total()
		o.TotalRequests += r.Requests
		o.EstCostCNY += r.CostUSD * a.cfg.RateUSDCNY
		models[r.Model] = true
		if r.TS >= today {
			o.TodayTokens += r.Total()
		}
		if r.TS >= week {
			o.WeekTokens += r.Total()
		}
	}
	o.ModelCount = len(models)

	byDay := map[string]*SeriesPoint{}
	for i := 13; i >= 0; i-- {
		key := startOfDay().AddDate(0, 0, -i).Format("2006-01-02")
		byDay[key] = &SeriesPoint{Key: key}
	}
	for _, r := range rows {
		key := time.UnixMilli(r.TS).Format("2006-01-02")
		if p, ok := byDay[key]; ok {
			p.Tokens += r.Total()
			p.Requests += r.Requests
			p.CostCNY += r.CostUSD * a.cfg.RateUSDCNY
		}
	}
	for i := 13; i >= 0; i-- {
		key := startOfDay().AddDate(0, 0, -i).Format("2006-01-02")
		o.Series = append(o.Series, *byDay[key])
	}
	o.TopModels = topN(aggregate(rows, "model", a.cfg.RateUSDCNY), 8)
	return toJSON(o)
}

func (a *App) GetStats(dimension string, days int) string {
	if a.store == nil {
		return "[]"
	}
	if days <= 0 || days > 365 {
		days = 14
	}
	rows, err := a.store.RowsSince(startOfDay().AddDate(0, 0, -(days - 1)).UnixMilli())
	if err != nil {
		return "[]"
	}
	return toJSON(aggregate(rows, dimension, a.cfg.RateUSDCNY))
}

func (a *App) GetRecords(limit int) string {
	if a.store == nil {
		return "[]"
	}
	rows, err := a.store.Recent(limit)
	if err != nil {
		return "[]"
	}
	return toJSON(rows)
}

func (a *App) GetConfig() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.cfg == nil {
		return toJSON(defaultConfig().public())
	}
	return toJSON(a.cfg.public())
}

func (a *App) SaveConfig(raw string) string {
	var incoming Config
	if err := json.Unmarshal([]byte(raw), &incoming); err != nil {
		return toJSON(map[string]any{"ok": false, "error": err.Error()})
	}
	a.mu.Lock()
	old := a.cfg
	portChanged := old == nil || old.Port != incoming.Port
	if incoming.APIKey == "" || strings.Contains(incoming.APIKey, "****") {
		incoming.APIKey = old.APIKey
	}
	for i := range incoming.Upstreams {
		if incoming.Upstreams[i].APIKey == "" || strings.Contains(incoming.Upstreams[i].APIKey, "****") {
			if old != nil {
				for _, prev := range old.Upstreams {
					if prev.ID == incoming.Upstreams[i].ID {
						incoming.Upstreams[i].APIKey = prev.APIKey
						break
					}
				}
			}
		}
		if incoming.Upstreams[i].ID == "" {
			incoming.Upstreams[i].ID = newRequestID()
		}
	}
	if incoming.RateUSDCNY == 0 {
		incoming.RateUSDCNY = 7.2
	}
	// 前端可能回传上一版结构（无 schemaVersion / 无 models），这里统一补齐后再落盘。
	incoming.applyDefaults()
	if err := incoming.save(); err != nil {
		a.mu.Unlock()
		return toJSON(map[string]any{"ok": false, "error": err.Error()})
	}
	a.cfg = &incoming
	if a.router != nil {
		// 配置变更后顺手裁掉已删账号的冷却状态。
		a.router.Save(a.cfg)
	}
	a.mu.Unlock()

	if portChanged && a.gw != nil {
		a.gw.Stop()
		if err := a.gw.Start(); err != nil {
			return toJSON(map[string]any{"ok": false, "error": err.Error()})
		}
	}
	return toJSON(map[string]any{"ok": true, "gatewayAddr": gatewayAddr(a.gw)})
}

func (a *App) GetGatewayStatus() string {
	return toJSON(map[string]any{"running": gatewayAddr(a.gw) != "", "addr": gatewayAddr(a.gw)})
}

// GetTraces 返回最近的请求轨迹，供观测页渲染（包含每次尝试）。
func (a *App) GetTraces(limit int) string {
	if a.store == nil {
		return "[]"
	}
	traces, err := a.store.RecentTraces(limit)
	if err != nil {
		return "[]"
	}
	return toJSON(traces)
}

// GetTraceStats 汇总最近 minutes 分钟的请求数/失败数/重试数与平均耗时。
func (a *App) GetTraceStats(minutes int) string {
	if minutes <= 0 || minutes > 7*24*60 {
		minutes = 60
	}
	stats := TraceStats{}
	if a.store != nil {
		if got, err := a.store.TraceStats(time.Now().Add(-time.Duration(minutes) * time.Minute).UnixMilli()); err == nil {
			stats = got
		}
	}
	return toJSON(stats)
}

// GetGatewayAccounts 返回账号面板数据：散热状态 + 最近一小时成败。
func (a *App) GetGatewayAccounts() string {
	a.mu.Lock()
	cfg := a.cfg
	a.mu.Unlock()
	if a.router == nil || cfg == nil {
		return "[]"
	}
	snap := a.router.Snapshot(cfg)
	if a.store != nil {
		if stats, err := a.store.AccountAttemptStats(time.Now().Add(-time.Hour).UnixMilli()); err == nil {
			for i := range snap {
				if s, ok := stats[snap[i].ID]; ok {
					snap[i].OKCount = s.OK
					snap[i].FailCount = s.Fail
				}
			}
		}
	}
	return toJSON(snap)
}

func (a *App) RevealKey() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.cfg.APIKey
}

func (a *App) RegenerateKey() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.cfg.APIKey = newAPIKey()
	_ = a.cfg.save()
	return a.cfg.APIKey
}

func (a *App) OpenExternal(url string) {
	if a.ctx != nil && (strings.HasPrefix(url, "https://") || strings.HasPrefix(url, "http://")) {
		runtime.BrowserOpenURL(a.ctx, url)
	}
}

func gatewayAddr(g *Gateway) string {
	if g == nil {
		return ""
	}
	return g.Addr()
}

func aggregate(rows []UsageRow, dimension string, rate float64) []SeriesPoint {
	by := map[string]*SeriesPoint{}
	for _, r := range rows {
		key := r.Model
		switch dimension {
		case "day":
			key = time.UnixMilli(r.TS).Format("2006-01-02")
		case "source":
			key = r.Source
		}
		p := by[key]
		if p == nil {
			p = &SeriesPoint{Key: key}
			by[key] = p
		}
		p.Tokens += r.Total()
		p.Requests += r.Requests
		p.CostCNY += r.CostUSD * rate
	}
	out := make([]SeriesPoint, 0, len(by))
	for _, p := range by {
		out = append(out, *p)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Key == out[j].Key {
			return out[i].Tokens > out[j].Tokens
		}
		if dimension == "day" {
			return out[i].Key < out[j].Key
		}
		return out[i].Tokens > out[j].Tokens
	})
	return out
}

func topN(points []SeriesPoint, n int) []SeriesPoint {
	if len(points) > n {
		return points[:n]
	}
	return points
}

func startOfDay() time.Time {
	now := time.Now()
	return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
}

func toJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return "{}"
	}
	return string(b)
}
