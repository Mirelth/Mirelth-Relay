package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// 安全体检（只读）：从 Electron 的 src/main/security.ts 移植。
// 检查智能体配置与常见凭证文件里的明文密钥与过宽权限；输出永不含完整密钥。

type SecretHit struct {
	Line   int    `json:"line"`
	Masked string `json:"masked"`
	Kind   string `json:"kind"`
}

type SecurityFinding struct {
	ID        string `json:"id"`
	Severity  string `json:"severity"`
	Category  string `json:"category"`
	AgentID   string `json:"agentId,omitempty"`
	AgentName string `json:"agentName,omitempty"`
	Path      string `json:"path"`
	Line      int    `json:"line,omitempty"`
	Kind      string `json:"kind"`
	Snippet   string `json:"snippet"`
	Advice    string `json:"advice"`
}

type SecurityScanResult struct {
	At           string            `json:"at"`
	ScannedFiles int               `json:"scannedFiles"`
	Findings     []SecurityFinding `json:"findings"`
	CheckedPaths int               `json:"checkedPaths"`
}

// CandidateFile 是一条待检查的文件（带上来源智能体便于定位）。
type CandidateFile struct {
	Path      string
	AgentID   string
	AgentName string
}

type namedPattern struct {
	kind string
	re   *regexp.Regexp
}

var namedPatterns = []namedPattern{
	{"Anthropic 密钥", regexp.MustCompile(`\bsk-ant-[A-Za-z0-9_-]{16,}\b`)},
	{"OpenAI 风格密钥", regexp.MustCompile(`\bsk-[A-Za-z0-9_-]{16,}\b`)},
	{"GitHub Token", regexp.MustCompile(`\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b`)},
	{"GitHub 细粒度 Token", regexp.MustCompile(`\bgithub_pat_[A-Za-z0-9_]{22,}\b`)},
	{"AWS AccessKey", regexp.MustCompile(`\bAKIA[0-9A-Z]{16}\b`)},
	{"阿里云 AccessKey", regexp.MustCompile(`\bLTAI[A-Za-z0-9]{12,22}\b`)},
	{"Slack Token", regexp.MustCompile(`\bxox[baprs]-[A-Za-z0-9-]{10,}\b`)},
	{"Google API Key", regexp.MustCompile(`\bAIza[0-9A-Za-z_-]{35}\b`)},
	{"Stripe 密钥", regexp.MustCompile(`\b[ps]k_(?:live|test)_[A-Za-z0-9]{20,}\b`)},
	{"GitLab Token", regexp.MustCompile(`\bglpat-[A-Za-z0-9_-]{20,}\b`)},
}

// kvPattern 抓 key: "value" / key = 'value' 形态，且键名本身暗示凭证。
var kvPattern = regexp.MustCompile(`(?i)["']?(api[-_]?key|access[-_]?key|access[-_]?token|auth[-_]?token|secret[-_]?key|client[-_]?secret|private[-_]?token|password|passwd)["']?\s*[:=]\s*["']([^"']{16,})["']`)

// placeholderPattern 排除示例值，避免把文档里的占位符报成泄露。
var placeholderPattern = regexp.MustCompile(`(?i)(your[_-]|_?example|placeholder|changeme|dummy|test[-_]?key|x{4,}|\$\{|<[a-z_ ]*>|process\.env|redacted|•+|\*{4,})`)

func looksSecret(v string) bool {
	if placeholderPattern.MatchString(v) {
		return false
	}
	hasDigit := strings.ContainsAny(v, "0123456789")
	hasAlpha := strings.IndexFunc(v, func(r rune) bool {
		return (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')
	}) >= 0
	return hasDigit && hasAlpha
}

// maskSecret 保留首尾 4 位，中间省略；短值整体掩盖。
func maskSecret(v string) string {
	if len(v) <= 10 {
		return "••••••••"
	}
	return v[:4] + "……" + v[len(v)-4:]
}

// detectSecrets 扫描一段文本，返回命中行（行号 1 起），同一行同一片段只报一次。
func detectSecrets(text string) []SecretHit {
	hits := []SecretHit{}
	seen := map[string]bool{}
	push := func(h SecretHit) {
		key := h.Kind + "|" + itoa(int64(h.Line)) + "|" + h.Masked
		if seen[key] {
			return
		}
		seen[key] = true
		hits = append(hits, h)
	}

	for i, line := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		for _, p := range namedPatterns {
			for _, m := range p.re.FindAllString(line, -1) {
				push(SecretHit{Line: i + 1, Masked: maskSecret(m), Kind: p.kind})
			}
		}
		for _, m := range kvPattern.FindAllStringSubmatch(line, -1) {
			if len(m) < 3 || !looksSecret(m[2]) {
				continue
			}
			push(SecretHit{
				Line:   i + 1,
				Masked: maskSecret(m[2]),
				Kind:   "明文凭证（" + strings.ToLower(m[1]) + "）",
			})
		}
	}
	return hits
}

// maskSecretsInText 就地把文本里的密钥形态掩盖，用于第三方引擎（semgrep）返回的片段。
func maskSecretsInText(text string) string {
	out := text
	for _, p := range namedPatterns {
		out = p.re.ReplaceAllStringFunc(out, func(m string) string { return maskSecret(m) })
	}
	// KV 型只替换「值」那一段：值外侧还有引号，不能靠 TrimSuffix 拼。
	// 用子匹配区间从后往前改，避免前面的替换把后面的偏移量打乱。
	matches := kvPattern.FindAllStringSubmatchIndex(out, -1)
	for i := len(matches) - 1; i >= 0; i-- {
		m := matches[i]
		if len(m) < 6 {
			continue
		}
		valueStart, valueEnd := m[4], m[5]
		if valueStart < 0 || valueEnd <= valueStart {
			continue
		}
		value := out[valueStart:valueEnd]
		if !looksSecret(value) {
			continue
		}
		out = out[:valueStart] + maskSecret(value) + out[valueEnd:]
	}
	return out
}

const maxSecurityFileBytes = 2 * 1024 * 1024

func inSyncedFolder(p string) bool {
	home := homeDir()
	return strings.HasPrefix(p, filepath.Join(home, "Documents")+string(os.PathSeparator)) ||
		strings.HasPrefix(p, filepath.Join(home, "Desktop")+string(os.PathSeparator))
}

func isShellRc(p string) bool {
	switch p {
	case filepath.Join(homeDir(), ".zshrc"),
		filepath.Join(homeDir(), ".bashrc"),
		filepath.Join(homeDir(), ".bash_profile"),
		filepath.Join(homeDir(), ".zprofile"),
		filepath.Join(homeDir(), ".profile"):
		return true
	}
	return false
}

// runSecurityScan 执行体检：智能体登记的配置文件 + 固定的一组 shell rc 与凭证文件。
func runSecurityScan(agentFiles []CandidateFile) SecurityScanResult {
	candidates := append([]CandidateFile{}, agentFiles...)
	for _, rc := range []string{
		".zshrc", ".bashrc", ".bash_profile", ".zprofile", ".profile",
		".npmrc", ".netrc", ".git-credentials",
	} {
		candidates = append(candidates, CandidateFile{Path: filepath.Join(homeDir(), rc)})
	}

	result := SecurityScanResult{
		At:           time.Now().Format(time.RFC3339),
		CheckedPaths: len(candidates),
		Findings:     []SecurityFinding{},
	}
	done := map[string]bool{}
	seq := 0

	for _, c := range candidates {
		if done[c.Path] {
			continue
		}
		done[c.Path] = true

		info, err := os.Stat(c.Path)
		if err != nil {
			continue // 文件不存在：checkedPaths 计过，scannedFiles 不计
		}
		if info.IsDir() {
			continue
		}
		result.ScannedFiles++

		perm := info.Mode().Perm()
		text, ok := readText(c.Path)
		hits := []SecretHit{}
		if ok && len(text) <= maxSecurityFileBytes {
			hits = detectSecrets(text)
		}

		synced := inSyncedFolder(c.Path)
		rc := isShellRc(c.Path)
		for _, h := range hits {
			severity := "medium"
			advice := "密钥以明文保存在本地配置文件中，这是多数智能体的常规做法，但请确保文件权限为 600，且不要将该文件提交到 Git 仓库或截图外发。"
			if rc || synced {
				severity = "high"
				if rc {
					advice = "Shell 配置文件常被截图分享、同步到 dotfiles 仓库，密钥放这里泄露面很大。建议移到专用凭证文件并从 rc 中删除，然后到供应商后台轮换该密钥。"
				} else {
					advice = "该文件位于 iCloud 同步目录（文稿/桌面），密钥可能已随同步上传云端。建议移出同步目录并轮换密钥。"
				}
			}
			seq++
			result.Findings = append(result.Findings, SecurityFinding{
				ID: "sec-" + itoa(int64(seq)), Severity: severity, Category: "plaintext-secret",
				AgentID: c.AgentID, AgentName: c.AgentName, Path: c.Path, Line: h.Line,
				Kind: h.Kind, Snippet: h.Masked, Advice: advice,
			})
		}

		if perm&0002 != 0 {
			seq++
			result.Findings = append(result.Findings, SecurityFinding{
				ID: "sec-" + itoa(int64(seq)), Severity: "high", Category: "loose-permissions",
				AgentID: c.AgentID, AgentName: c.AgentName, Path: c.Path,
				Kind: "任意用户可写", Snippet: "mode " + permOctal(perm),
				Advice: "任何本机用户/进程都能篡改该文件，若为配置还可能导致命令注入。执行 chmod 600 收紧权限。",
			})
		} else if len(hits) > 0 && (perm&0004 != 0 || perm&0040 != 0) {
			seq++
			result.Findings = append(result.Findings, SecurityFinding{
				ID: "sec-" + itoa(int64(seq)), Severity: "high", Category: "loose-permissions",
				AgentID: c.AgentID, AgentName: c.AgentName, Path: c.Path,
				Kind: "含明文密钥且权限过宽", Snippet: "mode " + permOctal(perm),
				Advice: "该文件含明文密钥但组内/其他用户可读。执行 chmod 600 收紧权限。",
			})
		}
	}

	rank := map[string]int{"high": 0, "medium": 1, "info": 2}
	sort.SliceStable(result.Findings, func(i, j int) bool {
		a, b := result.Findings[i], result.Findings[j]
		if rank[a.Severity] != rank[b.Severity] {
			return rank[a.Severity] < rank[b.Severity]
		}
		return a.Path < b.Path
	})
	return result
}

func permOctal(perm os.FileMode) string {
	return fmt.Sprintf("0%o", perm)
}

// RunSecurityScan 是绑定入口：从扫描缓存里取已检测智能体的配置文件，再补固定凭证文件。
func (a *App) RunSecurityScan() string {
	candidates := []CandidateFile{}
	if a.store != nil {
		agents, err := a.store.ListAgents()
		if err == nil {
			for _, ag := range agents {
				if !ag.Detected {
					continue
				}
				detail, err := a.store.AgentDetail(ag.ID)
				if err != nil || detail == nil {
					continue
				}
				for _, cfg := range detail.Configs {
					candidates = append(candidates, CandidateFile{
						Path: cfg.Path, AgentID: ag.ID, AgentName: ag.Name,
					})
				}
			}
		}
	}
	return toJSON(runSecurityScan(candidates))
}

// PickRepoDir 弹出目录选择框（仓库审查用）。
func (a *App) PickRepoDir() string {
	if a.ctx == nil {
		return toJSON(nil)
	}
	dir, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{Title: "选择要审查的仓库目录"})
	if err != nil || dir == "" {
		return toJSON(nil)
	}
	return toJSON(dir)
}
