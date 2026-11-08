package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeFile(t *testing.T, dir, name, content string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestReadJSONCFallsBackToStrippingComments(t *testing.T) {
	dir := t.TempDir()
	p := writeFile(t, dir, "opencode.jsonc", `{
  // 这是行注释
  "provider": { "deepseek": { "baseURL": "https://api.deepseek.com/v1" } },
  /* 块注释
     跨两行 */
  "model": "deepseek/deepseek-chat"
}`)
	cfg := readJSONC(p)
	if cfg == nil {
		t.Fatal("jsonc with comments must still parse")
	}
	provider, ok := cfg["provider"].(map[string]any)
	if !ok || provider["deepseek"] == nil {
		t.Fatalf("nested object lost: %#v", cfg)
	}
	if cfg["model"] != "deepseek/deepseek-chat" {
		t.Fatalf("model = %v", cfg["model"])
	}
}

func TestReadJSONCDoesNotEatURLScheme(t *testing.T) {
	dir := t.TempDir()
	p := writeFile(t, dir, "c.jsonc", `{"baseURL": "https://api.example.com/v1", "note": "a // b"}`)
	cfg := readJSONC(p)
	if cfg == nil || cfg["baseURL"] != "https://api.example.com/v1" {
		t.Fatalf("plain json must be untouched: %#v", cfg)
	}
}

func TestReadJSONReturnsNilOnBrokenFile(t *testing.T) {
	dir := t.TempDir()
	p := writeFile(t, dir, "broken.json", "{not json")
	if got := readJSON(p); got != nil {
		t.Fatalf("broken json should read as nil, got %#v", got)
	}
	if got := readJSON(filepath.Join(dir, "missing.json")); got != nil {
		t.Fatal("missing file should read as nil")
	}
}

func TestReadYAMLNormalizesNestedMaps(t *testing.T) {
	dir := t.TempDir()
	p := writeFile(t, dir, "settings.yaml", `
llm-pi-ai:
  providers:
    deepseek:
      base_url: https://api.deepseek.com/v1
      models:
        - deepseek-chat
        - deepseek-reasoner
`)
	cfg := readYAML(p)
	if cfg == nil {
		t.Fatal("yaml must parse")
	}
	root, ok := cfg["llm-pi-ai"].(map[string]any)
	if !ok {
		t.Fatalf("top level not normalized: %#v", cfg)
	}
	providers := root["providers"].(map[string]any)
	ds := providers["deepseek"].(map[string]any)
	if ds["base_url"] != "https://api.deepseek.com/v1" {
		t.Fatalf("value = %v", ds["base_url"])
	}
	models, ok := ds["models"].([]any)
	if !ok || len(models) != 2 || models[0] != "deepseek-chat" {
		t.Fatalf("models = %#v", ds["models"])
	}
}

func TestRedactHidesCredentials(t *testing.T) {
	namedKey := fakeSecret("sk-", 16)
	in := map[string]any{
		"apiKey":   "abcdefgh12345678",
		"name":     "DeepSeek",
		"nested":   map[string]any{"authorization": "Bearer abcdefghijk"},
		"literal":  namedKey,
		"shortKey": "abc",
		"list":     []any{namedKey, "plain"},
	}
	out := redact(in).(map[string]any)

	if got := out["apiKey"]; got != "••••••••5678" {
		t.Fatalf("apiKey = %v, want masked with last 4", got)
	}
	if out["name"] != "DeepSeek" {
		t.Fatal("non-sensitive fields must survive")
	}
	nested := out["nested"].(map[string]any)
	if !strings.HasPrefix(nested["authorization"].(string), "••••••••") {
		t.Fatalf("authorization = %v", nested["authorization"])
	}
	if out["literal"] != "••••••••" {
		t.Fatalf("named literal = %v", out["literal"])
	}
	if out["shortKey"] != "abc" {
		t.Fatal("too-short values must not be masked (nothing to hide)")
	}
	list := out["list"].([]any)
	if list[0] != "••••••••" || list[1] != "plain" {
		t.Fatalf("list = %#v", list)
	}
}

func TestRedactBoundsDepthAndArrayLength(t *testing.T) {
	deep := any("leaf")
	for i := 0; i < 12; i++ {
		deep = map[string]any{"n": deep}
	}
	if got := redact(deep); got == nil {
		t.Fatal("deep nesting must not panic")
	}
	long := make([]any, 50)
	for i := range long {
		long[i] = i
	}
	if out := redact(long).([]any); len(out) != 20 {
		t.Fatalf("array = %d, want truncated to 20", len(out))
	}
}

func TestParseSkillFileFrontmatter(t *testing.T) {
	dir := t.TempDir()
	p := writeFile(t, dir, "SKILL.md", "---\nname: pdf-tools\ndescription: \"处理 PDF 的技能\"\nversion: 1.2.0\nother: ignored\n---\n\n正文\n")
	meta := parseSkillFile(p)
	if meta.Name != "pdf-tools" || meta.Description != "处理 PDF 的技能" || meta.Version != "1.2.0" {
		t.Fatalf("meta = %+v", meta)
	}
	if got := parseSkillFile(filepath.Join(dir, "missing.md")); got.Name != "" {
		t.Fatalf("missing skill file should be empty, got %+v", got)
	}
	noFM := writeFile(t, dir, "plain.md", "# 没有 frontmatter\n")
	if got := parseSkillFile(noFM); got.Name != "" {
		t.Fatalf("no frontmatter should be empty, got %+v", got)
	}
}

func TestDirSizeReportsMinusOneForMissingPath(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "a.txt", strings.Repeat("x", 100))
	writeFile(t, dir, "sub/b.txt", strings.Repeat("y", 50))
	if got := dirSize(dir); got != 150 {
		t.Fatalf("dirSize = %d, want 150", got)
	}
	if got := dirSize(filepath.Join(dir, "nope")); got != -1 {
		t.Fatalf("missing dir = %d, want -1", got)
	}
	// node_modules 不计入（依赖体积没有参考价值）
	writeFile(t, dir, "node_modules/c.txt", strings.Repeat("z", 10_000))
	if got := dirSize(dir); got != 150 {
		t.Fatalf("dirSize should skip node_modules, got %d", got)
	}
}

func TestLoadForWriteRefusesUnparseableFile(t *testing.T) {
	dir := t.TempDir()
	broken := writeFile(t, dir, "settings.json", "{ broken")
	if _, err := loadForWrite(broken, func(string) map[string]any { return nil }); err == nil {
		t.Fatal("existing but unparseable config must block the write")
	} else if !errors.Is(err, errConfigWrite) {
		t.Fatalf("error = %v, want configWriteError", err)
	}
	missing := filepath.Join(dir, "new.json")
	obj, err := loadForWrite(missing, func(string) map[string]any { return nil })
	if err != nil || obj == nil || len(obj) != 0 {
		t.Fatalf("missing file should yield an empty object: %v %v", obj, err)
	}
}

func TestCommitWithVerifyRollsBackOnBadWrite(t *testing.T) {
	dir := t.TempDir()
	p := writeFile(t, dir, "settings.json", `{"hooks":{"PreToolUse":[]}}`)
	bak, err := commitWithVerify(p,
		func() error { return os.WriteFile(p, []byte("{ 写坏了"), 0600) },
		func(path string) map[string]any { return readJSON(path) })
	if err == nil {
		t.Fatal("verification failure must be reported")
	}
	if bak == "" || !exists(bak) {
		t.Fatalf("backup must stay on disk, got %q", bak)
	}
	restored, _ := readText(p)
	if !strings.Contains(restored, "PreToolUse") {
		t.Fatalf("original must be restored, got %s", restored)
	}
}

func TestCommitWithVerifyRemovesNewFileOnBadWrite(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "new-config.json")
	if _, err := commitWithVerify(p,
		func() error { return os.WriteFile(p, []byte("not json"), 0600) },
		func(path string) map[string]any { return readJSON(path) }); err == nil {
		t.Fatal("verification failure must be reported")
	}
	if exists(p) {
		t.Fatal("a half-written new file must be removed")
	}
}

func TestCommitWithVerifySucceedsAndKeepsBackup(t *testing.T) {
	dir := t.TempDir()
	p := writeFile(t, dir, "settings.json", `{"old":true}`)
	bak, err := commitWithVerify(p,
		func() error { return os.WriteFile(p, []byte(`{"new":true}`), 0600) },
		func(path string) map[string]any { return readJSON(path) })
	if err != nil {
		t.Fatalf("write should succeed: %v", err)
	}
	if bak == "" || !exists(bak) {
		t.Fatalf("backup should exist, got %q", bak)
	}
	now := readJSON(p)
	if now["new"] != true {
		t.Fatalf("content = %#v", now)
	}
}

func TestResolveBinLooksInExtraDirs(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "some-cli")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\n"), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+":/usr/bin:/bin")
	if got := resolveBin("some-cli"); got != bin {
		t.Fatalf("resolveBin = %q, want %q", got, bin)
	}
	if got := resolveBin("definitely-not-installed-cli"); got != "" {
		t.Fatalf("unknown bin = %q", got)
	}
	// 非可执行文件不算命中
	plain := filepath.Join(dir, "plain-file")
	if err := os.WriteFile(plain, nil, 0644); err != nil {
		t.Fatal(err)
	}
	if got := resolveBin("plain-file"); got != "" {
		t.Fatalf("non-executable file must not resolve, got %q", got)
	}
}

func TestReadAppBundleVersionReadsPlist(t *testing.T) {
	if resolveBin("plutil") == "" {
		t.Skip("plutil 不可用")
	}
	dir := t.TempDir()
	app := filepath.Join(dir, "Fake.app")
	writeFile(t, app, "Contents/Info.plist", `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleShortVersionString</key><string>1.2.3</string>
</dict></plist>`)
	if got := readAppBundleVersion(app); got != "1.2.3" {
		t.Fatalf("version = %q, want 1.2.3", got)
	}
	if got := readAppBundleVersion(filepath.Join(dir, "Missing.app")); got != "" {
		t.Fatalf("missing bundle = %q", got)
	}
}
