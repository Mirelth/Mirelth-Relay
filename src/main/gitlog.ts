import { basename, isAbsolute, resolve } from 'path'
import os from 'os'
import { statSync } from 'fs'
import { simpleGit } from 'simple-git'
import type { CommitFileChange, CommitInfo, GitFilter } from '@shared/types'
import { getStore } from './cache'

const gitCache = new Map<string, ReturnType<typeof simpleGit>>()

function gitFor(repo: string) {
  let git = gitCache.get(repo)
  if (!git) {
    git = simpleGit({ baseDir: repo, timeout: { block: 15000 } })
    gitCache.set(repo, git)
  }
  return git
}

export function isGitRepo(dir: string): boolean {
  try {
    statSync(resolve(dir.replace(/^~/, os.homedir()), '.git'))
    return true
  } catch {
    return false
  }
}

export async function listCommits(filter: GitFilter = {}): Promise<CommitInfo[]> {
  const store = getStore()
  let repos = store.projectRepos()
  if (filter.agentId) repos = repos.filter((r) => r.agentIds.includes(filter.agentId!))
  if (filter.project) repos = repos.filter((r) => r.path === filter.project)

  const results: CommitInfo[] = []
  const since = filter.since
  const until = filter.until

  await Promise.all(
    repos.map(async (repo) => {
      if (!isAbsolute(repo.path)) return
      const dir = repo.path.replace(/^~/, os.homedir())
      if (!isGitRepo(dir)) return
      try {
        const git = gitFor(dir)
        const args = [
          '--all',
          `--max-count=${filter.limit ?? 200}`,
          '--date=iso-strict',
          '--shortstat',
          '--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s'
        ]
        if (since) args.push(`--since=${since}`)
        if (until) args.push(`--until=${until}`)
        if (filter.search) args.push(`--grep=${filter.search}`, '-i')
        const raw = await git.raw(['log', ...args])
        // 输出结构：每个提交两行 —— meta 行（\x1f 分隔）+ shortstat 汇总行
        let st = { additions: 0, deletions: 0, filesChanged: 0 }
        for (const block of raw.split('\n')) {
          if (!block.trim()) continue
          if (block.includes('\x1f')) {
            const [hash, short, author, email, date, subject] = block.split('\x1f')
            if (!hash) continue
            st = { additions: 0, deletions: 0, filesChanged: 0 }
            results.push({
              id: `${filter.agentId || 'all'}|${repo.path}|${hash}`,
              hash,
              shortHash: short || hash.slice(0, 7),
              repoPath: repo.path,
              repoName: basename(repo.path) || repo.path,
              agentIds: repo.agentIds,
              author,
              email,
              date,
              message: subject || '',
              additions: st.additions,
              deletions: st.deletions,
              filesChanged: st.filesChanged,
              files: []
            })
          } else {
            st = parseShortstat(block)
            if (results.length > 0) {
              const last = results[results.length - 1]
              last.additions = st.additions
              last.deletions = st.deletions
              last.filesChanged = st.filesChanged
            }
          }
        }
      } catch {
        // 非 git 仓库或 log 失败，跳过
      }
    })
  )

  results.sort((a, b) => (a.date < b.date ? 1 : -1))
  return results.slice(0, filter.limit ?? 200)
}

/** 解析 --shortstat 行：" 3 files changed, 120 insertions(+), 45 deletions(-)" */
function parseShortstat(line?: string): { additions: number; deletions: number; filesChanged: number } {
  if (!line) return { additions: 0, deletions: 0, filesChanged: 0 }
  const files = line.match(/(\d+) files? changed/)
  const ins = line.match(/(\d+) insertions?\(\+\)/)
  const del = line.match(/(\d+) deletions?\(-\)/)
  return {
    filesChanged: files ? parseInt(files[1], 10) : 0,
    additions: ins ? parseInt(ins[1], 10) : 0,
    deletions: del ? parseInt(del[1], 10) : 0
  }
}

export async function getCommitDetail(commitId: string): Promise<CommitInfo | null> {
  const [agentId, repoPath, hash] = commitId.split('|')
  if (!repoPath || !hash) return null
  const dir = repoPath.replace(/^~/, os.homedir())
  try {
    const git = gitFor(resolve(dir))
    const metaRaw = await git.raw([
      'show', '-s', '--date=iso-strict',
      '--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s',
      hash
    ])
    const [fullHash, short, author, email, date, subject] = metaRaw.trim().split('\x1f')
    if (!fullHash) return null
    const raw = await git.raw(['show', '--numstat', '--pretty=format:', hash])
    const files: CommitFileChange[] = []
    let additions = 0
    let deletions = 0
    for (const line of raw.split('\n')) {
      const [add, del, file] = line.split('\t')
      if (file && file.trim()) {
        const a = add === '-' ? 0 : parseInt(add, 10) || 0
        const d = del === '-' ? 0 : parseInt(del, 10) || 0
        additions += a
        deletions += d
        files.push({ file: file.trim(), additions: a, deletions: d, status: 'modified' })
      }
    }
    return {
      id: commitId,
      hash: fullHash,
      shortHash: short || fullHash.slice(0, 7),
      repoPath,
      repoName: basename(repoPath) || repoPath,
      agentIds: agentId && agentId !== 'all' ? [agentId] : [],
      author,
      email,
      date,
      message: subject || '',
      additions,
      deletions,
      filesChanged: files.length,
      files
    }
  } catch {
    return null
  }
}
