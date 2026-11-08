package main

import (
	"path/filepath"
	"sort"
	"strings"
)

// 扫描器框架：从 Electron 侧 src/main/scanner/types.ts 移植。
// JSON 字段名必须与 frontend/src/shared/types.ts 保持一致——页面直接消费这些结构。

// AgentInfo 是智能体卡片的数据。
type AgentInfo struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Vendor string `json:"vendor,omitempty"`
	// Version 从应用包 Info.plist 读取，读不到就留空（不猜）。
	Version string `json:"version,omitempty"`
	// Kind 为 cli / ide / desktop。
	Kind     string `json:"kind"`
	Detected bool   `json:"detected"`
	// InstallState 为 installed（本体在）/ residual（本体不在但有数据）/ unknown（无可验证位置）。
	InstallState string `json:"installState"`
	SkillCount   int    `json:"skillCount"`
	McpCount     int    `json:"mcpCount"`
	HasUsage     bool   `json:"hasUsage"`
	ProjectCount int    `json:"projectCount"`
	Color        string `json:"color"`
}

type ConfigFileInfo struct {
	Path    string         `json:"path"`
	Exists  bool           `json:"exists"`
	Summary map[string]any `json:"summary"`
	Error   string         `json:"error,omitempty"`
}

type DataDirInfo struct {
	Path      string `json:"path"`
	Label     string `json:"label"`
	SizeBytes int64  `json:"sizeBytes"`
}

type SkillInfo struct {
	ID          string `json:"id"`
	AgentID     string `json:"agentId"`
	Name        string `json:"name"`
	Version     string `json:"version,omitempty"`
	Description string `json:"description,omitempty"`
	InstalledAt string `json:"installedAt,omitempty"`
	Source      string `json:"source"`
	Builtin     bool   `json:"builtin"`
}

type McpTool struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// RawMcp 是扫描产物，健康检查前 status 未定。
type RawMcp struct {
	Name         string    `json:"name"`
	Transport    string    `json:"transport"`
	Endpoint     string    `json:"endpoint,omitempty"`
	Enabled      bool      `json:"enabled"`
	Tools        []McpTool `json:"tools"`
	Status       string    `json:"status,omitempty"`
	StatusDetail string    `json:"statusDetail,omitempty"`
}

type UsageRecord struct {
	TS               int64   `json:"ts"`
	Model            string  `json:"model"`
	InputTokens      int64   `json:"inputTokens"`
	OutputTokens     int64   `json:"outputTokens"`
	CacheReadTokens  int64   `json:"cacheReadTokens"`
	CacheWriteTokens int64   `json:"cacheWriteTokens"`
	ReasoningTokens  int64   `json:"reasoningTokens"`
	Requests         int64   `json:"requests"`
	CostUSD          float64 `json:"costUsd,omitempty"`
}

type AgentSnapshot struct {
	Info        AgentInfo        `json:"info"`
	Configs     []ConfigFileInfo `json:"configs"`
	DataDirs    []DataDirInfo    `json:"dataDirs"`
	Skills      []SkillInfo      `json:"skills"`
	MCPServers  []RawMcp         `json:"mcpServers"`
	Usage       []UsageRecord    `json:"usage"`
	ProjectDirs []string         `json:"projectDirs"`
}

// ScannerMeta 描述一个适配器的元信息与「本体证据」。
type ScannerMeta struct {
	ID     string
	Name   string
	Vendor string
	Kind   string // cli / ide / desktop
	Color  string
	// Probes 是「这个智能体在此机器上有痕迹」的候选路径。
	Probes []string
	// InstallProbes 是程序本体证据（应用包等）：任一存在即判定已安装。
	InstallProbes []string
	// InstallBins 是 CLI 命令名，在 PATH 与常见安装目录里解析。
	InstallBins []string
	// InstallProbeResolver 在每次扫描时求值（如可移动卷上的 app 搜索）。
	InstallProbeResolver func() []string
}

type Scanner interface {
	Meta() ScannerMeta
	Scan() AgentSnapshot
}

// computeInstallState 是纯函数：没有可验证的本体位置 → unknown；
// 本体在 → installed；本体不在但有数据 → residual（多半已卸载，历史消耗仍要能看见）。
func computeInstallState(hasEvidence, programFound, dataFound bool) string {
	switch {
	case !hasEvidence:
		return "unknown"
	case programFound:
		return "installed"
	case dataFound:
		return "residual"
	default:
		return "unknown"
	}
}

// detectInstallState 由扫描引擎集中调用，避免每个适配器各写一遍。
func detectInstallState(meta ScannerMeta, dataFound bool) string {
	probes := append([]string{}, meta.InstallProbes...)
	if meta.InstallProbeResolver != nil {
		probes = append(probes, meta.InstallProbeResolver()...)
	}
	hasEvidence := len(probes) > 0 || len(meta.InstallBins) > 0
	programFound := false
	for _, p := range probes {
		if exists(p) {
			programFound = true
			break
		}
	}
	if !programFound {
		for _, bin := range meta.InstallBins {
			if resolveBin(bin) != "" {
				programFound = true
				break
			}
		}
	}
	return computeInstallState(hasEvidence, programFound, dataFound)
}

// appPaths 返回 macOS 应用包的系统级与用户级候选路径。
func appPaths(names ...string) []string {
	out := make([]string, 0, len(names)*2)
	for _, n := range names {
		out = append(out, filepath.Join("/Applications", n), filepath.Join(homeDir(), "Applications", n))
	}
	return out
}

func emptySnapshot(meta ScannerMeta, detected bool) AgentSnapshot {
	return AgentSnapshot{
		Info: AgentInfo{
			ID: meta.ID, Name: meta.Name, Vendor: meta.Vendor, Kind: meta.Kind,
			Detected: detected, InstallState: "unknown", Color: meta.Color,
		},
		Configs:     []ConfigFileInfo{},
		DataDirs:    []DataDirInfo{},
		Skills:      []SkillInfo{},
		MCPServers:  []RawMcp{},
		Usage:       []UsageRecord{},
		ProjectDirs: []string{},
	}
}

// skillID 保留 Electron 侧的 `agent:name:序号` 形态——同名技能可能同时存在于多个插件或目录。
func skillID(agentID, name string, seq int) string {
	return agentID + ":" + name + ":" + itoa(int64(seq))
}

// skillFromDir 把「一个装有 SKILL.md 的目录」变成一条技能记录；
// frontmatter 缺 name 时回落到目录名。
func skillFromDir(agentID, dir string, builtin bool, seq int) SkillInfo {
	meta := parseSkillFile(filepath.Join(dir, "SKILL.md"))
	name := meta.Name
	if name == "" {
		name = filepath.Base(dir)
	}
	return SkillInfo{
		ID: skillID(agentID, name, seq), AgentID: agentID, Name: name,
		Version: meta.Version, Description: meta.Description,
		InstalledAt: mtimeISO(dir), Source: dir, Builtin: builtin,
	}
}

// skillsFromDir 扫描目录下「每个子目录一个 skill」的布局（Claude Code / Codex 等的通用形态）。
func skillsFromDir(agentID, dir string, builtin bool) []SkillInfo {
	out := []SkillInfo{}
	for _, d := range listDirs(dir) {
		out = append(out, skillFromDir(agentID, d, builtin, len(out)+1))
	}
	return out
}

// dataDirs 只报告真实存在的目录，并把体积算好（-1 表示没算出来）。
func dataDirs(pairs [][2]string) []DataDirInfo {
	out := []DataDirInfo{}
	for _, p := range pairs {
		if !exists(p[0]) {
			continue
		}
		out = append(out, DataDirInfo{Path: p[0], Label: p[1], SizeBytes: dirSize(p[0])})
	}
	return out
}

// configFiles 读取并脱敏一组配置文件。
func configFiles(paths []string) []ConfigFileInfo {
	out := make([]ConfigFileInfo, 0, len(paths))
	for _, p := range paths {
		raw := readJSON(p)
		info := ConfigFileInfo{Path: p, Exists: raw != nil}
		if raw != nil {
			info.Summary = redact(raw).(map[string]any)
		}
		out = append(out, info)
	}
	return out
}

// finalize 统一补齐计数，避免每个适配器各写一遍。
func finalize(snap AgentSnapshot) AgentSnapshot {
	if snap.Skills == nil {
		snap.Skills = []SkillInfo{}
	}
	snap.Info.SkillCount = len(snap.Skills)
	snap.Info.McpCount = len(snap.MCPServers)
	snap.Info.HasUsage = len(snap.Usage) > 0
	dirs := map[string]bool{}
	for _, p := range snap.ProjectDirs {
		if p != "" {
			dirs[p] = true
		}
	}
	unique := make([]string, 0, len(dirs))
	for p := range dirs {
		unique = append(unique, p)
	}
	sort.Strings(unique)
	snap.ProjectDirs = unique
	snap.Info.ProjectCount = len(unique)
	return snap
}

// mcpFromMap 把各家配置里的 mcpServers / mcp 映射成扫描产物。
// 只认能判定的形态：有 url 视为 http，有 command 视为 stdio，其余 unknown。
// descAsDetail=true 时把配置里的 description 当 statusDetail（WorkBuddy 那种写法）。
func mcpFromMap(raw any, descAsDetail bool) []RawMcp {
	entries, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	names := make([]string, 0, len(entries))
	for name := range entries {
		names = append(names, name)
	}
	sort.Strings(names)

	out := make([]RawMcp, 0, len(names))
	for _, name := range names {
		entry, _ := entries[name].(map[string]any)
		endpoint, transport := "", "unknown"
		if url := strOf(entry["url"]); url != "" {
			endpoint, transport = url, "http"
		} else if cmd := mcpCommandLine(entry); cmd != "" {
			endpoint, transport = cmd, "stdio"
		}
		enabled := true
		if disabled, ok := entry["disabled"].(bool); ok && disabled {
			enabled = false
		}
		if on, ok := entry["enabled"].(bool); ok && !on {
			enabled = false
		}
		detail := ""
		if descAsDetail {
			detail = strOf(entry["description"])
		}
		out = append(out, RawMcp{
			Name: name, Transport: transport, Endpoint: endpoint, Enabled: enabled,
			Tools: []McpTool{}, Status: "unverified", StatusDetail: detail,
		})
	}
	return out
}

// mcpCommandLine 拼出完整的 stdio 命令行（command + args）。
// Electron 侧只取 command、丢掉 args，界面上会显示成光秃秃的 "npx"，这里补全。
func mcpCommandLine(entry map[string]any) string {
	parts := []string{}
	if cmd := commandString(entry["command"]); cmd != "" {
		parts = append(parts, cmd)
	}
	if args, ok := entry["args"].([]any); ok {
		for _, a := range args {
			if s := strOf(a); s != "" {
				parts = append(parts, s)
			}
		}
	}
	return strings.Join(parts, " ")
}

// commandString 兼容 command 是字符串或数组两种写法。
func commandString(v any) string {
	switch typed := v.(type) {
	case string:
		return typed
	case []any:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			if s := strOf(item); s != "" {
				parts = append(parts, s)
			}
		}
		return strings.Join(parts, " ")
	default:
		return ""
	}
}

// scanAll 逐个执行适配器：单个失败只记错误，不影响其他智能体。
type scanResult struct {
	Snapshots []AgentSnapshot
	Scanned   []string
	Errors    []string
}

func scanAll(filter string) scanResult {
	out := scanResult{Snapshots: []AgentSnapshot{}, Scanned: []string{}, Errors: []string{}}
	for _, s := range allScanners() {
		meta := s.Meta()
		if filter != "" && meta.ID != filter {
			continue
		}
		snap := s.Scan()
		snap.Info.InstallState = detectInstallState(meta, snap.Info.Detected)
		out.Snapshots = append(out.Snapshots, snap)
		out.Scanned = append(out.Scanned, meta.ID)
	}
	return out
}
