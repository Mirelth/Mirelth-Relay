package main

import (
	"path/filepath"
	"strings"
	"testing"
)

// gitFixture 建一个仓库并造两次提交，返回仓库路径。
func gitFixture(t *testing.T, agentID string) (string, *Store) {
	t.Helper()
	dir := t.TempDir()
	initGitRepo(t, dir)

	mkfile(t, filepath.Join(dir, "a.txt"), "line1\nline2\n")
	if _, err := execGit(dir, "add", "-A"); err != nil {
		t.Fatal(err)
	}
	if _, err := execGit(dir, "commit", "-qm", "first commit"); err != nil {
		t.Fatal(err)
	}

	mkfile(t, filepath.Join(dir, "a.txt"), "line1\nline2\nline3\n")
	mkfile(t, filepath.Join(dir, "b.txt"), "new file\n")
	if _, err := execGit(dir, "add", "-A"); err != nil {
		t.Fatal(err)
	}
	if _, err := execGit(dir, "commit", "-qm", "second commit with secrets"); err != nil {
		t.Fatal(err)
	}

	st := testStore(t)
	snap := snapshotFixture(agentID, agentID, true, "installed")
	snap.ProjectDirs = []string{dir}
	if err := st.SaveSnapshot(snap); err != nil {
		t.Fatal(err)
	}
	return dir, st
}

func TestListCommitsAggregatesRepos(t *testing.T) {
	dir, st := gitFixture(t, "zcode")
	app := &App{store: st}

	commits := app.listCommits(GitFilter{})
	if len(commits) != 2 {
		t.Fatalf("commits = %d: %+v", len(commits), commits)
	}
	// 最新在前
	newest := commits[0]
	if newest.Message != "second commit with secrets" {
		t.Fatalf("newest = %+v", newest)
	}
	if newest.RepoPath != dir || newest.RepoName != filepath.Base(dir) {
		t.Fatalf("repo meta = %+v", newest)
	}
	if len(newest.AgentIDs) != 1 || newest.AgentIDs[0] != "zcode" {
		t.Fatalf("agent ids = %+v", newest.AgentIDs)
	}
	if !strings.HasPrefix(newest.ID, "all|"+dir+"|") {
		t.Fatalf("id = %q", newest.ID)
	}
	if newest.Author == "" || newest.Email == "" || newest.Date == "" || len(newest.Hash) < 7 {
		t.Fatalf("meta = %+v", newest)
	}
	// shortstat：新增 b.txt + a.txt 加一行 = 2 个文件、2 行新增
	if newest.FilesChanged != 2 || newest.Additions != 2 {
		t.Fatalf("shortstat = %+v", newest)
	}
	if commits[1].FilesChanged != 1 {
		t.Fatalf("first commit stats = %+v", commits[1])
	}
}

func TestListCommitsFilters(t *testing.T) {
	_, st := gitFixture(t, "zcode")
	app := &App{store: st}

	if got := app.listCommits(GitFilter{AgentID: "opencode"}); len(got) != 0 {
		t.Fatalf("wrong agent must yield nothing: %+v", got)
	}
	if got := app.listCommits(GitFilter{AgentID: "zcode"}); len(got) != 2 {
		t.Fatalf("agent filter = %d", len(got))
	}
	// id 里带上了过滤用的 agentId
	if got := app.listCommits(GitFilter{AgentID: "zcode"}); !strings.HasPrefix(got[0].ID, "zcode|") {
		t.Fatalf("filtered id = %q", got[0].ID)
	}
	if got := app.listCommits(GitFilter{Project: "/definitely/not/the/repo"}); len(got) != 0 {
		t.Fatalf("project filter = %+v", got)
	}
	if got := app.listCommits(GitFilter{Search: "second"}); len(got) != 1 || got[0].Message != "second commit with secrets" {
		t.Fatalf("grep filter = %+v", got)
	}
	if got := app.listCommits(GitFilter{Limit: 1}); len(got) != 1 {
		t.Fatalf("limit = %d", len(got))
	}
}

func TestListCommitsSkipsNonGitAndRelativeProjects(t *testing.T) {
	plain := t.TempDir()
	st := testStore(t)
	snap := snapshotFixture("zcode", "ZCode", true, "installed")
	snap.ProjectDirs = []string{plain, "relative/path"}
	if err := st.SaveSnapshot(snap); err != nil {
		t.Fatal(err)
	}
	if got := (&App{store: st}).listCommits(GitFilter{}); len(got) != 0 {
		t.Fatalf("non-git and relative projects must be skipped: %+v", got)
	}
}

func TestGetCommitDetailListsFiles(t *testing.T) {
	_, st := gitFixture(t, "zcode")
	app := &App{store: st}
	commits := app.listCommits(GitFilter{Limit: 1})
	if len(commits) != 1 {
		t.Fatalf("commits = %d", len(commits))
	}

	detail := app.getCommitDetail(commits[0].ID)
	if detail == nil {
		t.Fatal("detail should resolve")
	}
	if detail.FilesChanged != 2 || len(detail.Files) != 2 {
		t.Fatalf("files = %+v", detail.Files)
	}
	total := 0
	for _, f := range detail.Files {
		total += f.Additions
		if f.Status != "modified" || f.File == "" {
			t.Fatalf("file = %+v", f)
		}
	}
	if total != detail.Additions || detail.Additions != 2 {
		t.Fatalf("additions = %d, files sum = %d", detail.Additions, total)
	}

	if got := app.getCommitDetail("garbage"); got != nil {
		t.Fatalf("bad id = %+v", got)
	}
	if got := app.getCommitDetail("all|/no/such/repo|abc"); got != nil {
		t.Fatalf("missing repo = %+v", got)
	}
}

func TestParseShortstat(t *testing.T) {
	got := parseShortstat(" 3 files changed, 120 insertions(+), 45 deletions(-)")
	if got.filesChanged != 3 || got.additions != 120 || got.deletions != 45 {
		t.Fatalf("stats = %+v", got)
	}
	if got := parseShortstat(" 1 file changed, 2 insertions(+)"); got.deletions != 0 || got.filesChanged != 1 {
		t.Fatalf("single = %+v", got)
	}
	if got := parseShortstat("garbage"); got != (shortstat{}) {
		t.Fatalf("garbage = %+v", got)
	}
}

func TestExpandTilde(t *testing.T) {
	home := fakeHome(t)
	if got := expandTilde("~/proj"); got != filepath.Join(home, "proj") {
		t.Fatalf("expandTilde = %q", got)
	}
	if got := expandTilde("/abs"); got != "/abs" {
		t.Fatalf("absolute = %q", got)
	}
}

func TestProjectReposGroupsAgents(t *testing.T) {
	st := testStore(t)
	dir := t.TempDir()
	for _, id := range []string{"a", "b"} {
		snap := snapshotFixture(id, id, true, "installed")
		snap.ProjectDirs = []string{dir, filepath.Join(dir, id)}
		if err := st.SaveSnapshot(snap); err != nil {
			t.Fatal(err)
		}
	}
	repos, err := st.ProjectRepos()
	if err != nil {
		t.Fatal(err)
	}
	if len(repos) != 3 {
		t.Fatalf("repos = %+v", repos)
	}
	for _, r := range repos {
		if r.Path == dir && len(r.AgentIDs) != 2 {
			t.Fatalf("shared project should list both agents: %+v", r)
		}
	}
}
