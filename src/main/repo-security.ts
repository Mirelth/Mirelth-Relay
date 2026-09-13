import * as fs from 'fs'
import { join } from 'path'
import { simpleGit } from 'simple-git'
import type { RepoSecurityFinding, RepoSecurityScanResult, SemgrepEngineInfo } from '@shared/types'
import { detectSecrets } from './security'
import { mapSemgrepResults, runSemgrepScan } from './semgrep'

/**
 * 仓库安全审查（只读）：对一个本地代码仓库做三类检查——
 * 1) 工作区文件里的明文密钥；2) 已提交进 Git 的敏感文件（.env / 私钥等）；
 * 3) 敏感文件未写进 .gitignore、可能被意外提交。
 * 另外可选叠加本地 Semgrep 引擎的代码风险扫描（本机装有 semgrep 时自动启用）。
 * 所有片段均已脱敏。
 */

const MAX_FILES = 5000
const MAX_FILE_BYTES = 1024 * 1024
const MAX_FINDINGS = 500

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  'build',
  '.next',
  '.nuxt',
  '.output',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  'vendor',
  'target',
  '.cache',
  '.turbo',
  '.idea'
])

/** 已提交即高危的敏感文件（相对路径判断，basename 或后缀） */
const SENSITIVE_NAME_RE =
  /(^|\/)(\.env(\.[^/]+)?|id_rsa|id_dsa|id_ecdsa|id_ed25519|\.netrc|\.git-credentials)$|(\.(pem|key|pfx|p12|jks|keystore))$/i

function isEnvFile(rel: string): boolean {
  const base = rel.slice(rel.lastIndexOf('/') + 1).toLowerCase()
  return base === '.env' || (base.startsWith('.env.') && !/example|template|sample/.test(base))
}

function isSensitiveName(rel: string): boolean {
  return SENSITIVE_NAME_RE.test(rel)
}

/** git 仓库：tracked + 未被 ignore 的 untracked；普通目录：递归遍历 */
async function listFiles(
  repo: string
): Promise<{ files: string[]; isGit: boolean; tracked: Set<string>; truncated: boolean }> {
  const gitRoot = join(repo, '.git')
  let isGit = false
  try {
    isGit = fs.existsSync(gitRoot)
  } catch {
    isGit = false
  }

  if (isGit) {
    try {
      const git = simpleGit({ baseDir: repo, timeout: { block: 20000 } })
      const [cached, others] = await Promise.all([
        git.raw(['ls-files', '-z', '--cached']),
        git.raw(['ls-files', '-z', '--others', '--exclude-standard'])
      ])
      // others 已经排除被 ignore 的文件，因此其中的敏感文件意味着可能被意外提交
      const trackedList = cached.split('\0').filter((f) => f.length > 0 && !f.endsWith('/'))
      const untrackedList = others.split('\0').filter((f) => f.length > 0 && !f.endsWith('/'))
      const files = [...trackedList, ...untrackedList]
      return {
        files,
        isGit: true,
        tracked: new Set(trackedList),
        truncated: files.length > MAX_FILES
      }
    } catch {
      // git 命令失败则退化为普通遍历
    }
  }

  const files: string[] = []
  let truncated = false
  const walk = (dir: string, rel: string): void => {
    if (truncated || files.length > MAX_FILES) {
      truncated = true
      return
    }
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (files.length > MAX_FILES) {
        truncated = true
        return
      }
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) walk(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name)
      } else if (e.isFile()) {
        files.push(rel ? `${rel}/${e.name}` : e.name)
      }
    }
  }
  walk(repo, '')
  return { files, isGit: false, tracked: new Set(), truncated }
}

/** 读文件为文本；二进制（前 8KB 含 NUL）或超过 maxBytes 返回 null */
function readMaybeText(p: string, maxBytes: number): string | null {
  let size = 0
  try {
    size = fs.statSync(p).size
  } catch {
    return null
  }
  if (size > maxBytes || size === 0) return null
  try {
    const fd = fs.openSync(p, 'r')
    try {
      const probe = Buffer.alloc(Math.min(8192, size))
      fs.readSync(fd, probe, 0, probe.length, 0)
      if (probe.includes(0)) return null
      const rest = Buffer.alloc(size - probe.length)
      if (rest.length > 0) fs.readSync(fd, rest, 0, rest.length, probe.length)
      return Buffer.concat([probe, rest]).toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
}

function secretAdvice(isTracked: boolean): string {
  if (isTracked)
    return '密钥已进入 Git 历史，仅删除文件不够。请先到供应商后台轮换该密钥，再从当前代码中移除；必要时用 git filter-repo 清理历史后强推。'
  return '密钥存在于工作区文件中，尚未被 Git 跟踪。提交前务必删除或改用环境变量，并把该文件加入 .gitignore。'
}

export async function runRepoSecurityScan(repoDir: string): Promise<RepoSecurityScanResult> {
  const repo = repoDir.trim()
  const st = fs.existsSync(repo) ? fs.statSync(repo) : null
  if (!st || !st.isDirectory()) throw new Error(`不是有效的目录：${repo}`)

  const { files, isGit, tracked, truncated } = await listFiles(repo)
  const findings: RepoSecurityFinding[] = []
  let scannedFiles = 0
  let seq = 0
  let envOnDisk = false

  for (const rel of files) {
    const abs = join(repo, rel)
    const text = readMaybeText(abs, MAX_FILE_BYTES)
    if (text == null) continue
    scannedFiles++

    if (isEnvFile(rel)) envOnDisk = true
    if (isGit && tracked.has(rel) && (isEnvFile(rel) || isSensitiveName(rel))) {
      findings.push({
        id: `repo-${++seq}`,
        severity: 'high',
        category: 'committed-env',
        path: rel,
        kind: '敏感文件已提交进仓库',
        snippet: isEnvFile(rel) ? '环境变量文件' : '私钥/凭证文件',
        advice: isEnvFile(rel)
          ? '环境变量文件通常含真实密钥，不应纳入版本控制。用 git rm --cached 移出跟踪、加入 .gitignore，并轮换其中所有密钥。'
          : '私钥/凭证文件不应纳入版本控制。用 git rm --cached 移出跟踪、加入 .gitignore，并视为已泄露、立即轮换。'
      })
    }

    for (const h of detectSecrets(text)) {
      findings.push({
        id: `repo-${++seq}`,
        severity: 'high',
        category: 'plaintext-secret',
        path: rel,
        line: h.line,
        kind: h.kind,
        snippet: h.masked,
        advice: secretAdvice(tracked.has(rel))
      })
      if (findings.length >= MAX_FINDINGS) break
    }
    if (findings.length >= MAX_FINDINGS) break

    // 未被 ignore 的敏感文件：git ls-files --others --exclude-standard 已排除 ignored，
    // 所以出现在 untracked（不在 tracked）里的敏感文件意味着可能被意外提交
    if (isGit && !tracked.has(rel) && (isEnvFile(rel) || isSensitiveName(rel))) {
      findings.push({
        id: `repo-${++seq}`,
        severity: 'medium',
        category: 'gitignore-missing',
        path: rel,
        kind: '敏感文件未被 .gitignore 覆盖',
        snippet: '当前处于未跟踪状态，一次 git add -A 就会提交',
        advice: `在 .gitignore 中加入 ${isEnvFile(rel) ? '.env' : rel.slice(rel.lastIndexOf('/') + 1)} 或该文件的完整路径，避免被意外提交。`
      })
    }
  }

  // 兜底：仓库里有 .env 但 .gitignore 完全没提 .env，提示补上根因规则
  if (isGit && envOnDisk) {
    const gi = readMaybeText(join(repo, '.gitignore'), 65536)
    if (gi == null || !/(^|\s)\.env(\s|$|\.)/m.test(gi)) {
      findings.push({
        id: `repo-${++seq}`,
        severity: 'medium',
        category: 'gitignore-missing',
        path: '.gitignore',
        kind: '.gitignore 缺少 .env 规则',
        snippet: '.env 未被忽略规则覆盖',
        advice:
          '在 .gitignore 中加入 ".env"（及其变体如 .env.local），从源头防止环境变量文件被提交。'
      })
    }
  }

  // 可选增强引擎：本机装有 semgrep 时叠加本地代码风险扫描；未安装则静默降级
  let semgrep: SemgrepEngineInfo = { available: false }
  try {
    const outcome = await runSemgrepScan(repo)
    semgrep = {
      available: outcome.available,
      version: outcome.version,
      rules: outcome.rules,
      found: outcome.found,
      error: outcome.error
    }
    if (outcome.available && outcome.results.length > 0) {
      const existing = new Set(findings.map((f) => `${f.path}:${f.line}`))
      const mapped = mapSemgrepResults(outcome.results, repo, existing)
      for (const f of mapped) {
        if (findings.length >= MAX_FINDINGS) break
        findings.push({ ...f, id: `repo-${++seq}` })
      }
    }
  } catch {
    // 引擎层兜底：任何意外都不应影响基础检查结果
    semgrep = { available: false }
  }

  const rank = { high: 0, medium: 1, info: 2 }
  findings.sort((a, b) => rank[a.severity] - rank[b.severity] || a.path.localeCompare(b.path))
  return {
    at: new Date().toISOString(),
    repo,
    isGitRepo: isGit,
    scannedFiles,
    truncated,
    semgrep,
    findings
  }
}
