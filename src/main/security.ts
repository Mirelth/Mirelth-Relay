import * as fs from 'fs'
import { join } from 'path'
import { HOME, readText } from './lib/fs'
import type { SecurityFinding, SecurityScanResult } from '@shared/types'

/**
 * 安全体检（只读）：检查智能体配置文件与常见凭证文件里
 * 是否存在明文密钥、文件权限是否过宽。展示的所有片段均已脱敏。
 */

export interface SecretHit {
  line: number
  masked: string
  kind: string
}

const NAMED_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: 'Anthropic 密钥', re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'OpenAI 风格密钥', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'GitHub Token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { kind: 'GitHub 细粒度 Token', re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { kind: 'AWS AccessKey', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: '阿里云 AccessKey', re: /\bLTAI[A-Za-z0-9]{12,22}\b/g },
  { kind: 'Slack Token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'Google API Key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'Stripe 密钥', re: /\b[ps]k_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  { kind: 'GitLab Token', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g }
]

// key: "value" / key = 'value' 形式，键名暗示凭证
const KV_RE =
  /["']?(api[-_]?key|access[-_]?key|access[-_]?token|auth[-_]?token|secret[-_]?key|client[-_]?secret|private[-_]?token|password|passwd)["']?\s*[:=]\s*["']([^"']{16,})["']/gi

const PLACEHOLDER =
  /(your[_-]|_?example|placeholder|changeme|dummy|test[-_]?key|x{4,}|\$\{|<[a-z_ ]*>|process\.env|redacted|•+|\*{4,})/i

function looksSecret(v: string): boolean {
  if (PLACEHOLDER.test(v)) return false
  if (!/[0-9]/.test(v) || !/[A-Za-z]/.test(v)) return false
  return true
}

export function maskSecret(v: string): string {
  if (v.length <= 10) return '••••••••'
  return v.slice(0, 4) + '……' + v.slice(-4)
}

/** 扫描一段文本内容，返回命中行（行号 1 起）。命中结果不含完整密钥。 */
export function detectSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = []
  const seen = new Set<string>()
  const push = (h: SecretHit): void => {
    const k = `${h.line}:${h.masked}`
    if (!seen.has(k)) {
      seen.add(k)
      hits.push(h)
    }
  }
  text.split(/\r?\n/).forEach((line, i) => {
    for (const p of NAMED_PATTERNS) {
      p.re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = p.re.exec(line)) !== null)
        push({ line: i + 1, masked: maskSecret(m[0]), kind: p.kind })
    }
    KV_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = KV_RE.exec(line)) !== null) {
      if (looksSecret(m[2]))
        push({ line: i + 1, masked: maskSecret(m[2]), kind: `明文凭证（${m[1].toLowerCase()}）` })
    }
  })
  return hits
}

const MAX_FILE_BYTES = 2 * 1024 * 1024

function modeOf(p: string): number | null {
  try {
    return fs.statSync(p).mode
  } catch {
    return null
  }
}

function worldReadable(mode: number): boolean {
  return (mode & 0o004) !== 0
}
function groupReadable(mode: number): boolean {
  return (mode & 0o040) !== 0
}
function worldWritable(mode: number): boolean {
  return (mode & 0o002) !== 0
}

export interface CandidateFile {
  path: string
  agentId?: string
  agentName?: string
}

function inSyncedFolder(p: string): boolean {
  return p.startsWith(join(HOME, 'Documents') + '/') || p.startsWith(join(HOME, 'Desktop') + '/')
}

function isShellRc(p: string): boolean {
  const base = p.slice(HOME.length + 1)
  return (
    base === '.zshrc' ||
    base === '.bashrc' ||
    base === '.bash_profile' ||
    base === '.zprofile' ||
    base === '.profile'
  )
}

/**
 * 执行体检。agentFiles 为各智能体适配器登记的配置文件
 * （来自扫描缓存的 detail.configs），另外固定检查 shell rc 与通用凭证文件。
 */
export function runSecurityScan(agentFiles: CandidateFile[]): SecurityScanResult {
  const candidates: CandidateFile[] = [...agentFiles]
  for (const rc of [
    '.zshrc',
    '.bashrc',
    '.bash_profile',
    '.zprofile',
    '.profile',
    '.npmrc',
    '.netrc',
    '.git-credentials'
  ])
    candidates.push({ path: join(HOME, rc) })

  const findings: SecurityFinding[] = []
  const checkedPaths = candidates.length
  let scannedFiles = 0
  let seq = 0
  const done = new Set<string>()

  for (const c of candidates) {
    if (done.has(c.path)) continue
    done.add(c.path)
    const mode = modeOf(c.path)
    if (mode == null) continue // 文件不存在
    scannedFiles++

    const text = readText(c.path)
    const hits = text && text.length <= MAX_FILE_BYTES ? detectSecrets(text) : []

    for (const h of hits) {
      const synced = inSyncedFolder(c.path)
      const rc = isShellRc(c.path)
      const severity: SecurityFinding['severity'] = rc || synced ? 'high' : 'medium'
      const advice = rc
        ? 'Shell 配置文件常被截图分享、同步到 dotfiles 仓库，密钥放这里泄露面很大。建议移到专用凭证文件并从 rc 中删除，然后到供应商后台轮换该密钥。'
        : synced
          ? '该文件位于 iCloud 同步目录（文稿/桌面），密钥可能已随同步上传云端。建议移出同步目录并轮换密钥。'
          : '密钥以明文保存在本地配置文件中，这是多数智能体的常规做法，但请确保文件权限为 600，且不要将该文件提交到 Git 仓库或截图外发。'
      findings.push({
        id: `sec-${++seq}`,
        severity,
        category: 'plaintext-secret',
        agentId: c.agentId,
        agentName: c.agentName,
        path: c.path,
        line: h.line,
        kind: h.kind,
        snippet: h.masked,
        advice
      })
    }

    if (worldWritable(mode)) {
      findings.push({
        id: `sec-${++seq}`,
        severity: 'high',
        category: 'loose-permissions',
        agentId: c.agentId,
        agentName: c.agentName,
        path: c.path,
        kind: '任意用户可写',
        snippet: `mode ${(mode & 0o777).toString(8)}`,
        advice:
          '任何本机用户/进程都能篡改该文件，若为配置还可能导致命令注入。执行 chmod 600 收紧权限。'
      })
    } else if (hits.length > 0 && (worldReadable(mode) || groupReadable(mode))) {
      findings.push({
        id: `sec-${++seq}`,
        severity: 'high',
        category: 'loose-permissions',
        agentId: c.agentId,
        agentName: c.agentName,
        path: c.path,
        kind: '含明文密钥且权限过宽',
        snippet: `mode ${(mode & 0o777).toString(8)}`,
        advice: '该文件含明文密钥但组内/其他用户可读。执行 chmod 600 收紧权限。'
      })
    }
  }

  const rank = { high: 0, medium: 1, info: 2 }
  findings.sort((a, b) => rank[a.severity] - rank[b.severity] || a.path.localeCompare(b.path))
  return { at: new Date().toISOString(), scannedFiles, findings, checkedPaths }
}

/** 从扫描缓存收集全部已检测智能体的配置文件（存在与否由体检内部判断） */
export function collectAgentFiles(
  listDetected: () => { id: string; name: string }[],
  getConfigPaths: (id: string) => { path: string }[]
): CandidateFile[] {
  const out: CandidateFile[] = []
  for (const a of listDetected()) {
    for (const c of getConfigPaths(a.id))
      out.push({ path: c.path, agentId: a.id, agentName: a.name })
  }
  return out
}
