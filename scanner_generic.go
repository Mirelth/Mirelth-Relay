package main

import (
	"path/filepath"
	"strings"
)

// 通用探测位：Claude Code / Codex CLI / Gemini CLI / Cursor。
// 本机没装就自动隐藏，装了无需改代码即可识别。

type genericDef struct {
	id            string
	name          string
	vendor        string
	kind          string
	color         string
	probes        []string
	configPaths   []string
	dataDirs      [][2]string
	skillsDirs    []string
	mcpJSONPaths  []genericMcpSource
	projectDirs   []string
	installProbes []string
	installBins   []string
}

// genericMcpSource 描述「MCP 配置在哪个文件的哪个键下」。
type genericMcpSource struct {
	path string
	root string
}

func genericDefinitions() []genericDef {
	home := homeDir()
	return []genericDef{
		{
			id: "claude-code", name: "Claude Code", vendor: "Anthropic", kind: "cli", color: "#d97706",
			probes:      []string{filepath.Join(home, ".claude"), filepath.Join(home, ".claude.json")},
			installBins: []string{"claude"},
			configPaths: []string{filepath.Join(home, ".claude.json"), filepath.Join(home, ".claude/settings.json")},
			dataDirs: [][2]string{
				{filepath.Join(home, ".claude/projects"), "会话记录"},
				{filepath.Join(home, ".claude/skills"), "技能"},
				{filepath.Join(home, ".claude/plugins"), "插件"},
			},
			skillsDirs:   []string{filepath.Join(home, ".claude/skills")},
			mcpJSONPaths: []genericMcpSource{{path: filepath.Join(home, ".claude.json"), root: "mcpServers"}},
			projectDirs:  []string{filepath.Join(home, ".claude/projects")},
		},
		{
			id: "codex", name: "Codex CLI", vendor: "OpenAI", kind: "cli", color: "#22c55e",
			probes:      []string{filepath.Join(home, ".codex")},
			installBins: []string{"codex"},
			configPaths: []string{filepath.Join(home, ".codex/config.toml")},
			dataDirs: [][2]string{
				{filepath.Join(home, ".codex/sessions"), "会话记录"},
				{filepath.Join(home, ".codex"), "数据目录"},
			},
		},
		{
			id: "gemini-cli", name: "Gemini CLI", vendor: "Google", kind: "cli", color: "#0ea5e9",
			probes:       []string{filepath.Join(home, ".gemini")},
			installBins:  []string{"gemini"},
			configPaths:  []string{filepath.Join(home, ".gemini/settings.json")},
			dataDirs:     [][2]string{{filepath.Join(home, ".gemini"), "数据目录"}},
			mcpJSONPaths: []genericMcpSource{{path: filepath.Join(home, ".gemini/settings.json"), root: "mcpServers"}},
		},
		{
			id: "cursor", name: "Cursor", vendor: "Anysphere", kind: "ide", color: "#a3a3a3",
			probes: []string{
				filepath.Join(home, ".cursor"),
				filepath.Join(home, "Library/Application Support/Cursor"),
			},
			installProbes: appPaths("Cursor.app"),
			installBins:   []string{"cursor"},
			configPaths:   []string{filepath.Join(home, ".cursor/mcp.json")},
			dataDirs: [][2]string{
				{filepath.Join(home, ".cursor/extensions"), "扩展"},
				{filepath.Join(home, "Library/Application Support/Cursor/User"), "用户数据"},
			},
			mcpJSONPaths: []genericMcpSource{{path: filepath.Join(home, ".cursor/mcp.json"), root: "mcpServers"}},
		},
	}
}

type genericScanner struct{ def genericDef }

func (s genericScanner) Meta() ScannerMeta {
	d := s.def
	return ScannerMeta{
		ID: d.id, Name: d.name, Vendor: d.vendor, Kind: d.kind, Color: d.color,
		Probes: d.probes, InstallProbes: d.installProbes, InstallBins: d.installBins,
	}
}

func (s genericScanner) Scan() AgentSnapshot {
	def := s.def
	meta := s.Meta()
	detected := false
	for _, p := range def.probes {
		if exists(p) {
			detected = true
			break
		}
	}
	snap := emptySnapshot(meta, detected)
	if !detected {
		return snap
	}

	// TOML（Codex）不做解析：文件存在即列出，摘要留空——半吊子解析比不解析更容易误导。
	for _, p := range def.configPaths {
		info := ConfigFileInfo{Path: p}
		if strings.HasSuffix(p, ".toml") {
			info.Exists = exists(p)
			snap.Configs = append(snap.Configs, info)
			continue
		}
		raw := readJSON(p)
		if raw != nil {
			info.Exists = true
			info.Summary = redact(raw).(map[string]any)
		}
		snap.Configs = append(snap.Configs, info)
	}

	snap.DataDirs = dataDirs(def.dataDirs)
	for _, d := range def.skillsDirs {
		snap.Skills = append(snap.Skills, skillsFromDir(meta.ID, d, false)...)
	}

	for _, src := range def.mcpJSONPaths {
		raw := readJSON(src.path)
		if raw == nil {
			continue
		}
		var servers any = raw
		if src.root != "" {
			servers = raw[src.root]
		}
		snap.MCPServers = append(snap.MCPServers, mcpFromMap(servers, false)...)
	}

	for _, dir := range def.projectDirs {
		for _, d := range listDirs(dir) {
			// Claude Code 把 /Users/new/x 编码成 -Users-new-x
			decoded := filepath.Base(d)
			if strings.HasPrefix(decoded, "-") {
				snap.ProjectDirs = append(snap.ProjectDirs, strings.ReplaceAll(decoded, "-", "/"))
			}
		}
	}
	return finalize(snap)
}

func genericScanners() []Scanner {
	defs := genericDefinitions()
	out := make([]Scanner, 0, len(defs))
	for _, d := range defs {
		out = append(out, genericScanner{def: d})
	}
	return out
}
