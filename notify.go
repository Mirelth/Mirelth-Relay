package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	goruntime "runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

var notifyMu sync.Mutex
var lastNotify time.Time

func notifyThrottled(title, message string) {
	notifyMu.Lock()
	if time.Since(lastNotify) < 30*time.Second {
		notifyMu.Unlock()
		return
	}
	lastNotify = time.Now()
	notifyMu.Unlock()
	systemNotify(title, message)
}

// 跨平台系统通知：macOS 用 osascript，Linux 用 notify-send，Windows 用 PowerShell。
func systemNotify(title, message string) {
	var cmd *exec.Cmd
	switch goruntime.GOOS {
	case "darwin":
		script := fmt.Sprintf(`display notification %q with title %q`, message, title)
		cmd = exec.Command("osascript", "-e", script)
	case "linux":
		cmd = exec.Command("notify-send", title, message)
	case "windows":
		script := fmt.Sprintf(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show(%q, %q)`, message, title)
		cmd = exec.Command("powershell", "-NoProfile", "-Command", script)
	default:
		return
	}
	_ = cmd.Start()
}

type UpdateInfo struct {
	Current         string            `json:"current"`
	Latest          string            `json:"latest,omitempty"`
	UpdateAvailable bool              `json:"updateAvailable,omitempty"`
	HasUpdate       bool              `json:"hasUpdate"`
	Notes           string            `json:"notes,omitempty"`
	PublishedAt     string            `json:"publishedAt,omitempty"`
	Downloads       map[string]string `json:"downloads,omitempty"`
	Error           string            `json:"error,omitempty"`
	CheckedAt       string            `json:"checkedAt"`
}

func (a *App) CheckUpdate() string { return toJSON(a.checkUpdate(false)) }

func (a *App) checkUpdate(emit bool) UpdateInfo {
	info := UpdateInfo{Current: appVersion, CheckedAt: time.Now().Format(time.RFC3339)}
	url := a.cfg.UpdateURL
	if url == "" {
		url = defaultUpdateURL
	}
	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		info.Error = err.Error()
		return info
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		info.Error = fmt.Sprintf("HTTP %d", resp.StatusCode)
		return info
	}
	var feed struct {
		Version     string            `json:"version"`
		Notes       string            `json:"notes"`
		PublishedAt string            `json:"publishedAt"`
		Downloads   map[string]string `json:"downloads"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&feed); err != nil {
		info.Error = err.Error()
		return info
	}
	info.Latest = feed.Version
	info.Notes = feed.Notes
	info.PublishedAt = feed.PublishedAt
	info.Downloads = feed.Downloads
	info.UpdateAvailable = newerVersion(feed.Version, appVersion)
	info.HasUpdate = info.UpdateAvailable
	if emit && info.HasUpdate && a.ctx != nil {
		systemNotify("Relay 有新版本", feed.Version+" 可用")
		runtime.EventsEmit(a.ctx, "update:available", info)
	}
	return info
}

// 启动后定期检查更新；失败静默，不影响主流程。
func (a *App) startUpdateChecker() {
	go func() {
		time.Sleep(30 * time.Second)
		a.checkUpdate(true)
		ticker := time.NewTicker(6 * time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			a.checkUpdate(true)
		}
	}()
}

func newerVersion(latest, current string) bool {
	parse := func(s string) []int {
		parts := strings.Split(strings.TrimPrefix(strings.TrimSpace(s), "v"), ".")
		out := make([]int, 0, len(parts))
		for _, p := range parts {
			n, _ := strconv.Atoi(p)
			out = append(out, n)
		}
		return out
	}
	a, b := parse(latest), parse(current)
	for i := 0; i < 3; i++ {
		av, bv := 0, 0
		if i < len(a) {
			av = a[i]
		}
		if i < len(b) {
			bv = b[i]
		}
		if av != bv {
			return av > bv
		}
	}
	return false
}
