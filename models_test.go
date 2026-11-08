package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ---------- Hooks ----------

func TestCreateAndDeleteHook(t *testing.T) {
	home := fakeHome(t)
	settings := filepath.Join(home, ".claude/settings.json")
	mkfile(t, settings, `{"model":"claude-sonnet"}`)

	app := &App{}
	var created struct{ BackupPath, Error string }
	if err := json.Unmarshal([]byte(app.CreateHook(HookCreateInput{
		AgentID: "claude-code", Event: "PreToolUse", Matcher: "Bash", Command: "  echo hi  ", Timeout: 30,
	})), &created); err != nil {
		t.Fatal(err)
	}
	if created.Error != "" || created.BackupPath == "" {
		t.Fatalf("create = %+v", created)
	}

	cfg := readJSON(settings)
	if cfg["model"] != "claude-sonnet" {
		t.Fatal("unrelated keys must survive")
	}
	hooks := cfg["hooks"].(map[string]any)
	groups := hooks["PreToolUse"].([]any)
	group := groups[0].(map[string]any)
	if group["matcher"] != "Bash" {
		t.Fatalf("matcher = %v", group["matcher"])
	}
	inner := group["hooks"].([]any)[0].(map[string]any)
	if inner["command"] != "echo hi" || inner["type"] != "command" || intOf(inner["timeout"]) != 30 {
		t.Fatalf("inner hook = %+v", inner)
	}

	var entries []HookEntry
	if err := json.Unmarshal([]byte(app.ListHooks()), &entries); err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Event != "PreToolUse" || entries[0].Command != "echo hi" {
		t.Fatalf("entries = %+v", entries)
	}

	var targets []HooksTarget
	_ = json.Unmarshal([]byte(app.ListHookTargets()), &targets)
	var claude *HooksTarget
	for i := range targets {
		if targets[i].AgentID == "claude-code" {
			claude = &targets[i]
		}
	}
	if claude == nil || !claude.Exists || !claude.Verified || claude.HookCount != 1 {
		t.Fatalf("target = %+v", claude)
	}

	var deleted struct{ BackupPath, Error string }
	_ = json.Unmarshal([]byte(app.DeleteHook(entries[0].ID)), &deleted)
	if deleted.Error != "" {
		t.Fatalf("delete = %+v", deleted)
	}
	cfg = readJSON(settings)
	if _, still := cfg["hooks"]; still {
		t.Fatalf("empty hooks key should be removed: %+v", cfg)
	}
}

func TestCreateHookRejectsBadInputs(t *testing.T) {
	home := fakeHome(t)
	mkfile(t, filepath.Join(home, ".claude/settings.json"), `{}`)
	app := &App{}

	cases := []HookCreateInput{
		{AgentID: "nope", Event: "Stop", Command: "x"},
		{AgentID: "qoder", Event: "Stop", Command: "x"}, // qoder 的 settings 不存在
		{AgentID: "claude-code", Event: "Stop", Command: "   "},
		{AgentID: "claude-code", Event: "", Command: "x"},
	}
	for _, c := range cases {
		out := app.CreateHook(c)
		if !strings.Contains(out, "error") {
			t.Errorf("input %+v should be rejected: %s", c, out)
		}
	}

	// 坏 JSON：必须拒写且原文件不动
	broken := filepath.Join(home, ".claude/settings.json")
	if err := os.WriteFile(broken, []byte("{ broken"), 0600); err != nil {
		t.Fatal(err)
	}
	out := app.CreateHook(HookCreateInput{AgentID: "claude-code", Event: "Stop", Command: "x"})
	if !strings.Contains(out, "error") {
		t.Fatalf("unparseable settings must be rejected: %s", out)
	}
	raw, _ := os.ReadFile(broken)
	if string(raw) != "{ broken" {
		t.Fatalf("original file must stay untouched: %s", raw)
	}
}

func TestDeleteHookWithBadID(t *testing.T) {
	fakeHome(t)
	app := &App{}
	for _, id := range []string{"", "garbage", "claude-code|Stop", "claude-code|Stop|99|cmd"} {
		if out := app.DeleteHook(id); !strings.Contains(out, "error") {
			t.Errorf("id %q should fail: %s", id, out)
		}
	}
}

// ---------- 模型 Profile ----------

func TestSaveModelProfilePreservesMaskedKey(t *testing.T) {
	fakeHome(t)
	app := &App{}

	if out := app.SaveModelProfile(`{"error":"x"}`); !strings.Contains(out, "error") {
		t.Fatalf("missing id must fail: %s", out)
	}
	if out := app.SaveModelProfile(`{"id":"p1","name":"DS","kind":"openai-compatible","baseURL":"https://x/v1","apiKey":"sk-secret-12345678","models":[{"id":"m1"}]}`); !strings.Contains(out, `"ok":true`) {
		t.Fatalf("save failed: %s", out)
	}
	// 第二次带脱敏 key 保存：原 key 必须保留
	if out := app.SaveModelProfile(`{"id":"p1","name":"DS2","kind":"openai-compatible","baseURL":"https://x/v1","apiKey":"sk-s••••••••5678","models":[{"id":"m1"}]}`); !strings.Contains(out, `"ok":true`) {
		t.Fatalf("second save failed: %s", out)
	}

	var views []ModelProfileView
	if err := json.Unmarshal([]byte(app.ListModelProfiles()), &views); err != nil {
		t.Fatal(err)
	}
	if len(views) != 1 || views[0].Name != "DS2" {
		t.Fatalf("views = %+v", views)
	}
	if strings.Contains(toJSON(views), "sk-secret") {
		t.Fatal("api key must never appear in views")
	}
	if !strings.Contains(views[0].APIKeyMasked, "••") || !views[0].HasAPIKey {
		t.Fatalf("mask = %+v", views[0])
	}
	if stored := loadModelProfiles()[0]; stored.APIKey != "sk-secret-12345678" {
		t.Fatalf("stored key = %q", stored.APIKey)
	}
}

func TestDeleteModelProfile(t *testing.T) {
	fakeHome(t)
	app := &App{}
	app.SaveModelProfile(`{"id":"p1","name":"A","kind":"openai-compatible","baseURL":"u","apiKey":"k","models":[]}`)
	app.SaveModelProfile(`{"id":"p2","name":"B","kind":"openai-compatible","baseURL":"u","apiKey":"k","models":[]}`)
	if out := app.DeleteModelProfile("p1"); !strings.Contains(out, `"ok":true`) {
		t.Fatalf("delete failed: %s", out)
	}
	if got := loadModelProfiles(); len(got) != 1 || got[0].ID != "p2" {
		t.Fatalf("profiles = %+v", got)
	}
}

// ---------- 写入器 ----------

func TestApplyProfileToZCodeWritesProviderAndBacksUp(t *testing.T) {
	home := fakeHome(t)
	cfgPath := filepath.Join(home, ".zcode/v2/config.json")
	mkfile(t, cfgPath, `{"provider":{},"other":"keep"}`)

	app := &App{}
	app.SaveModelProfile(`{"id":"ds","name":"DeepSeek","kind":"openai-compatible","baseURL":"https://api.deepseek.com/v1","apiKey":"sk-x","models":[{"id":"deepseek-chat","name":"Chat","contextWindow":128000}],"defaultModel":"deepseek-chat"}`)

	var results []ApplyResult
	if err := json.Unmarshal([]byte(app.ApplyModelProfile("ds", []string{"zcode"}, `{"setDefault":true}`)), &results); err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || !results[0].OK || results[0].BackupPath == "" {
		t.Fatalf("results = %+v", results)
	}
	if !strings.Contains(results[0].Message, "agentmgr:ds") {
		t.Fatalf("message = %s", results[0].Message)
	}

	cfg := readJSON(cfgPath)
	if cfg["other"] != "keep" {
		t.Fatal("unrelated keys must survive")
	}
	provider := cfg["provider"].(map[string]any)["agentmgr:ds"].(map[string]any)
	if provider["name"] != "DeepSeek" || provider["kind"] != "openai" || provider["enabled"] != true {
		t.Fatalf("provider = %+v", provider)
	}
	if provider["options"].(map[string]any)["apiKey"] != "sk-x" {
		t.Fatal("api key should be written to the agent config")
	}
	models := provider["models"].(map[string]any)["deepseek-chat"].(map[string]any)
	if models["name"] != "Chat" {
		t.Fatalf("model entry = %+v", models)
	}
	if intOf(models["limit"].(map[string]any)["context"]) != 128000 {
		t.Fatalf("limit = %+v", models["limit"])
	}
}

func TestApplyProfileToYcliWritesFlatYaml(t *testing.T) {
	home := fakeHome(t)
	cfgPath := filepath.Join(home, ".ycli/config.yaml")
	mkfile(t, cfgPath, "provider: old\nmodel: old-model\napi_key: old-key\nbase_url: old-url\nextra: keep\n")

	app := &App{}
	app.SaveModelProfile(`{"id":"qwen","name":"Qwen","kind":"openai-compatible","baseURL":"https://qwen/v1","apiKey":"sk-q","models":[{"id":"qwen-max"}],"defaultModel":"qwen-max"}`)
	var results []ApplyResult
	_ = json.Unmarshal([]byte(app.ApplyModelProfile("qwen", []string{"ycli"}, "")), &results)
	if len(results) != 1 || !results[0].OK {
		t.Fatalf("results = %+v", results)
	}

	cfg := readYAML(cfgPath)
	if cfg["provider"] != "openai" || cfg["model"] != "qwen-max" || cfg["api_key"] != "sk-q" || cfg["base_url"] != "https://qwen/v1" {
		t.Fatalf("cfg = %+v", cfg)
	}
	if cfg["extra"] != "keep" {
		t.Fatalf("unrelated yaml keys must survive: %+v", cfg)
	}
}

func TestApplyProfileRefusesBrokenConfig(t *testing.T) {
	home := fakeHome(t)
	cfgPath := filepath.Join(home, ".zcode/v2/config.json")
	mkfile(t, cfgPath, "{ broken")

	app := &App{}
	app.SaveModelProfile(`{"id":"ds","name":"DS","kind":"openai-compatible","baseURL":"u","apiKey":"k","models":[]}`)
	var results []ApplyResult
	_ = json.Unmarshal([]byte(app.ApplyModelProfile("ds", []string{"zcode"}, "")), &results)
	if len(results) != 1 || results[0].OK {
		t.Fatalf("broken config must be refused: %+v", results)
	}
	raw, _ := os.ReadFile(cfgPath)
	if string(raw) != "{ broken" {
		t.Fatalf("original must stay untouched: %s", raw)
	}
}

func TestApplyProfileReportsUnknownAndMissingTargets(t *testing.T) {
	fakeHome(t)
	app := &App{}
	app.SaveModelProfile(`{"id":"ds","name":"DS","kind":"openai-compatible","baseURL":"u","apiKey":"k","models":[]}`)

	var results []ApplyResult
	_ = json.Unmarshal([]byte(app.ApplyModelProfile("ds", []string{"trae-cn", "zcode", "nope"}, "")), &results)
	if len(results) != 3 {
		t.Fatalf("results = %+v", results)
	}
	byID := map[string]ApplyResult{}
	for _, r := range results {
		byID[r.AgentID] = r
	}
	if byID["trae-cn"].OK || !strings.Contains(byID["trae-cn"].Message, "不支持") {
		t.Fatalf("trae = %+v", byID["trae-cn"])
	}
	if byID["zcode"].OK || !strings.Contains(byID["zcode"].Message, "未检测到") {
		t.Fatalf("zcode = %+v", byID["zcode"])
	}
	if byID["nope"].OK {
		t.Fatalf("unknown = %+v", byID["nope"])
	}

	// profile 不存在
	_ = json.Unmarshal([]byte(app.ApplyModelProfile("ghost", []string{"zcode"}, "")), &results)
	if len(results) != 1 || results[0].OK {
		t.Fatalf("missing profile = %+v", results)
	}
}

func TestListAppliersShowsDetectedAndUnsupported(t *testing.T) {
	home := fakeHome(t)
	mkfile(t, filepath.Join(home, ".zcode/v2/config.json"), `{"provider":{"mine":{"enabled":true},"off":{"enabled":false}}}`)
	mkfile(t, filepath.Join(home, ".ycli/config.yaml"), "provider: openai\nmodel: m\nbase_url: u\n")

	var info []ApplierInfo
	if err := json.Unmarshal([]byte((&App{}).ListAppliers()), &info); err != nil {
		t.Fatal(err)
	}
	byID := map[string]ApplierInfo{}
	for _, i := range info {
		byID[i.AgentID] = i
	}
	if got := byID["zcode"]; got.Support != "full" || !strings.Contains(got.Current, "mine") || !strings.Contains(got.Current, "停用") {
		t.Fatalf("zcode = %+v", got)
	}
	if got := byID["ycli"]; got.Support != "full" || !strings.Contains(got.Current, "openai") {
		t.Fatalf("ycli = %+v", got)
	}
	if got := byID["opencode"]; got.Support != "none" {
		t.Fatalf("undetected applier should report none: %+v", got)
	}
	if got := byID["trae-cn"]; got.Support != "none" || got.Current != "—" {
		t.Fatalf("unsupported = %+v", got)
	}
}

func TestFetchModelCatalog(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer sk-test" {
			t.Errorf("auth = %q", r.Header.Get("Authorization"))
		}
		_, _ = fmt.Fprint(w, `{"data":[{"id":"m2"},{"id":"m1"}]}`)
	}))
	defer srv.Close()

	var out struct {
		OK     bool             `json:"ok"`
		Models []map[string]any `json:"models"`
	}
	if err := json.Unmarshal([]byte((&App{}).FetchModelCatalog(srv.URL+"/v1", "sk-test", "openai-compatible")), &out); err != nil {
		t.Fatal(err)
	}
	if !out.OK || len(out.Models) != 2 || out.Models[0]["id"] != "m1" {
		t.Fatalf("out = %+v", out)
	}

	// 错误状态码
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer bad.Close()
	if err := json.Unmarshal([]byte((&App{}).FetchModelCatalog(bad.URL, "k", "openai-compatible")), &out); err != nil {
		t.Fatal(err)
	}
	if out.OK {
		t.Fatalf("401 must be reported as failure: %+v", out)
	}
	// 空 baseURL
	if err := json.Unmarshal([]byte((&App{}).FetchModelCatalog("", "k", "")), &out); err != nil {
		t.Fatal(err)
	}
	if out.OK {
		t.Fatal("empty baseURL must fail")
	}
}

func TestEnvKeyPart(t *testing.T) {
	cases := map[string]string{
		"ds":        "DS",
		"dsh-web":   "DSH_WEB",
		"my.prof 1": "MY_PROF_1",
	}
	for in, want := range cases {
		if got := envKeyPart(in); got != want {
			t.Errorf("envKeyPart(%q) = %q, want %q", in, got, want)
		}
	}
}
