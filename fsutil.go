package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// 这一层从 Electron 侧的 src/main/lib/fs.ts 移植而来，语义逐条对齐：
// 读取失败一律返回零值而不是报错（扫描器要能跳过任意一个坏文件继续跑），
// 只有「准备写配置」这条路径才用 error 表达「必须停下并向用户解释」。

func homeDir() string {
	if h := os.Getenv("HOME"); h != "" {
		return h
	}
	if h, err := os.UserHomeDir(); err == nil {
		return h
	}
	return "."
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func isDir(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

func readText(p string) (string, bool) {
	b, err := os.ReadFile(p)
	if err != nil {
		return "", false
	}
	return string(b), true
}

// readJSON 读标准 JSON；文件不存在或解析失败都返回 nil。
func readJSON(p string) map[string]any {
	text, ok := readText(p)
	if !ok {
		return nil
	}
	return decodeJSONObject([]byte(text))
}

var (
	blockComment = regexp.MustCompile(`(?s)/\*.*?\*/`)
	lineComment  = regexp.MustCompile(`(?m)(^|[^:"'\\])//.*$`)
	leadingBOM   = regexp.MustCompile(`^\x{FEFF}`)
)

// readJSONC 先按标准 JSON 解，失败再剥掉注释重试（OpenCode 的 opencode.jsonc 就是这种文件）。
func readJSONC(p string) map[string]any {
	text, ok := readText(p)
	if !ok {
		return nil
	}
	if v := decodeJSONObject([]byte(text)); v != nil {
		return v
	}
	stripped := leadingBOM.ReplaceAllString(text, "")
	stripped = blockComment.ReplaceAllString(stripped, "")
	stripped = lineComment.ReplaceAllString(stripped, "$1")
	return decodeJSONObject([]byte(stripped))
}

func decodeJSONObject(b []byte) map[string]any {
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		return nil
	}
	obj, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	return obj
}

// readYAML 读 YAML 配置；非映射结构（如纯数组）按「不是对象」返回 nil，与 JS 侧的判空一致。
func readYAML(p string) map[string]any {
	text, ok := readText(p)
	if !ok {
		return nil
	}
	var v any
	if err := yaml.Unmarshal([]byte(text), &v); err != nil {
		return nil
	}
	obj, _ := normalizeYAML(v).(map[string]any)
	return obj
}

// normalizeYAML 把 yaml.v3 的 map[string]any / map[any]any 统一成 JSON 风格，
// 避免下游要处理两种映射类型。
func normalizeYAML(v any) any {
	switch typed := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for k, val := range typed {
			out[k] = normalizeYAML(val)
		}
		return out
	case map[any]any:
		out := make(map[string]any, len(typed))
		for k, val := range typed {
			out[fmt.Sprint(k)] = normalizeYAML(val)
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for i, val := range typed {
			out[i] = normalizeYAML(val)
		}
		return out
	default:
		return v
	}
}

func listDirs(p string) []string {
	entries, err := os.ReadDir(p)
	if err != nil {
		return nil
	}
	out := []string{}
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		out = append(out, filepath.Join(p, e.Name()))
	}
	sort.Strings(out)
	return out
}

func listEntries(p string) []string {
	entries, err := os.ReadDir(p)
	if err != nil {
		return nil
	}
	out := []string{}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".") {
			continue
		}
		out = append(out, e.Name())
	}
	sort.Strings(out)
	return out
}

// dirSize 递归统计目录字节数；上限 6 层、跳过 node_modules；出错返回 -1（前端显示「未统计」）。
func dirSize(p string) int64 { return dirSizeAt(p, 0) }

func dirSizeAt(p string, depth int) int64 {
	if depth > 6 {
		return 0
	}
	st, err := os.Stat(p)
	if err != nil {
		return -1
	}
	if !st.IsDir() {
		return st.Size()
	}
	entries, err := os.ReadDir(p)
	if err != nil {
		return -1
	}
	var total int64
	for _, e := range entries {
		if e.Name() == "node_modules" {
			continue
		}
		size := dirSizeAt(filepath.Join(p, e.Name()), depth+1)
		if size > 0 {
			total += size
		}
	}
	return total
}

// binSearchDirs 返回查找可执行文件的目录：PATH + CLI 工具常见安装位置。
// 从 Finder/Dock 启动的 app 拿不到用户 shell 里的补充 PATH，所以必须自己兜这几条。
func binSearchDirs() []string {
	dirs := []string{}
	for _, d := range strings.Split(os.Getenv("PATH"), ":") {
		if d != "" {
			dirs = append(dirs, d)
		}
	}
	home := homeDir()
	dirs = append(dirs,
		filepath.Join(home, ".local/bin"),
		filepath.Join(home, "go/bin"),
		filepath.Join(home, ".cargo/bin"),
		filepath.Join(home, ".npm-global/bin"),
		filepath.Join(home, ".bun/bin"),
		filepath.Join(home, ".volta/bin"),
		filepath.Join(home, "bin"),
		"/opt/homebrew/bin",
		"/usr/local/bin",
	)
	return dirs
}

// resolveBin 在 PATH 与常见目录里找可执行文件，找不到返回空串。
func resolveBin(name string) string {
	if name == "" {
		return ""
	}
	if strings.ContainsRune(name, os.PathSeparator) {
		if isExecutable(name) {
			return name
		}
		return ""
	}
	for _, dir := range binSearchDirs() {
		candidate := filepath.Join(dir, name)
		if isExecutable(candidate) {
			return candidate
		}
	}
	return ""
}

func isExecutable(p string) bool {
	st, err := os.Stat(p)
	if err != nil || st.IsDir() {
		return false
	}
	return st.Mode()&0111 != 0
}

// findAppOnVolumes 在 /Volumes 下浅层（默认 ≤4 层、每层最多 150 个条目）找 .app 包。
// 有人把绿色分发的应用直接放在挂载卷里跑，静态探测路径覆盖不到。
func findAppOnVolumes(appName string, maxDepth int) string {
	if maxDepth <= 0 {
		maxDepth = 4
	}
	vols, err := os.ReadDir("/Volumes")
	if err != nil {
		return ""
	}
	type node struct {
		path  string
		depth int
	}
	stack := []node{}
	for _, v := range vols {
		if strings.HasPrefix(v.Name(), ".") {
			continue
		}
		stack = append(stack, node{filepath.Join("/Volumes", v.Name()), 0})
	}
	for len(stack) > 0 {
		cur := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if filepath.Base(cur.path) == appName {
			if isDir(cur.path) {
				return cur.path
			}
			continue
		}
		if cur.depth >= maxDepth {
			continue
		}
		entries, err := os.ReadDir(cur.path)
		if err != nil {
			continue
		}
		count := 0
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), ".") {
				continue
			}
			if count >= 150 {
				break
			}
			count++
			stack = append(stack, node{filepath.Join(cur.path, e.Name()), cur.depth + 1})
		}
	}
	return ""
}

// decompressZstdFile 用 zstd CLI 解压整份文件（多帧自动连解）。
// 不走内置库：Electron 侧实测内置 zstd 在 DSH 会话文件上会触发原生断言直接杀进程，
// 子进程失败最多返回空串。
func decompressZstdFile(path string) string {
	candidates := []string{resolveBin("zstd"),
		filepath.Join(homeDir(), "opt/python/bin/zstd"),
		"/opt/homebrew/bin/zstd", "/usr/local/bin/zstd"}
	for _, bin := range candidates {
		if bin == "" || !isExecutable(bin) {
			continue
		}
		out, err := runWithTimeout(60*time.Second, bin, "-dc", path)
		if err != nil {
			continue
		}
		return out
	}
	return ""
}

func runWithTimeout(timeout time.Duration, bin string, args ...string) (string, error) {
	cmd := exec.Command(bin, args...)
	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		return "", err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			return "", err
		}
		return buf.String(), nil
	case <-time.After(timeout):
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		<-done
		return "", errors.New("命令超时")
	}
}

// ---------- 凭据脱敏 ----------

var (
	sensitiveKey   = regexp.MustCompile(`(?i)key|token|secret|password|credential|authorization`)
	sensitiveValue = regexp.MustCompile(`^(sk|ghp|gho|xox|eyJ)[\w-]{12,}`)
)

// redact 深拷贝并脱敏：疑似凭据的字段只留末 4 位，疑似 key 的字面量整段替换。
// 上限 8 层、数组最多 20 项，防止病态配置把内存撑爆。
func redact(v any) any { return redactAt(v, 0) }

func redactAt(v any, depth int) any {
	if depth > 8 {
		return "…"
	}
	switch typed := v.(type) {
	case []any:
		limit := len(typed)
		if limit > 20 {
			limit = 20
		}
		out := make([]any, limit)
		for i := 0; i < limit; i++ {
			out[i] = redactAt(typed[i], depth+1)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(typed))
		for k, val := range typed {
			if s, ok := val.(string); ok && len(s) > 4 && sensitiveKey.MatchString(k) {
				out[k] = "••••••••" + s[len(s)-4:]
				continue
			}
			out[k] = redactAt(val, depth+1)
		}
		return out
	case string:
		if sensitiveValue.MatchString(typed) {
			return "••••••••"
		}
		return typed
	default:
		return v
	}
}

// ---------- SKILL.md ----------

type skillMeta struct {
	Name        string
	Description string
	Version     string
}

var skillFrontmatter = regexp.MustCompile(`(?s)^---\r?\n(.*?)\r?\n---`)
var skillLine = regexp.MustCompile(`^(name|description|version):\s*(.+?)\s*$`)

// parseSkillFile 只取 frontmatter 里的三个字段，其余键（含列表）不在列表页展示。
func parseSkillFile(p string) skillMeta {
	var meta skillMeta
	text, ok := readText(p)
	if !ok {
		return meta
	}
	m := skillFrontmatter.FindStringSubmatch(text)
	if len(m) < 2 {
		return meta
	}
	for _, line := range strings.Split(m[1], "\n") {
		kv := skillLine.FindStringSubmatch(strings.TrimRight(line, "\r"))
		if len(kv) < 3 {
			continue
		}
		val := strings.Trim(strings.TrimSpace(kv[2]), `"'`)
		switch kv[1] {
		case "name":
			meta.Name = val
		case "description":
			meta.Description = val
		case "version":
			meta.Version = val
		}
	}
	return meta
}

// mtimeISO 用修改时间充当「安装时间」的参考值。
func mtimeISO(p string) string {
	st, err := os.Stat(p)
	if err != nil {
		return ""
	}
	return st.ModTime().Format(time.RFC3339)
}

// ---------- 安全写：解析失败拒写 + 校验失败自动回滚 ----------

// errConfigWrite 表示「必须停下并向用户解释」的写入异常。
var errConfigWrite = errors.New("配置写入被中止")

type configWriteError struct{ reason string }

func (e *configWriteError) Error() string { return e.reason }
func (e *configWriteError) Unwrap() error { return errConfigWrite }

func configWriteErr(format string, args ...any) error {
	return &configWriteError{reason: fmt.Sprintf(format, args...)}
}

// loadForWrite 写入前读原配置：文件存在但解析失败或不是对象 → 报错拒写，
// 绝不允许静默降级成空对象把用户已有配置整体覆盖。文件不存在返回空对象供新建。
func loadForWrite(p string, read func(string) map[string]any) (map[string]any, error) {
	parsed := read(p)
	if parsed == nil {
		if exists(p) {
			return nil, configWriteErr("无法解析现有配置（文件格式可能已变更），已中止写入，原文件未做任何改动")
		}
		return map[string]any{}, nil
	}
	return parsed, nil
}

// commitWithVerify 备份 → 写入 → 回读校验；校验不过自动从备份回滚（新建文件则删除）。
// 返回备份文件路径（原来没有文件时为空串）。
func commitWithVerify(p string, write func() error, read func(string) map[string]any) (string, error) {
	bak := ""
	if exists(p) {
		bak = fmt.Sprintf("%s.agentmgr-bak-%d", p, time.Now().UnixMilli())
		if err := copyFile(p, bak); err != nil {
			return "", configWriteErr("备份原配置失败：%v", err)
		}
	}
	var failure error
	if err := write(); err != nil {
		failure = err
	} else if read(p) == nil {
		failure = configWriteErr("写入后回读校验失败")
	}
	if failure == nil {
		return bak, nil
	}
	if bak != "" {
		if err := copyFile(bak, p); err != nil {
			return bak, configWriteErr("写入校验失败，且回滚失败（备份保留在 %s）", bak)
		}
		return bak, configWriteErr("写入校验失败，已自动回滚原配置")
	}
	_ = os.Remove(p)
	return "", configWriteErr("写入校验失败，已撤销本次新建")
}

func copyFile(from, to string) error {
	b, err := os.ReadFile(from)
	if err != nil {
		return err
	}
	return os.WriteFile(to, b, 0600)
}

// readAppBundleVersion 读 macOS 应用包版本（Info.plist 为 XML，借 plutil 转 JSON）。
func readAppBundleVersion(appPath string) string {
	plist := filepath.Join(appPath, "Contents", "Info.plist")
	if !exists(plist) {
		return ""
	}
	out, err := runWithTimeout(3*time.Second, "plutil", "-convert", "json", "-o", "-", plist)
	if err != nil {
		return ""
	}
	obj := decodeJSONObject([]byte(out))
	if v, ok := obj["CFBundleShortVersionString"].(string); ok {
		return v
	}
	return ""
}
