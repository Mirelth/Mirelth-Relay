package main

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Git 提交聚合（对应 src/main/gitlog.ts）：按扫描缓存里的项目目录，逐个仓库跑 git log。
// 列表用 --shortstat（只算总量），展开详情才拉 --numstat（逐文件）。

type CommitFileChange struct {
	File      string `json:"file"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	Status    string `json:"status"`
}

type CommitInfo struct {
	ID           string             `json:"id"`
	Hash         string             `json:"hash"`
	ShortHash    string             `json:"shortHash"`
	RepoPath     string             `json:"repoPath"`
	RepoName     string             `json:"repoName"`
	AgentIDs     []string           `json:"agentIds"`
	Author       string             `json:"author"`
	Email        string             `json:"email"`
	Date         string             `json:"date"`
	Message      string             `json:"message"`
	Additions    int                `json:"additions"`
	Deletions    int                `json:"deletions"`
	FilesChanged int                `json:"filesChanged"`
	Files        []CommitFileChange `json:"files"`
}

type GitFilter struct {
	AgentID string `json:"agentId"`
	Project string `json:"project"`
	Since   string `json:"since"`
	Until   string `json:"until"`
	Search  string `json:"search"`
	Limit   int    `json:"limit"`
}

// RepoAgents 是一个项目目录及关联到它的智能体。
type RepoAgents struct {
	Path     string
	AgentIDs []string
}

func isGitRepoDir(dir string) bool {
	info, err := os.Stat(filepath.Join(dir, ".git"))
	if err != nil {
		return false
	}
	return info.IsDir() || info.Mode().IsRegular() // worktree 的 .git 是文件
}

// ProjectRepos 从 agent_projects 聚合出「项目目录 → 智能体」。
func (s *Store) ProjectRepos() ([]RepoAgents, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.Query(`select path, agent_id from agent_projects order by path`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	order := []string{}
	byPath := map[string][]string{}
	for rows.Next() {
		var path, agentID string
		if err := rows.Scan(&path, &agentID); err != nil {
			return nil, err
		}
		if _, ok := byPath[path]; !ok {
			order = append(order, path)
		}
		byPath[path] = append(byPath[path], agentID)
	}
	out := make([]RepoAgents, 0, len(order))
	for _, p := range order {
		out = append(out, RepoAgents{Path: p, AgentIDs: byPath[p]})
	}
	return out, rows.Err()
}

func (a *App) listCommits(filter GitFilter) []CommitInfo {
	limit := filter.Limit
	if limit <= 0 || limit > 2000 {
		limit = 200
	}
	results := []CommitInfo{}
	if a.store == nil {
		return results
	}
	repos, err := a.store.ProjectRepos()
	if err != nil {
		return results
	}

	for _, repo := range repos {
		if filter.AgentID != "" && !containsString(repo.AgentIDs, filter.AgentID) {
			continue
		}
		if filter.Project != "" && repo.Path != filter.Project {
			continue
		}
		if !filepath.IsAbs(repo.Path) {
			continue // 相对路径的项目目录不可靠，跳过
		}
		dir := expandTilde(repo.Path)
		if !isGitRepoDir(dir) {
			continue
		}

		args := []string{
			"log", "--all",
			"--max-count=" + strconv.Itoa(limit),
			"--date=iso-strict", "--shortstat",
			"--pretty=format:%H\x1f%h\x1f%an\x1f%ae\x1f%ad\x1f%s",
		}
		if filter.Since != "" {
			args = append(args, "--since="+filter.Since)
		}
		if filter.Until != "" {
			args = append(args, "--until="+filter.Until)
		}
		if filter.Search != "" {
			args = append(args, "--grep="+filter.Search, "-i")
		}

		raw, err := execGit(dir, args...)
		if err != nil {
			continue // 非 git 仓库或 log 失败：跳过这个项目
		}

		repoName := filepath.Base(repo.Path)
		for _, block := range strings.Split(raw, "\n") {
			if strings.TrimSpace(block) == "" {
				continue
			}
			if !strings.Contains(block, "\x1f") {
				if len(results) > 0 && results[len(results)-1].RepoPath == repo.Path {
					stats := parseShortstat(block)
					last := &results[len(results)-1]
					last.Additions = stats.additions
					last.Deletions = stats.deletions
					last.FilesChanged = stats.filesChanged
				}
				continue
			}
			fields := strings.Split(block, "\x1f")
			if len(fields) < 6 {
				continue
			}
			hash := fields[0]
			if hash == "" {
				continue
			}
			short := fields[1]
			if short == "" {
				short = hash[:min(7, len(hash))]
			}
			agentID := filter.AgentID
			if agentID == "" {
				agentID = "all"
			}
			results = append(results, CommitInfo{
				ID:   agentID + "|" + repo.Path + "|" + hash,
				Hash: hash, ShortHash: short, RepoPath: repo.Path, RepoName: repoName,
				AgentIDs: repo.AgentIDs, Author: fields[2], Email: fields[3],
				Date: fields[4], Message: fields[5], Files: []CommitFileChange{},
			})
		}
	}

	sort.SliceStable(results, func(i, j int) bool { return results[i].Date > results[j].Date })
	if len(results) > limit {
		results = results[:limit]
	}
	return results
}

var (
	shortstatFiles = regexp.MustCompile(`(\d+) files? changed`)
	shortstatIns   = regexp.MustCompile(`(\d+) insertions?\(\+\)`)
	shortstatDel   = regexp.MustCompile(`(\d+) deletions?\(-\)`)
)

type shortstat struct{ additions, deletions, filesChanged int }

// parseShortstat 解析 " 3 files changed, 120 insertions(+), 45 deletions(-)"。
func parseShortstat(line string) shortstat {
	out := shortstat{}
	if m := shortstatFiles.FindStringSubmatch(line); len(m) == 2 {
		out.filesChanged, _ = strconv.Atoi(m[1])
	}
	if m := shortstatIns.FindStringSubmatch(line); len(m) == 2 {
		out.additions, _ = strconv.Atoi(m[1])
	}
	if m := shortstatDel.FindStringSubmatch(line); len(m) == 2 {
		out.deletions, _ = strconv.Atoi(m[1])
	}
	return out
}

func (a *App) getCommitDetail(commitID string) *CommitInfo {
	parts := strings.Split(commitID, "|")
	if len(parts) < 3 {
		return nil
	}
	agentID, repoPath := parts[0], strings.Join(parts[1:len(parts)-1], "|")
	hash := parts[len(parts)-1]
	if repoPath == "" || hash == "" {
		return nil
	}
	dir := expandTilde(repoPath)
	if !isGitRepoDir(dir) {
		return nil
	}

	metaRaw, err := execGit(dir, "show", "-s", "--date=iso-strict",
		"--pretty=format:%H\x1f%h\x1f%an\x1f%ae\x1f%ad\x1f%s", hash)
	if err != nil {
		return nil
	}
	fields := strings.Split(strings.TrimSpace(metaRaw), "\x1f")
	if len(fields) < 6 || fields[0] == "" {
		return nil
	}

	dedicated := agentID
	agents := []string{}
	if dedicated != "" && dedicated != "all" {
		agents = append(agents, dedicated)
	}

	info := &CommitInfo{
		ID: commitID, Hash: fields[0], ShortHash: fields[1], RepoPath: repoPath,
		RepoName: filepath.Base(repoPath), AgentIDs: agents,
		Author: fields[2], Email: fields[3], Date: fields[4], Message: fields[5],
		Files: []CommitFileChange{},
	}

	numstat, err := execGit(dir, "show", "--numstat", "--pretty=format:", hash)
	if err != nil {
		return info
	}
	for _, line := range strings.Split(numstat, "\n") {
		cols := strings.Split(line, "\t")
		if len(cols) < 3 {
			continue
		}
		file := strings.TrimSpace(cols[2])
		if file == "" {
			continue
		}
		additions := 0
		if cols[0] != "-" {
			additions, _ = strconv.Atoi(cols[0])
		}
		deletions := 0
		if cols[1] != "-" {
			deletions, _ = strconv.Atoi(cols[1])
		}
		info.Additions += additions
		info.Deletions += deletions
		info.Files = append(info.Files, CommitFileChange{
			File: file, Additions: additions, Deletions: deletions, Status: "modified",
		})
	}
	info.FilesChanged = len(info.Files)
	return info
}

func expandTilde(p string) string {
	if strings.HasPrefix(p, "~") {
		return homeDir() + strings.TrimPrefix(p, "~")
	}
	return p
}

func containsString(list []string, want string) bool {
	for _, item := range list {
		if item == want {
			return true
		}
	}
	return false
}
