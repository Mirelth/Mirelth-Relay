package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestIsEnvFileAndSensitiveName(t *testing.T) {
	envs := map[string]bool{
		".env": true, ".env.local": true, "config/.env.production": true,
		".env.example": false, ".env.template": false, ".env.sample": false,
		"src/index.ts": false,
	}
	for rel, want := range envs {
		if got := isEnvFile(rel); got != want {
			t.Errorf("isEnvFile(%q) = %v, want %v", rel, got, want)
		}
	}
	sensitive := map[string]bool{
		"id_rsa": true, "keys/server.pem": true, "cert.p12": true,
		".netrc": true, "deploy/.git-credentials": true,
		"README.md": false, "keyboard.ts": false,
	}
	for rel, want := range sensitive {
		if got := isSensitiveName(rel); got != want {
			t.Errorf("isSensitiveName(%q) = %v, want %v", rel, got, want)
		}
	}
}

func TestReadMaybeTextSkipsBinaryAndOversized(t *testing.T) {
	dir := t.TempDir()
	text := filepath.Join(dir, "a.txt")
	mkfile(t, text, "hello")
	if got, ok := readMaybeText(text, 1024); !ok || got != "hello" {
		t.Fatalf("text file = %q ok=%v", got, ok)
	}

	binary := filepath.Join(dir, "b.bin")
	if err := os.WriteFile(binary, []byte{0x41, 0x00, 0x42}, 0600); err != nil {
		t.Fatal(err)
	}
	if _, ok := readMaybeText(binary, 1024); ok {
		t.Fatal("binary file must be skipped")
	}

	big := filepath.Join(dir, "big.txt")
	mkfile(t, big, strings.Repeat("x", 2048))
	if _, ok := readMaybeText(big, 1024); ok {
		t.Fatal("oversized file must be skipped")
	}

	empty := filepath.Join(dir, "empty.txt")
	mkfile(t, empty, "")
	if _, ok := readMaybeText(empty, 1024); ok {
		t.Fatal("empty file must be skipped")
	}
}

func TestListRepoFilesWalksNonGitTree(t *testing.T) {
	dir := t.TempDir()
	mkfile(t, filepath.Join(dir, "src/main.ts"), "x")
	mkfile(t, filepath.Join(dir, "node_modules/dep/index.js"), "x")
	mkfile(t, filepath.Join(dir, ".git-ignored-dir/keep.txt"), "x")

	list := listRepoFiles(dir)
	if list.isGit {
		t.Fatal("temp dir is not a git repo")
	}
	joined := strings.Join(list.files, ",")
	if !strings.Contains(joined, "src/main.ts") {
		t.Fatalf("files = %v", list.files)
	}
	if strings.Contains(joined, "node_modules") {
		t.Fatalf("node_modules must be skipped: %v", list.files)
	}
	// 隐藏目录不跳过（.git 之外），与 Electron 侧一致
	if !strings.Contains(joined, ".git-ignored-dir/keep.txt") {
		t.Fatalf("hidden dirs other than ignored list should be walked: %v", list.files)
	}
}

func TestRepoSecurityScanNonGitDirectory(t *testing.T) {
	dir := t.TempDir()
	mkfile(t, filepath.Join(dir, ".env"), "OPENAI_API_KEY="+fakeSecret("sk-"+"proj-", 20)+"\n")
	mkfile(t, filepath.Join(dir, "src/config.ts"), `const apiKey = "abcd1234efgh5678"`)
	mkfile(t, filepath.Join(dir, "src/clean.ts"), "export const x = 1\n")

	res, err := runRepoSecurityScan(dir)
	if err != nil {
		t.Fatal(err)
	}
	if res.IsGitRepo {
		t.Fatal("temp dir is not a git repo")
	}
	if res.ScannedFiles != 3 {
		t.Fatalf("scannedFiles = %d", res.ScannedFiles)
	}
	cats := map[string]int{}
	for _, f := range res.Findings {
		cats[f.Category]++
		if strings.Contains(f.Snippet, "abcdefgh12345678") || strings.Contains(f.Snippet, "efgh5678") {
			t.Fatalf("snippet leaked: %+v", f)
		}
	}
	if cats["plaintext-secret"] < 2 {
		t.Fatalf("expected secrets in .env and config.ts: %+v", cats)
	}
	if cats["committed-env"] != 0 || cats["gitignore-missing"] != 0 {
		t.Fatalf("non-git dir must not report git findings: %+v", cats)
	}
}

// initGitRepo 建一个自包含的仓库（不依赖用户全局 git 配置）。
func initGitRepo(t *testing.T, dir string) {
	t.Helper()
	if _, err := execGit(dir, "init", "-q"); err != nil {
		t.Skipf("git 不可用：%v", err)
	}
	for _, kv := range [][2]string{{"user.email", "test@example.com"}, {"user.name", "Test"}} {
		if _, err := execGit(dir, "config", kv[0], kv[1]); err != nil {
			t.Fatal(err)
		}
	}
}

func TestRepoSecurityScanGitRepo(t *testing.T) {
	dir := t.TempDir()
	initGitRepo(t, dir)

	mkfile(t, filepath.Join(dir, ".env"), "OPENAI_API_KEY="+fakeSecret("sk-"+"proj-", 20)+"\n")
	mkfile(t, filepath.Join(dir, "app.ts"), "export const ok = 1\n")
	if _, err := execGit(dir, "add", "-A"); err != nil {
		t.Fatal(err)
	}
	if _, err := execGit(dir, "commit", "-qm", "init"); err != nil {
		t.Fatal(err)
	}
	// 已提交后再留一个未跟踪的敏感文件（模拟「没写进 .gitignore」）
	mkfile(t, filepath.Join(dir, ".env.local"), "SECRET_KEY=abcd1234efgh5678\n")

	res, err := runRepoSecurityScan(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !res.IsGitRepo {
		t.Fatal("should detect git repo")
	}
	byCat := map[string][]RepoSecurityFinding{}
	for _, f := range res.Findings {
		byCat[f.Category] = append(byCat[f.Category], f)
	}
	if len(byCat["committed-env"]) != 1 || byCat["committed-env"][0].Path != ".env" {
		t.Fatalf("committed env findings = %+v", byCat["committed-env"])
	}
	if len(byCat["gitignore-missing"]) == 0 {
		t.Fatalf("untracked .env.local should be reported: %+v", byCat)
	}
	var gitignoreRule bool
	for _, f := range byCat["gitignore-missing"] {
		if f.Path == ".gitignore" {
			gitignoreRule = true
		}
	}
	if !gitignoreRule {
		t.Fatalf("missing root .gitignore rule should be reported: %+v", byCat["gitignore-missing"])
	}
	// 已提交文件的密钥建议要提「轮换 + 清历史」
	for _, f := range byCat["plaintext-secret"] {
		if f.Path == ".env" && !strings.Contains(f.Advice, "Git 历史") {
			t.Fatalf("tracked secret advice = %s", f.Advice)
		}
	}
}

func TestGitignoreRuleSuppressesFallback(t *testing.T) {
	dir := t.TempDir()
	initGitRepo(t, dir)
	mkfile(t, filepath.Join(dir, ".gitignore"), "node_modules\n.env\n.env.local\n")
	mkfile(t, filepath.Join(dir, ".env"), "OPENAI_API_KEY="+fakeSecret("sk-"+"proj-", 20)+"\n")

	res, err := runRepoSecurityScan(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range res.Findings {
		if f.Category == "gitignore-missing" && f.Path == ".gitignore" {
			t.Fatalf(".gitignore already covers .env: %+v", f)
		}
	}
}

func TestRelativizeAndMapSemgrepResults(t *testing.T) {
	if got := relativize("/repo/a/b.ts", "/repo"); got != "a/b.ts" {
		t.Fatalf("relativize = %q", got)
	}
	if got := relativize("/elsewhere/x.ts", "/repo"); got != "elsewhere/x.ts" {
		t.Fatalf("outside repo = %q", got)
	}

	results := []SemgrepJSONResult{
		{CheckID: "generic.secret-google-api-key", Path: "/repo/.env", Start: SemgrepPos{Line: 3},
			Extra: semgrepExtra("ERROR", "key "+fakeSecret("AI"+"za", 35), "明文密钥(Google)", "轮换它", true)},
		// 与已有发现同 path:line → 丢弃
		{CheckID: "js-eval-dynamic", Path: "/repo/app.ts", Start: SemgrepPos{Line: 10},
			Extra: semgrepExtra("WARNING", "eval(x)", "eval 动态执行", "", false)},
		// 同一位置第二次出现 → 去重
		{CheckID: "js-eval-dynamic", Path: "/repo/app.ts", Start: SemgrepPos{Line: 10},
			Extra: semgrepExtra("WARNING", "eval(x)", "eval 动态执行", "", false)},
		{CheckID: "py-eval-dynamic", Path: "/repo/run.py", Start: SemgrepPos{Line: 7},
			Extra: semgrepExtra("INFO", strings.Repeat("y", 300), "", "", false)},
	}

	existing := map[string]bool{"app.ts:10": true}
	mapped := mapSemgrepResults(results, "/repo", existing)
	if len(mapped) != 2 {
		t.Fatalf("mapped = %+v", mapped)
	}
	first := mapped[0]
	if first.Path != ".env" || first.Line != 3 || first.Severity != "high" || first.Category != "code-secret" {
		t.Fatalf("first = %+v", first)
	}
	if strings.Contains(first.Snippet, fakeSecret("AI"+"za", 35)) {
		t.Fatalf("snippet must be masked: %q", first.Snippet)
	}
	if first.Advice != "轮换它" || first.Kind != "明文密钥(Google)" {
		t.Fatalf("metadata lost: %+v", first)
	}
	second := mapped[1]
	if second.Path != "run.py" || second.Severity != "info" || second.Category != "code-risk" {
		t.Fatalf("second = %+v", second)
	}
	if len(second.Snippet) != 200 {
		t.Fatalf("snippet should be truncated to 200, got %d", len(second.Snippet))
	}
	if second.Kind != "py-eval-dynamic" {
		t.Fatalf("kind fallback = %q", second.Kind)
	}
}

func TestSemgrepRuleCount(t *testing.T) {
	if got := semgrepRuleCount(); got != 8 {
		t.Fatalf("built-in rules = %d, want 8", got)
	}
}

func TestProbeSemgrepReportsAvailability(t *testing.T) {
	probe := probeSemgrep()
	if !probe.Available {
		t.Skip("本机没有 semgrep，跳过可用性断言")
	}
	if probe.Bin == "" || probe.Version == "" {
		t.Fatalf("probe = %+v", probe)
	}
}

func TestRunSemgrepScanOnTempRepo(t *testing.T) {
	if testing.Short() {
		t.Skip("semgrep 扫描较慢，短模式跳过")
	}
	if !probeSemgrep().Available {
		t.Skip("本机没有 semgrep")
	}
	dir := t.TempDir()
	mkfile(t, filepath.Join(dir, "app.js"), "function run(code) { return eval(code) }\n")
	mkfile(t, filepath.Join(dir, "key.txt"), "google = "+fakeSecret("AI"+"za", 35)+"\n")

	outcome := runSemgrepScan(dir)
	if !outcome.Available {
		t.Fatalf("outcome = %+v", outcome)
	}
	if outcome.Rules != 8 {
		t.Fatalf("rules = %d", outcome.Rules)
	}
	if len(outcome.Results) == 0 {
		t.Fatalf("eval + api key should be detected: %+v", outcome)
	}
	mapped := mapSemgrepResults(outcome.Results, dir, map[string]bool{})
	if len(mapped) == 0 {
		t.Fatal("mapped results empty")
	}
	for _, f := range mapped {
		if strings.Contains(f.Snippet, fakeSecret("AI"+"za", 35)[:14]) {
			t.Fatalf("snippet leaked: %+v", f)
		}
	}
}

func TestRepoSecurityScanRejectsNonDirectory(t *testing.T) {
	file := filepath.Join(t.TempDir(), "a.txt")
	mkfile(t, file, "x")
	if _, err := runRepoSecurityScan(file); err == nil {
		t.Fatal("a file path must be rejected")
	}
	if got := (&App{}).RunRepoSecurityScan("/definitely/not/here"); !strings.Contains(got, "error") {
		t.Fatalf("binding should return an error payload: %s", got)
	}
}

// semgrepExtra 组装 SemgrepJSONResult 的 extra 段，避免测试里堆嵌套匿名结构。
func semgrepExtra(severity, lines, kind, advice string, secret bool) SemgrepExtra {
	var e SemgrepExtra
	e.Severity = severity
	e.Lines = lines
	e.Metadata.Kind = kind
	e.Metadata.Advice = advice
	e.Metadata.Secret = secret
	return e
}

// fakeSemgrep 装一个"能回话"的假引擎：--version 正常、扫描时回一段合法 JSON。
// 本机 semgrep 可能装坏（解释器缺失），用它来确定性地覆盖引擎解析与降级之外的全链路。
func fakeSemgrep(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	script := filepath.Join(dir, "semgrep")
	body := `#!/bin/sh
if [ "$1" = "--version" ]; then echo "1.99.0"; exit 0; fi
for last; do :; done
cat <<JSON
{"results":[
 {"check_id":"js-eval-dynamic","path":"$last/app.js","start":{"line":1,"col":10},
  "extra":{"message":"使用 eval","severity":"WARNING","lines":"return eval(code)",
           "metadata":{"kind":"eval 动态执行","advice":"改用 JSON.parse"}}},
 {"check_id":"secret-google-api-key","path":"$last/key.txt","start":{"line":3,"col":1},
  "extra":{"message":"明文密钥","severity":"ERROR","lines":"key = __FAKE_GOOGLE_KEY__",
           "metadata":{"kind":"明文密钥(Google)","advice":"轮换","secret":true}}}
]}
JSON
`
	body = strings.ReplaceAll(body, "__FAKE_GOOGLE_KEY__", fakeSecret("AI"+"za", 35))
	if err := os.WriteFile(script, []byte(body), 0755); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestRunSemgrepScanParsesFakeEngine(t *testing.T) {
	home := fakeHome(t)
	binDir := fakeSemgrep(t)
	t.Setenv("PATH", binDir+":/usr/bin:/bin")
	t.Setenv("HOME", home)

	outcome := runSemgrepScan(t.TempDir())
	if !outcome.Available {
		t.Fatalf("fake engine should be detected: %+v", outcome)
	}
	if outcome.Version != "1.99.0" || outcome.Rules != 8 || outcome.Found != 2 {
		t.Fatalf("outcome = %+v", outcome)
	}
	if len(outcome.Results) != 2 {
		t.Fatalf("results = %+v", outcome.Results)
	}
}

func TestRepoSecurityScanMergesSemgrepFindings(t *testing.T) {
	repo := t.TempDir()
	mkfile(t, filepath.Join(repo, "app.js"), "function run(code) { return eval(code) }\n")
	mkfile(t, filepath.Join(repo, "key.txt"), "line1\ngoogle = "+fakeSecret("AI"+"za", 35)+"\n")

	t.Setenv("PATH", fakeSemgrep(t)+":/usr/bin:/bin")

	res, err := runRepoSecurityScan(repo)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Semgrep.Available || res.Semgrep.Rules != 8 || res.Semgrep.Found != 2 {
		t.Fatalf("semgrep info = %+v", res.Semgrep)
	}
	var codeRisk, codeSecret int
	for _, f := range res.Findings {
		switch f.Category {
		case "code-risk":
			codeRisk++
		case "code-secret":
			codeSecret++
			if strings.Contains(f.Snippet, fakeSecret("AI"+"za", 35)[:14]) {
				t.Fatalf("semgrep snippet leaked a secret: %+v", f)
			}
		}
	}
	if codeRisk != 1 || codeSecret != 1 {
		t.Fatalf("merged findings = %+v", res.Findings)
	}
}

func TestProbeSemgrepDegradesWhenBroken(t *testing.T) {
	// 装了一个永远 --version 失败的可执行文件：必须降级成不可用，而不是抛错
	dir := t.TempDir()
	broken := filepath.Join(dir, "semgrep")
	if err := os.WriteFile(broken, []byte("#!/nonexistent/interpreter\n"), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+":/usr/bin:/bin")
	t.Setenv("HOME", t.TempDir())

	if probe := probeSemgrep(); probe.Available {
		t.Fatalf("broken engine must not be reported available: %+v", probe)
	}
	outcome := runSemgrepScan(t.TempDir())
	if outcome.Available || len(outcome.Results) != 0 {
		t.Fatalf("broken engine outcome = %+v", outcome)
	}
}
