package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 旧配置（无 schemaVersion、无 models）必须能无感升级为账号池，并且升级前留一份原文快照。
func TestConfigMigratesFlatUpstreamsAndKeepsBackup(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".relay")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	legacy := `{"port":8899,"apiKey":"atgw-legacy","upstreams":[{"id":"a","name":"Alpha","baseURL":"https://a.example/v1","apiKey":"sk-a","model":"gpt-4o","kind":"","enabled":true}],"rateUsdCny":7.1}`
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, []byte(legacy), 0600); err != nil {
		t.Fatal(err)
	}

	cfg, warning, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if warning != "" {
		t.Fatalf("unexpected migration warning: %s", warning)
	}
	if cfg.SchemaVersion != configSchema {
		t.Fatalf("schemaVersion = %d, want %d", cfg.SchemaVersion, configSchema)
	}
	if cfg.Port != 8899 || cfg.APIKey != "atgw-legacy" || cfg.RateUSDCNY != 7.1 {
		t.Fatalf("既有字段被覆盖: %+v", cfg)
	}
	if len(cfg.Upstreams) != 1 {
		t.Fatalf("upstreams = %d", len(cfg.Upstreams))
	}
	u := cfg.Upstreams[0]
	if u.Kind != "openai" {
		t.Fatalf("kind = %q, want openai", u.Kind)
	}
	if len(u.Models) != 1 || u.Models[0] != "gpt-4o" {
		t.Fatalf("models = %v, want [gpt-4o]", u.Models)
	}
	if !u.serves("gpt-4o") {
		t.Fatal("migrated account should serve its model")
	}

	backups, err := filepath.Glob(filepath.Join(dir, "config.json.bak-*"))
	if err != nil {
		t.Fatal(err)
	}
	if len(backups) != 1 {
		t.Fatalf("backups = %v, want exactly one", backups)
	}
	kept, err := os.ReadFile(backups[0])
	if err != nil {
		t.Fatal(err)
	}
	if string(kept) != legacy {
		t.Fatal("backup must hold the original bytes verbatim")
	}

	saved, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(saved), `"schemaVersion": 2`) {
		t.Fatalf("saved config missing schemaVersion: %s", saved)
	}
}

func TestConfigMigrationRunsOnlyOnce(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".relay")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, []byte(`{"port":8790,"upstreams":[]}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := loadConfig(); err != nil {
		t.Fatal(err)
	}
	if _, _, err := loadConfig(); err != nil {
		t.Fatal(err)
	}
	backups, _ := filepath.Glob(filepath.Join(dir, "config.json.bak-*"))
	if len(backups) != 1 {
		t.Fatalf("backups = %d, want 1 (migration must not repeat)", len(backups))
	}
}

func TestUpstreamServesModel(t *testing.T) {
	cases := []struct {
		name    string
		account Upstream
		model   string
		want    bool
	}{
		{"声明列表命中", Upstream{Enabled: true, Models: []string{"a", "b"}}, "B", true},
		{"声明列表未命中", Upstream{Enabled: true, Models: []string{"a"}}, "c", false},
		{"显式列表为权威，不回落旧模型字段", Upstream{Enabled: true, Models: []string{"claude-sonnet"}, Model: "gpt-4o"}, "gpt-4o", false},
		{"显式列表为权威，旧 ID 别名也不再生效", Upstream{Enabled: true, Models: []string{"claude-sonnet"}, Model: "gpt-4o", ID: "openai-main"}, "openai-main", false},
		{"无列表回落单模型", Upstream{Enabled: true, Model: "gpt-4o"}, "gpt-4o", true},
		{"按 ID 别名命中", Upstream{Enabled: true, Model: "gpt-4o", ID: "openai-main"}, "openai-main", true},
		{"停用即不参与", Upstream{Enabled: false, Model: "gpt-4o"}, "gpt-4o", false},
		{"全部留空视为通配", Upstream{Enabled: true}, "anything", true},
		{"空模型请求命中任意启用账号", Upstream{Enabled: true, Models: []string{"a"}}, "", true},
	}
	for _, tc := range cases {
		if got := tc.account.serves(tc.model); got != tc.want {
			t.Errorf("%s: serves(%q) = %v, want %v", tc.name, tc.model, got, tc.want)
		}
	}
}

func TestUpstreamWeightDefaultsToOne(t *testing.T) {
	if (&Upstream{}).weight() != 1 {
		t.Fatal("missing weight must read as 1")
	}
	if (&Upstream{Weight: 5}).weight() != 5 {
		t.Fatal("explicit weight must be kept")
	}
}

// 短 key 曾让 maskKey 切片越界 panic，设置页于是卡在「加载中」。任何长度都必须安全。
func TestMaskKeyNeverPanics(t *testing.T) {
	cases := map[string]string{
		"":                   "",
		"sk":                 "****",
		"abc":                "****",
		"abcd":               "abcd****",
		"atgw-abcdefgh1234":  "atgw-abc****1234",
		"atgw-0123456789abc": "atgw-012****9abc",
	}
	for in, want := range cases {
		if got := maskKey(in); got != want {
			t.Errorf("maskKey(%q) = %q, want %q", in, got, want)
		}
	}
}

// 迁移写盘失败时不能把已解析的配置丢掉（否则网关会用空上游 + 新 key 启动，下次保存就覆盖真实配置）。
func TestConfigMigrationFailureKeepsLoadedConfig(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".relay")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	legacy := `{"port":8899,"apiKey":"atgw-legacy","upstreams":[{"id":"a","name":"Alpha","baseURL":"https://a.example/v1","apiKey":"sk-a","model":"gpt-4o","enabled":true}]}`
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, []byte(legacy), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0700) })

	cfg, warning, err := loadConfig()
	if err != nil {
		t.Fatalf("迁移失败不应变成致命错误: %v", err)
	}
	if warning == "" {
		t.Fatal("迁移失败必须回传 warning 供界面提示")
	}
	if cfg.Port != 8899 || cfg.APIKey != "atgw-legacy" || len(cfg.Upstreams) != 1 {
		t.Fatalf("已解析的配置必须保留，得到 %+v", cfg)
	}
	kept, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(kept) != legacy {
		t.Fatal("迁移失败时磁盘上的原文件必须原样保留")
	}
}
