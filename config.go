package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Upstream 既是上游连接配置，也是账号池里的一个可路由账号：
// 同一个模型可以挂多条记录（多家供应商、同一家的多个 key），由 router.go 选出候选。
type Upstream struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	BaseURL string `json:"baseURL"`
	APIKey  string `json:"apiKey"`
	Model   string `json:"model"`
	Kind    string `json:"kind"` // openai（默认）| anthropic

	// Models 为该账号可服务的模型列表；留空时回落到 Model，Model 也留空则视为通配。
	Models []string `json:"models,omitempty"`
	// Group 仅用于账号面板归类（同供应商的多条 key 可填同一个值）。
	Group string `json:"group,omitempty"`
	// Weight 为路由权重，0 视为 1；越大越优先被选中。
	Weight int `json:"weight,omitempty"`
	// MaxConcurrent 为单账号并发上限，0 视为不限。
	MaxConcurrent int  `json:"maxConcurrent,omitempty"`
	Enabled       bool `json:"enabled"`
}

const appVersion = "1.3.1"

// configSchema 随配置结构升级递增，loadConfig 据此决定是否先备份再迁移。
const configSchema = 2

type Price struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cacheRead"`
	CacheWrite float64 `json:"cacheWrite"`
}

type Config struct {
	SchemaVersion int              `json:"schemaVersion"`
	Port          int              `json:"port"`
	APIKey        string           `json:"apiKey"`
	Upstreams     []Upstream       `json:"upstreams"`
	RateUSDCNY    float64          `json:"rateUsdCny"`
	Prices        map[string]Price `json:"prices"`
	UpdateURL     string           `json:"updateUrl"`
}

const defaultUpdateURL = "https://cnb.cool/WeiGuangXunTu/AgentTower/-/releases/latest/download/latest.json"

func defaultPrices() map[string]Price {
	return map[string]Price{
		"gpt-4o":        {Input: 2.5, Output: 10, CacheRead: 1.25},
		"gpt-4o-mini":   {Input: 0.15, Output: 0.6, CacheRead: 0.075},
		"claude-sonnet": {Input: 3, Output: 15, CacheRead: 0.3, CacheWrite: 3.75},
		"deepseek-chat": {Input: 0.27, Output: 1.1, CacheRead: 0.07},
		"qwen":          {Input: 0.3, Output: 0.9},
		"glm":           {Input: 0.3, Output: 1.1},
	}
}

func configDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ".relay"
	}
	return filepath.Join(home, ".relay")
}

func configPath() string { return filepath.Join(configDir(), "config.json") }

func newAPIKey() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "atgw-relay-fallback"
	}
	return "atgw-" + base64.RawURLEncoding.EncodeToString(b)
}

func defaultConfig() *Config {
	return &Config{
		SchemaVersion: configSchema,
		Port:          8790,
		APIKey:        newAPIKey(),
		Upstreams:     []Upstream{},
		RateUSDCNY:    7.2,
		Prices:        defaultPrices(),
		UpdateURL:     defaultUpdateURL,
	}
}

// loadConfig 只在「文件存在但内容无法解析」时返回 error。
// 迁移写盘失败不算致命：已解析的配置照旧返回，failure 以 warning 形式交给调用方提示，
// 否则调用方会退回 defaultConfig()，用空上游 + 新 key 顶掉磁盘上的真实配置。
func loadConfig() (*Config, string, error) {
	b, err := os.ReadFile(configPath())
	if err != nil {
		cfg := defaultConfig()
		return cfg, "", cfg.save()
	}
	// 先解到空结构体，才能区分「字段缺失」与「默认值」——否则旧配置永远看不到 schemaVersion。
	cfg := &Config{}
	if err := json.Unmarshal(b, cfg); err != nil {
		return nil, "", err
	}
	older := cfg.SchemaVersion < configSchema
	cfg.applyDefaults()
	if !older {
		return cfg, "", nil
	}
	// 迁移前留一份原文件快照，写坏也能回退。
	if err := backupConfigFile(b); err != nil {
		return cfg, fmt.Sprintf("配置升级未能备份（%v），当前使用已解析的配置", err), nil
	}
	if err := cfg.save(); err != nil {
		return cfg, fmt.Sprintf("配置升级未能写回（%v），当前使用已解析的配置", err), nil
	}
	return cfg, "", nil
}

// applyDefaults 补齐缺失字段，并把 schema 之前的扁平上游规范化成账号池成员。
func (c *Config) applyDefaults() {
	if c.Port == 0 {
		c.Port = 8790
	}
	if c.RateUSDCNY == 0 {
		c.RateUSDCNY = 7.2
	}
	if c.APIKey == "" {
		c.APIKey = newAPIKey()
	}
	if c.Prices == nil {
		c.Prices = defaultPrices()
	}
	if c.UpdateURL == "" {
		c.UpdateURL = defaultUpdateURL
	}
	if c.Upstreams == nil {
		c.Upstreams = []Upstream{}
	}
	for i := range c.Upstreams {
		u := &c.Upstreams[i]
		if u.Kind == "" {
			u.Kind = "openai"
		}
		if len(u.Models) == 0 && u.Model != "" {
			u.Models = []string{u.Model}
		}
	}
	c.SchemaVersion = configSchema
}

func backupConfigFile(original []byte) error {
	path := filepath.Join(configDir(), fmt.Sprintf("config.json.bak-%d", time.Now().Unix()))
	return os.WriteFile(path, original, 0600)
}

func (c *Config) save() error {
	if err := os.MkdirAll(configDir(), 0700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(configPath(), append(b, '\n'), 0600)
}

func (c *Config) public() Config {
	out := *c
	out.APIKey = maskKey(out.APIKey)
	ups := make([]Upstream, len(out.Upstreams))
	copy(ups, out.Upstreams)
	for i := range ups {
		ups[i].APIKey = maskKey(ups[i].APIKey)
	}
	out.Upstreams = ups
	return out
}

func maskKey(s string) string {
	if s == "" {
		return ""
	}
	// 短 key 直接全遮：切片到 4 字符会 panic，设置页于是卡在「加载中」。
	if len(s) < 4 {
		return "****"
	}
	if len(s) <= 12 {
		return s[:4] + "****"
	}
	return s[:8] + "****" + s[len(s)-4:]
}

func (c *Config) upstreamByModel(model string) *Upstream {
	for i := range c.Upstreams {
		if c.Upstreams[i].serves(model) {
			return &c.Upstreams[i]
		}
	}
	return nil
}

// serves 判断该账号能否服务某个模型。显式声明的模型列表是权威：只要账号写了 Models，
// 就不再回落到旧的单模型字段与 ID/名称别名，否则用户把某个模型从列表里删掉后流量仍会打过去。
// 未声明任何模型（Models 与 Model 都空）的账号视为通配。
func (u *Upstream) serves(model string) bool {
	if !u.Enabled {
		return false
	}
	if model == "" {
		return true
	}
	if len(u.Models) > 0 {
		for _, m := range u.Models {
			if strings.EqualFold(m, model) {
				return true
			}
		}
		return false
	}
	if u.Model != "" {
		return strings.EqualFold(u.Model, model) ||
			strings.EqualFold(u.ID, model) || strings.EqualFold(u.Name, model)
	}
	return true
}

// weight 返回路由权重，0 视为 1，避免权重字段缺失的旧配置被排到所有账号之后。
func (u *Upstream) weight() int {
	if u.Weight <= 0 {
		return 1
	}
	return u.Weight
}

// servedModels 汇总该账号声明的模型（面板与 /v1/models 用）。
func (u *Upstream) servedModels() []string {
	if len(u.Models) > 0 {
		return u.Models
	}
	if u.Model != "" {
		return []string{u.Model}
	}
	return nil
}

// 按模型名最长子串匹配内置单价，返回每百万 token 的美元价格。
func (c *Config) priceFor(model string) (Price, bool) {
	key := strings.ToLower(model)
	best := ""
	for name := range c.Prices {
		if strings.Contains(key, strings.ToLower(name)) && len(name) > len(best) {
			best = name
		}
	}
	if best == "" {
		return Price{}, false
	}
	return c.Prices[best], true
}

func costUSD(c *Config, model string, in, out, cacheRead, cacheWrite int64) float64 {
	p, ok := c.priceFor(model)
	if !ok {
		return 0
	}
	return (float64(in)*p.Input + float64(out)*p.Output + float64(cacheRead)*p.CacheRead + float64(cacheWrite)*p.CacheWrite) / 1_000_000
}
