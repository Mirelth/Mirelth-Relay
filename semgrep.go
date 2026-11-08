package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// 可选增强引擎：本机装了 semgrep 时叠一层代码风险扫描，规则随应用内置、全程离线
// （关 metrics 与版本检查）。没装就明确降级为 available:false，不假装「零风险」。

const (
	semgrepRuleTimeout = 15 * time.Second
	semgrepOverall     = 180 * time.Second
)

// semgrepRulesYAML 对应 Electron 侧的 SEMGREP_RULES_YAML，内容逐字保留。
const semgrepRulesYAML = `
rules:
  # ---------- 明文密钥（补充内置脱敏正则之外的形态） ----------
  - id: secret-private-key-block
    languages: [generic]
    severity: ERROR
    message: 文件中嵌入了私钥块（PEM）。
    metadata:
      kind: 内嵌私钥
      advice: 私钥文件/私钥块不应出现在仓库中。视为已泄露：立即换用新密钥，并从代码与 Git 历史中移除。
      secret: true
    pattern-regex: '-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----'

  - id: secret-google-api-key
    languages: [generic]
    severity: ERROR
    message: 文件中出现疑似 Google API Key 明文。
    metadata:
      kind: 明文密钥(Google)
      advice: 到 Google Cloud 控制台轮换该密钥，改用环境变量，并将所在文件加入 .gitignore。
      secret: true
    pattern-regex: '\bAIza[0-9A-Za-z_-]{35}\b'

  - id: secret-gitlab-token
    languages: [generic]
    severity: ERROR
    message: 文件中出现疑似 GitLab Token 明文。
    metadata:
      kind: 明文密钥(GitLab)
      advice: 到 GitLab 设置中撤销并重建该 Token，改用环境变量或 CI 变量注入。
      secret: true
    pattern-regex: '\bglpat-[A-Za-z0-9_-]{20,}\b'

  # ---------- 代码风险 ----------
  - id: js-eval-dynamic
    languages: [javascript, typescript]
    severity: WARNING
    message: 使用 eval 动态执行代码。
    metadata:
      kind: eval 动态执行
      advice: eval 会把字符串当代码执行，是注入类漏洞的常见入口。改用 JSON.parse、映射表或显式分支处理。
    patterns:
      - pattern-either:
          - pattern: eval($X)
          - pattern: new Function($X)

  - id: js-exec-concat
    languages: [javascript, typescript]
    severity: WARNING
    message: exec/execSync 传入拼接或变量形式的命令字符串。
    metadata:
      kind: 命令注入风险
      advice: 拼接外部输入构造 shell 命令可能导致命令注入。改用 execFile/spawn 传参数组，或对输入做白名单校验。
    patterns:
      - pattern-either:
          - pattern: exec($X)
          - pattern: execSync($X)
          - pattern: $CP.exec($X)
          - pattern: $CP.execSync($X)
      - metavariable-regex:
          metavariable: $X
          regex: "^(?![\\\"']).+$"

  - id: py-eval-dynamic
    languages: [python]
    severity: WARNING
    message: 使用 eval 动态求值。
    metadata:
      kind: eval 动态求值
      advice: eval 会把字符串当代码执行。改用 ast.literal_eval 或显式数据结构。
    patterns:
      - pattern: eval($X)

  - id: py-os-system
    languages: [python]
    severity: WARNING
    message: 使用 os.system 执行 shell 命令。
    metadata:
      kind: 命令注入风险
      advice: os.system 会经过 shell 解释，拼接外部输入易导致命令注入。改用 subprocess.run 传参数组（shell=False）。
    patterns:
      - pattern-either:
          - pattern: os.system($X)
          - pattern: subprocess.call($X, shell=True)
          - pattern: subprocess.run($X, shell=True)

  - id: hardcoded-password
    languages: [generic]
    severity: WARNING
    message: 疑似硬编码的口令/密码字面量。
    metadata:
      kind: 硬编码口令
      advice: 口令不应写死在代码或配置里。改用环境变量、密钥管理服务或交互式输入。
    patterns:
      - pattern-regex: '(?i)\b(password|passwd|pwd)\b\s*[:=]\s*[''"][^''"]{4,}[''"]'
      - pattern-not-regex: '(?i)(placeholder|example|changeme|your[_-]|redacted|\$\{|process\.env|os\.environ|<[^>]*>)'
`

// semgrepRuleCount 数一下内置规则条数（结果里要展示「本次启用 N 条规则」）。
func semgrepRuleCount() int {
	var doc struct {
		Rules []any `yaml:"rules"`
	}
	if err := yaml.Unmarshal([]byte(semgrepRulesYAML), &doc); err != nil {
		return 0
	}
	return len(doc.Rules)
}

type SemgrepProbe struct {
	Available bool
	Bin       string
	Version   string
}

var semgrepVersionRE = regexp.MustCompile(`(?m)^\d+\.\d+[^\s]*`)

// probeSemgrep 先看 PATH，再看常见安装位置（含 pip --user 的 ~/Library/Python/*/bin），
// 每个候选都用 --version 验证过才算可用。
func probeSemgrep() SemgrepProbe {
	candidates := []string{}
	if p := resolveBin("semgrep"); p != "" {
		candidates = append(candidates, p)
	}
	fixedDirs := []string{"/opt/homebrew/bin", "/usr/local/bin", filepath.Join(homeDir(), ".local", "bin")}
	if entries, err := os.ReadDir(filepath.Join(homeDir(), "Library", "Python")); err == nil {
		for _, e := range entries {
			if e.IsDir() {
				fixedDirs = append(fixedDirs, filepath.Join(homeDir(), "Library", "Python", e.Name(), "bin"))
			}
		}
	}
	for _, d := range fixedDirs {
		candidates = append(candidates, filepath.Join(d, "semgrep"))
	}

	seen := map[string]bool{}
	for _, bin := range candidates {
		if bin == "" || seen[bin] || !isExecutable(bin) {
			continue
		}
		seen[bin] = true
		out, err := runWithTimeout(10*time.Second, bin, "--version")
		if err != nil {
			continue
		}
		if v := semgrepVersionRE.FindString(out); v != "" {
			return SemgrepProbe{Available: true, Bin: bin, Version: v}
		}
	}
	return SemgrepProbe{}
}

// SemgrepPos 是命中位置。
type SemgrepPos struct {
	Line int `json:"line"`
	Col  int `json:"col"`
}

// SemgrepMetadata 是内置规则里 metadata 段的回读结构。
type SemgrepMetadata struct {
	Kind   string `json:"kind"`
	Advice string `json:"advice"`
	Secret bool   `json:"secret"`
}

// SemgrepExtra 是命中附带的说明信息。
type SemgrepExtra struct {
	Message  string          `json:"message"`
	Severity string          `json:"severity"`
	Lines    string          `json:"lines"`
	Metadata SemgrepMetadata `json:"metadata"`
}

// SemgrepJSONResult 是 semgrep --json 输出里的单条结果。
type SemgrepJSONResult struct {
	CheckID string       `json:"check_id"`
	Path    string       `json:"path"`
	Start   SemgrepPos   `json:"start"`
	Extra   SemgrepExtra `json:"extra"`
}

type SemgrepOutcome struct {
	Available bool
	Version   string
	Rules     int
	Found     int
	Error     string
	Results   []SemgrepJSONResult
}

// relativize 把 semgrep 输出的绝对路径转成相对仓库根的路径。
func relativize(p, repo string) string {
	norm := strings.ReplaceAll(p, "\\", "/")
	repoNorm := strings.TrimRight(strings.ReplaceAll(repo, "\\", "/"), "/") + "/"
	if strings.HasPrefix(norm, repoNorm) {
		return norm[len(repoNorm):]
	}
	return strings.TrimLeft(norm, "/")
}

var semgrepSeverity = map[string]string{
	"ERROR": "high", "WARNING": "medium", "INFO": "info", "INVENTORY": "info",
}

// mapSemgrepResults 把引擎结果映射成仓库发现；与已有 "path:line" 去重，片段强制脱敏。
func mapSemgrepResults(results []SemgrepJSONResult, repo string, existing map[string]bool) []RepoSecurityFinding {
	out := []RepoSecurityFinding{}
	seen := map[string]bool{}
	for _, r := range results {
		rel := relativize(r.Path, repo)
		key := rel + ":" + itoa(int64(r.Start.Line))
		if existing[key] || seen[key] {
			continue
		}
		seen[key] = true

		rawSnippet := strings.TrimSpace(r.Extra.Lines)
		if rawSnippet == "" {
			rawSnippet = strings.TrimSpace(r.Extra.Message)
		}
		rawSnippet = regexp.MustCompile(`\s+`).ReplaceAllString(rawSnippet, " ")
		snippet := maskSecretsInText(rawSnippet)
		if len(snippet) > 200 {
			snippet = snippet[:200]
		}

		severity, ok := semgrepSeverity[r.Extra.Severity]
		if !ok {
			severity = "info"
		}
		kind := r.Extra.Metadata.Kind
		if kind == "" {
			kind = strings.TrimPrefix(r.CheckID, "generic.")
		}
		category := "code-risk"
		if r.Extra.Metadata.Secret {
			category = "code-secret"
		}
		advice := r.Extra.Metadata.Advice
		if advice == "" {
			advice = r.Extra.Message
		}
		if advice == "" {
			advice = "请结合上下文人工复核该处代码。"
		}
		out = append(out, RepoSecurityFinding{
			Severity: severity, Category: category, Path: rel, Line: r.Start.Line,
			Kind: kind, Snippet: snippet, Advice: advice,
		})
	}
	return out
}

// runSemgrepScan 对仓库跑一次本地扫描；未安装时返回 Available:false。
func runSemgrepScan(repo string) SemgrepOutcome {
	probe := probeSemgrep()
	if !probe.Available {
		return SemgrepOutcome{Available: false}
	}
	rules := semgrepRuleCount()

	rulesFile := filepath.Join(os.TempDir(), "relay-semgrep-"+itoa(time.Now().UnixNano())+".yml")
	if err := os.WriteFile(rulesFile, []byte(semgrepRulesYAML), 0600); err != nil {
		return SemgrepOutcome{Available: true, Version: probe.Version, Rules: rules, Error: err.Error()}
	}
	defer func() { _ = os.Remove(rulesFile) }()

	args := []string{
		"scan", "--json", "--quiet",
		"--metrics=off", "--disable-version-check", "--no-git-ignore",
		"--config", rulesFile,
		"--timeout", itoa(int64(semgrepRuleTimeout / time.Second)),
		"--max-target-bytes", "1048576",
		"--jobs", "2",
		repo,
	}
	out, err := runWithTimeout(semgrepOverall, probe.Bin, args...)
	if err != nil {
		return SemgrepOutcome{
			Available: true, Version: probe.Version, Rules: rules,
			Error: "semgrep 运行失败：" + err.Error(),
		}
	}

	var parsed struct {
		Results []SemgrepJSONResult `json:"results"`
		Errors  []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	// semgrep 可能先打印警告行，从第一个 '{' 开始解析
	if start := strings.Index(out, "{"); start >= 0 {
		out = out[start:]
	}
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		return SemgrepOutcome{
			Available: true, Version: probe.Version, Rules: rules,
			Error: "无法解析 semgrep 输出：" + err.Error(),
		}
	}

	errText := ""
	if len(parsed.Errors) > 0 {
		msgs := make([]string, 0, len(parsed.Errors))
		for _, e := range parsed.Errors {
			if e.Message != "" {
				msgs = append(msgs, e.Message)
			}
		}
		errText = strings.Join(msgs, "; ")
	}
	return SemgrepOutcome{
		Available: true, Version: probe.Version, Rules: rules,
		Found: len(parsed.Results), Error: errText, Results: parsed.Results,
	}
}

// execGit 在指定工作目录跑 git 命令（semgrep/repo 扫描都靠它拿文件清单）。
func execGit(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0")
	out, err := cmd.Output()
	return string(out), err
}
