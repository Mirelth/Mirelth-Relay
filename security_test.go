package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMaskSecret(t *testing.T) {
	if got := maskSecret("short"); got != "••••••••" {
		t.Fatalf("short = %q", got)
	}
	long := fakeSecret("sk-", 16)
	got := maskSecret(long)
	if got != long[:4]+"……"+long[len(long)-4:] {
		t.Fatalf("long = %q", got)
	}
}

func TestDetectSecretsNamedPatterns(t *testing.T) {
	cases := []struct {
		line string
		kind string
	}{
		{"ANTHROPIC_API_KEY=" + fakeSecret("sk-"+"ant-", 20), "Anthropic 密钥"},
		{"OPENAI_API_KEY=" + fakeSecret("sk-"+"proj-", 20), "OpenAI 风格密钥"},
		{"token: " + fakeSecret("gh"+"p_", 26), "GitHub Token"},
		{"token: " + fakeSecret("github_"+"pat_", 24), "GitHub 细粒度 Token"},
		{"aws_access_key_id = " + "AKIA" + fakeUpper(16), "AWS AccessKey"},
		{"aliyun = " + fakeSecret("LT"+"AI", 16), "阿里云 AccessKey"},
		{"slack = " + fakeSecret("xo"+"xb-", 12), "Slack Token"},
		{"google = " + fakeSecret("AI"+"za", 35), "Google API Key"},
		{"stripe = " + fakeSecret("sk_"+"live_", 24), "Stripe 密钥"},
		{"gitlab = " + fakeSecret("gl"+"pat-", 22), "GitLab Token"},
	}
	for _, c := range cases {
		hits := detectSecrets(c.line)
		found := false
		for _, h := range hits {
			if h.Kind == c.kind {
				found = true
				if h.Line != 1 {
					t.Errorf("%s: line = %d", c.kind, h.Line)
				}
				if !strings.Contains(h.Masked, "……") {
					t.Errorf("%s: masked = %q should be truncated", c.kind, h.Masked)
				}
			}
		}
		if !found {
			t.Errorf("%s not detected in %q (hits=%+v)", c.kind, c.line, hits)
		}
	}
}

func TestDetectSecretsSkipsPlaceholdersAndNonSecrets(t *testing.T) {
	lines := []string{
		`api_key = "your-api-key-here-placeholder"`,
		`password = "example1234567890abc"`,
		`client_secret = "${CLIENT_SECRET_VALUE}"`,
		`token = "aaaaaaaaaabbbbbbbbbb"`, // 无数字
		`token = "12345678901234567890"`, // 无字母
	}
	text := strings.Join(lines, "\n")
	if hits := detectSecrets(text); len(hits) != 0 {
		t.Fatalf("placeholders/non-secrets must not be reported: %+v", hits)
	}
}

func TestDetectSecretsKVFormAndLineNumbers(t *testing.T) {
	text := "line one\napi_key = \"abcd1234efgh5678\"\nline three\npassword: 'zzzz9999yyyy8888'\n"
	hits := detectSecrets(text)
	if len(hits) != 2 {
		t.Fatalf("hits = %+v", hits)
	}
	if hits[0].Line != 2 || !strings.Contains(hits[0].Kind, "api_key") {
		t.Fatalf("first hit = %+v", hits[0])
	}
	if hits[1].Line != 4 || !strings.Contains(hits[1].Kind, "password") {
		t.Fatalf("second hit = %+v", hits[1])
	}
	if strings.Contains(hits[0].Masked, "efgh5678") {
		t.Fatalf("masked must not leak the tail: %q", hits[0].Masked)
	}
}

func TestDetectSecretsDedupesSameHit(t *testing.T) {
	line := `key = "` + fakeSecret("sk-", 20) + `"`
	hits := detectSecrets(line)
	// 命名规则与 KV 规则各命中一次（不同 kind），但同类不重复
	seen := map[string]int{}
	for _, h := range hits {
		seen[h.Kind]++
	}
	for kind, n := range seen {
		if n > 1 {
			t.Fatalf("kind %q reported %d times", kind, n)
		}
	}
}

func TestMaskSecretsInText(t *testing.T) {
	named := fakeSecret("sk-", 20)
	text := "echo " + named + " and api_key = \"abcd1234efgh5678\" and keep your-key-placeholder"
	masked := maskSecretsInText(text)
	if strings.Contains(masked, named) || strings.Contains(masked, "abcd1234efgh5678") {
		t.Fatalf("secrets leaked: %s", masked)
	}
	if !strings.Contains(masked, "keep your-key-placeholder") {
		t.Fatalf("placeholder must survive: %s", masked)
	}
}

func TestRunSecurityScanSeverityAndPermissions(t *testing.T) {
	home := fakeHome(t)

	// shell rc 里的密钥 → high
	rc := filepath.Join(home, ".zshrc")
	mkfile(t, rc, "export ANTHROPIC_API_KEY="+fakeSecret("sk-"+"ant-", 20)+"\n")
	if err := os.Chmod(rc, 0600); err != nil {
		t.Fatal(err)
	}

	// 同步目录里的密钥 → high
	syncedDir := filepath.Join(home, "Documents", "dotfiles")
	os.MkdirAll(syncedDir, 0700)
	synced := filepath.Join(syncedDir, "creds.env")
	mkfile(t, synced, "OPENAI_API_KEY="+fakeSecret("sk-"+"proj-", 20)+"\n")

	// 普通配置：600 + 密钥 → 只有 medium 明文
	strict := filepath.Join(home, ".agent", "config.json")
	mkfile(t, strict, `{"apiKey":"abcd1234efgh5678"}`)
	os.Chmod(strict, 0600)

	// 普通配置：644 + 密钥 → 权限过宽（high）
	loose := filepath.Join(home, ".agent", "loose.json")
	mkfile(t, loose, `{"apiKey":"abcd1234efgh5678"}`)
	os.Chmod(loose, 0644)

	// 任意可写 → high
	writable := filepath.Join(home, ".agent", "writable.json")
	mkfile(t, writable, `{"model":"x"}`)
	os.Chmod(writable, 0666)

	missing := filepath.Join(home, ".agent", "missing.json")
	files := []CandidateFile{
		{Path: synced, AgentID: "agent", AgentName: "Agent"},
		{Path: strict, AgentID: "agent", AgentName: "Agent"},
		{Path: loose, AgentID: "agent", AgentName: "Agent"},
		{Path: writable, AgentID: "agent", AgentName: "Agent"},
		{Path: missing, AgentID: "agent", AgentName: "Agent"},
	}

	res := runSecurityScan(files)
	if res.ScannedFiles != 5 { // 5 个候选里 4 个存在 + .zshrc
		t.Fatalf("scannedFiles = %d", res.ScannedFiles)
	}
	if res.CheckedPaths != len(files)+8 {
		t.Fatalf("checkedPaths = %d", res.CheckedPaths)
	}

	// 按文件名归类：绕过 /var ↔ /private/var 这类系统软链造成的路径字符串差异。
	sevByPath := map[string][]string{}
	kindByPath := map[string][]string{}
	for _, f := range res.Findings {
		key := filepath.Base(f.Path)
		sevByPath[key] = append(sevByPath[key], f.Severity)
		kindByPath[key] = append(kindByPath[key], f.Kind)
	}
	if got := sevByPath[".zshrc"]; len(got) == 0 || got[0] != "high" {
		t.Fatalf("shell rc findings = %v", got)
	}
	if got := sevByPath["creds.env"]; len(got) == 0 || got[0] != "high" {
		t.Fatalf("synced finding severity = %v", got)
	}
	if got := sevByPath["config.json"]; len(got) != 1 || got[0] != "medium" {
		t.Fatalf("0600 config should only be medium: %v", got)
	}
	if got := kindByPath["loose.json"]; len(got) == 0 || !strings.Contains(strings.Join(got, "|"), "权限过宽") {
		t.Fatalf("0644 config should report loose permissions: %v", got)
	}
	if got := kindByPath["writable.json"]; len(got) != 1 || got[0] != "任意用户可写" {
		t.Fatalf("0666 finding = %v", got)
	}
	if _, ok := sevByPath["missing.json"]; ok {
		t.Fatal("missing file must not produce findings")
	}

	// 排序：high 全在 medium 之前
	seenMedium := false
	for _, f := range res.Findings {
		if f.Severity == "medium" {
			seenMedium = true
		} else if seenMedium && f.Severity == "high" {
			t.Fatal("findings must be sorted high → medium")
		}
		if strings.Contains(f.Snippet, "efgh5678") {
			t.Fatalf("snippet leaked a secret: %+v", f)
		}
	}
}

func TestRunSecurityScanCountingMissingFiles(t *testing.T) {
	fakeHome(t)
	res := runSecurityScan(nil)
	if res.CheckedPaths != 8 || res.ScannedFiles != 0 || len(res.Findings) != 0 {
		t.Fatalf("empty home = %+v", res)
	}
	if res.At == "" {
		t.Fatal("scan time must be recorded")
	}
}

func TestSecurityScanBindingThroughCache(t *testing.T) {
	home := fakeHome(t)
	mkfile(t, filepath.Join(home, ".zcode/v2/config.json"), `{"apiKey":"abcd1234efgh5678"}`)
	os.Chmod(filepath.Join(home, ".zcode/v2/config.json"), 0600)

	app := &App{store: testStore(t)}
	app.scanAndCache("")
	out := app.RunSecurityScan()
	if !strings.Contains(out, "plaintext-secret") {
		t.Fatalf("scan should report the cached agent config secret: %s", out)
	}
	if strings.Contains(out, "efgh5678") {
		t.Fatalf("binding leaked a secret: %s", out)
	}
}

// 密钥形态的测试数据一律运行时拼装：完整形态写进源码会被 GitHub 推送保护拦下（这些是假数据）。
func fakeBody(n int) string {
	const alphabet = "a1B2c3D4e5"
	out := ""
	for len(out) < n {
		out += alphabet
	}
	return out[:n]
}

func fakeUpper(n int) string {
	const alphabet = "AB12CD34EF56"
	out := ""
	for len(out) < n {
		out += alphabet
	}
	return out[:n]
}

func fakeSecret(prefix string, n int) string { return prefix + fakeBody(n) }
