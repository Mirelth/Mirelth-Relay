package main

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// 仓库安全审查（只读），从 Electron 的 src/main/repo-security.ts 移植：
//   1) 工作区文件里的明文密钥；
//   2) 已提交进 Git 的敏感文件（.env / 私钥等）；
//   3) 敏感文件没被 .gitignore 覆盖，可能被一次 git add -A 带上；
//   4) 可选叠加本地 semgrep 的代码风险扫描。

const (
	repoMaxFiles     = 5000
	repoMaxFileBytes = 1024 * 1024
	repoMaxFindings  = 500
)

type RepoSecurityFinding struct {
	ID       string `json:"id"`
	Severity string `json:"severity"`
	Category string `json:"category"`
	Path     string `json:"path"`
	Line     int    `json:"line,omitempty"`
	Kind     string `json:"kind"`
	Snippet  string `json:"snippet"`
	Advice   string `json:"advice"`
}

type SemgrepEngineInfo struct {
	Available bool   `json:"available"`
	Version   string `json:"version,omitempty"`
	Rules     int    `json:"rules,omitempty"`
	Found     int    `json:"found,omitempty"`
	Error     string `json:"error,omitempty"`
}

type RepoSecurityScanResult struct {
	At           string                `json:"at"`
	Repo         string                `json:"repo"`
	IsGitRepo    bool                  `json:"isGitRepo"`
	ScannedFiles int                   `json:"scannedFiles"`
	Truncated    bool                  `json:"truncated"`
	Semgrep      SemgrepEngineInfo     `json:"semgrep"`
	Findings     []RepoSecurityFinding `json:"findings"`
}

var repoIgnoredDirs = map[string]bool{
	".git": true, "node_modules": true, "dist": true, "out": true, "build": true,
	".next": true, ".nuxt": true, ".output": true, "coverage": true, "__pycache__": true,
	".venv": true, "venv": true, "vendor": true, "target": true, ".cache": true,
	".turbo": true, ".idea": true,
}

// 已提交即高危的敏感文件（按相对路径判断）。
var sensitiveNameRE = regexp.MustCompile(`(?i)(^|/)(\.env(\.[^/]+)?|id_rsa|id_dsa|id_ecdsa|id_ed25519|\.netrc|\.git-credentials)$|(\.(pem|key|pfx|p12|jks|keystore))$`)

var envFileNameRE = regexp.MustCompile(`(?i)example|template|sample`)

func isEnvFile(rel string) bool {
	base := strings.ToLower(filepath.Base(rel))
	if base == ".env" {
		return true
	}
	return strings.HasPrefix(base, ".env.") && !envFileNameRE.MatchString(base)
}

func isSensitiveName(rel string) bool {
	return sensitiveNameRE.MatchString(rel)
}

// listRepoFiles：git 仓库用 ls-files（tracked + 未被 ignore 的 untracked），
// 普通目录递归遍历；超过上限就标记 truncated。
type repoFileList struct {
	files     []string
	isGit     bool
	tracked   map[string]bool
	truncated bool
}

func listRepoFiles(repo string) repoFileList {
	if exists(filepath.Join(repo, ".git")) {
		if cached, err := execGit(repo, "ls-files", "-z", "--cached"); err == nil {
			if others, err2 := execGit(repo, "ls-files", "-z", "--others", "--exclude-standard"); err2 == nil {
				tracked := map[string]bool{}
				trackedList := splitNul(cached)
				untrackedList := splitNul(others)
				files := append(append([]string{}, trackedList...), untrackedList...)
				for _, f := range trackedList {
					tracked[f] = true
				}
				return repoFileList{
					files: files, isGit: true, tracked: tracked, truncated: len(files) > repoMaxFiles,
				}
			}
		}
		// git 命令失败就退化为普通遍历
	}

	files := []string{}
	truncated := false
	var walk func(dir, rel string)
	walk = func(dir, rel string) {
		if truncated {
			return
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		for _, e := range entries {
			if len(files) > repoMaxFiles {
				truncated = true
				return
			}
			name := e.Name()
			childRel := name
			if rel != "" {
				childRel = rel + "/" + name
			}
			if e.IsDir() {
				if !repoIgnoredDirs[name] {
					walk(filepath.Join(dir, name), childRel)
				}
				continue
			}
			if e.Type().IsRegular() {
				files = append(files, childRel)
			}
		}
	}
	walk(repo, "")
	return repoFileList{files: files, isGit: false, tracked: map[string]bool{}, truncated: truncated}
}

func splitNul(s string) []string {
	out := []string{}
	for _, item := range strings.Split(s, "\x00") {
		if item != "" && !strings.HasSuffix(item, "/") {
			out = append(out, item)
		}
	}
	return out
}

// readMaybeText：二进制（前 8KB 含 NUL）或超过上限的文件返回 false。
func readMaybeText(path string, maxBytes int64) (string, bool) {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() || info.Size() > maxBytes || info.Size() == 0 {
		return "", false
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	probe := data
	if len(probe) > 8192 {
		probe = probe[:8192]
	}
	if strings.ContainsRune(string(probe), 0) {
		return "", false
	}
	return string(data), true
}

func secretAdvice(isTracked bool) string {
	if isTracked {
		return "密钥已进入 Git 历史，仅删除文件不够。请先到供应商后台轮换该密钥，再从当前代码中移除；必要时用 git filter-repo 清理历史后强推。"
	}
	return "密钥存在于工作区文件中，尚未被 Git 跟踪。提交前务必删除或改用环境变量，并把该文件加入 .gitignore。"
}

var gitignoreEnvRuleRE = regexp.MustCompile(`(?m)(^|\s)\.env(\s|$|\.)`)

// runRepoSecurityScan 执行仓库审查。
func runRepoSecurityScan(repoDir string) (RepoSecurityScanResult, error) {
	repo := strings.TrimSpace(repoDir)
	info, err := os.Stat(repo)
	if err != nil || !info.IsDir() {
		return RepoSecurityScanResult{}, configWriteErr("不是有效的目录：%s", repo)
	}

	list := listRepoFiles(repo)
	result := RepoSecurityScanResult{
		At: time.Now().Format(time.RFC3339), Repo: repo, IsGitRepo: list.isGit,
		Truncated: list.truncated, Findings: []RepoSecurityFinding{},
		Semgrep: SemgrepEngineInfo{Available: false},
	}
	seq := 0
	envOnDisk := false

	for _, rel := range list.files {
		text, ok := readMaybeText(filepath.Join(repo, rel), repoMaxFileBytes)
		if !ok {
			continue
		}
		result.ScannedFiles++

		if isEnvFile(rel) {
			envOnDisk = true
		}

		if list.isGit && list.tracked[rel] && (isEnvFile(rel) || isSensitiveName(rel)) {
			seq++
			snippet := "私钥/凭证文件"
			advice := "私钥/凭证文件不应纳入版本控制。用 git rm --cached 移出跟踪、加入 .gitignore，并视为已泄露、立即轮换。"
			if isEnvFile(rel) {
				snippet = "环境变量文件"
				advice = "环境变量文件通常含真实密钥，不应纳入版本控制。用 git rm --cached 移出跟踪、加入 .gitignore，并轮换其中所有密钥。"
			}
			result.Findings = append(result.Findings, RepoSecurityFinding{
				ID: "repo-" + itoa(int64(seq)), Severity: "high", Category: "committed-env",
				Path: rel, Kind: "敏感文件已提交进仓库", Snippet: snippet, Advice: advice,
			})
		}

		for _, h := range detectSecrets(text) {
			seq++
			result.Findings = append(result.Findings, RepoSecurityFinding{
				ID: "repo-" + itoa(int64(seq)), Severity: "high", Category: "plaintext-secret",
				Path: rel, Line: h.Line, Kind: h.Kind, Snippet: h.Masked,
				Advice: secretAdvice(list.tracked[rel]),
			})
			if len(result.Findings) >= repoMaxFindings {
				break
			}
		}
		if len(result.Findings) >= repoMaxFindings {
			break
		}

		// untracked 里出现敏感文件 = 没被 ignore 覆盖，一次 git add -A 就会带上
		if list.isGit && !list.tracked[rel] && (isEnvFile(rel) || isSensitiveName(rel)) {
			seq++
			rule := filepath.Base(rel)
			if isEnvFile(rel) {
				rule = ".env"
			}
			result.Findings = append(result.Findings, RepoSecurityFinding{
				ID: "repo-" + itoa(int64(seq)), Severity: "medium", Category: "gitignore-missing",
				Path: rel, Kind: "敏感文件未被 .gitignore 覆盖",
				Snippet: "当前处于未跟踪状态，一次 git add -A 就会提交",
				Advice:  "在 .gitignore 中加入 " + rule + " 或该文件的完整路径，避免被意外提交。",
			})
		}
	}

	// 兜底：仓库里有 .env 但 .gitignore 完全没提 .env
	if list.isGit && envOnDisk {
		gi, ok := readMaybeText(filepath.Join(repo, ".gitignore"), 65536)
		if !ok || !gitignoreEnvRuleRE.MatchString(gi) {
			seq++
			result.Findings = append(result.Findings, RepoSecurityFinding{
				ID: "repo-" + itoa(int64(seq)), Severity: "medium", Category: "gitignore-missing",
				Path: ".gitignore", Kind: ".gitignore 缺少 .env 规则",
				Snippet: ".env 未被忽略规则覆盖",
				Advice:  `在 .gitignore 中加入 ".env"（及其变体如 .env.local），从源头防止环境变量文件被提交。`,
			})
		}
	}

	// 可选增强引擎：任何意外都不影响基础检查结果
	outcome := runSemgrepScan(repo)
	result.Semgrep = SemgrepEngineInfo{
		Available: outcome.Available, Version: outcome.Version,
		Rules: outcome.Rules, Found: outcome.Found, Error: outcome.Error,
	}
	if outcome.Available && len(outcome.Results) > 0 {
		existing := map[string]bool{}
		for _, f := range result.Findings {
			existing[f.Path+":"+itoa(int64(f.Line))] = true
		}
		for _, f := range mapSemgrepResults(outcome.Results, repo, existing) {
			if len(result.Findings) >= repoMaxFindings {
				break
			}
			seq++
			f.ID = "repo-" + itoa(int64(seq))
			result.Findings = append(result.Findings, f)
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
	return result, nil
}

// RunRepoSecurityScan 是绑定入口（security:repoScan）。
func (a *App) RunRepoSecurityScan(repoDir string) string {
	result, err := runRepoSecurityScan(repoDir)
	if err != nil {
		return toJSON(map[string]any{"error": err.Error()})
	}
	return toJSON(result)
}
