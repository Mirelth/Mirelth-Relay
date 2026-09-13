import { execFile, spawnSync } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { parse as parseYaml } from 'yaml'
import type { RepoSecurityFinding } from '@shared/types'
import { maskSecretsInText } from './security'

/**
 * 可选的本地 Semgrep 引擎：本机装有 semgrep 时，对仓库叠加一层
 * 代码风险扫描（动态执行、命令拼接、硬编码口令、内嵌私钥等）。
 * 规则随应用内置（下方 YAML），运行全程离线 —— 关闭 metrics 与版本
 * 检查，不会向 semgrep.dev 发送任何数据。未安装时静默降级。
 */

const execFileAsync = promisify(execFile)

const TIMEOUT_PER_RULE_MS = 15000
const OVERALL_TIMEOUT_MS = 180000
const MAX_BUFFER = 64 * 1024 * 1024

/**
 * 内置规则集（离线）。secret: true 的规则只用于捕获既有脱敏逻辑
 * 覆盖不到的形态（如 PEM 私钥块），命中会按 code-secret 脱敏展示。
 */
export const SEMGREP_RULES_YAML = String.raw`
rules:
  # ---------- 明文密钥（补充内置脱敏正则之外的形态） ----------
  - id: secret-private-key-block
    languages: [generic]
    severity: ERROR
    message: 文件中嵌入了私钥块（PEM）。
    metadata:
      kind: 内嵌私钥
      advice: 私钥文件/私钥块不应出现在仓库中。视为已泄露：立即换用新密钥，并从代码与 Git 历史中移除。
      secret: true
    pattern-regex: '-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----'

  - id: secret-google-api-key
    languages: [generic]
    severity: ERROR
    message: 文件中出现疑似 Google API Key 明文。
    metadata:
      kind: 明文密钥(Google)
      advice: 到 Google Cloud 控制台轮换该密钥，改用环境变量，并将所在文件加入 .gitignore。
      secret: true
    pattern-regex: '\bAIza[0-9A-Za-z_-]{35}\b'

  - id: secret-gitlab-token
    languages: [generic]
    severity: ERROR
    message: 文件中出现疑似 GitLab Token 明文。
    metadata:
      kind: 明文密钥(GitLab)
      advice: 到 GitLab 设置中撤销并重建该 Token，改用环境变量或 CI 变量注入。
      secret: true
    pattern-regex: '\bglpat-[A-Za-z0-9_-]{20,}\b'

  # ---------- 代码风险 ----------
  - id: js-eval-dynamic
    languages: [javascript, typescript]
    severity: WARNING
    message: 使用 eval 动态执行代码。
    metadata:
      kind: eval 动态执行
      advice: eval 会把字符串当代码执行，是注入类漏洞的常见入口。改用 JSON.parse、映射表或显式分支处理。
    patterns:
      - pattern-either:
          - pattern: eval($X)
          - pattern: new Function($X)

  - id: js-exec-concat
    languages: [javascript, typescript]
    severity: WARNING
    message: exec/execSync 传入拼接或变量形式的命令字符串。
    metadata:
      kind: 命令注入风险
      advice: 拼接外部输入构造 shell 命令可能导致命令注入。改用 execFile/spawn 传参数组，或对输入做白名单校验。
    patterns:
      - pattern-either:
          - pattern: exec($X)
          - pattern: execSync($X)
          - pattern: $CP.exec($X)
          - pattern: $CP.execSync($X)
      - metavariable-regex:
          metavariable: $X
          regex: "^(?![\\\"']).+$"

  - id: py-eval-dynamic
    languages: [python]
    severity: WARNING
    message: 使用 eval 动态求值。
    metadata:
      kind: eval 动态求值
      advice: eval 会把字符串当代码执行。改用 ast.literal_eval 或显式数据结构。
    patterns:
      - pattern: eval($X)

  - id: py-os-system
    languages: [python]
    severity: WARNING
    message: 使用 os.system 执行 shell 命令。
    metadata:
      kind: 命令注入风险
      advice: os.system 会经过 shell 解释，拼接外部输入易导致命令注入。改用 subprocess.run 传参数组（shell=False）。
    patterns:
      - pattern-either:
          - pattern: os.system($X)
          - pattern: subprocess.call($X, shell=True)
          - pattern: subprocess.run($X, shell=True)

  - id: hardcoded-password
    languages: [generic]
    severity: WARNING
    message: 疑似硬编码的口令/密码字面量。
    metadata:
      kind: 硬编码口令
      advice: 口令不应写死在代码或配置里。改用环境变量、密钥管理服务或交互式输入。
    patterns:
      - pattern-regex: '(?i)\b(password|passwd|pwd)\b\s*[:=]\s*[''"][^''"]{4,}[''"]'
      - pattern-not-regex: '(?i)(placeholder|example|changeme|your[_-]|redacted|\$\{|process\.env|os\.environ|<[^>]*>)'
`.trim()

/** 解析内置规则的条数（用于结果里展示） */
export function semgrepRuleCount(): number {
  const doc = parseYaml(SEMGREP_RULES_YAML) as { rules?: unknown[] }
  return doc.rules?.length ?? 0
}

export interface SemgrepProbe {
  available: boolean
  bin?: string
  version?: string
}

/** 探测本机 semgrep：先 PATH，再常见安装位置；用 --version 验证可用性 */
export function probeSemgrep(): SemgrepProbe {
  const candidates: string[] = []
  const whichCmd = process.platform === 'win32' ? 'where' : 'which'
  try {
    const wr = spawnSync(whichCmd, ['semgrep'], { encoding: 'utf8', timeout: 5000 })
    if (wr.status === 0 && wr.stdout) {
      for (const l of wr.stdout.split(/\r?\n/)) if (l.trim()) candidates.push(l.trim())
    }
  } catch {
    // which 不可用则只尝试固定路径
  }
  const fixedDirs = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin')]
  try {
    // pip --user 安装位置：~/Library/Python/<ver>/bin（macOS）
    for (const e of fs.readdirSync(join(homedir(), 'Library', 'Python'), { withFileTypes: true })) {
      if (e.isDirectory()) fixedDirs.push(join(homedir(), 'Library', 'Python', e.name, 'bin'))
    }
  } catch {
    // 非 macOS 或目录不存在
  }
  for (const d of fixedDirs) {
    candidates.push(join(d, 'semgrep'))
  }
  for (const bin of candidates) {
    try {
      const v = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10000 })
      if (v.status === 0 && /^\d+\.\d+/m.test(v.stdout || '')) {
        return { available: true, bin, version: (v.stdout.match(/^\d+\.\d+[^\s]*/) ?? [''])[0] }
      }
    } catch {
      continue
    }
  }
  return { available: false }
}

export interface SemgrepJsonResult {
  check_id: string
  path: string
  start: { line: number; col: number }
  extra: {
    message?: string
    severity?: string
    lines?: string
    metadata?: { kind?: string; advice?: string; secret?: boolean } & Record<string, unknown>
  }
}

export interface SemgrepJson {
  results?: SemgrepJsonResult[]
  errors?: { message?: string }[]
}

export interface SemgrepOutcome {
  available: boolean
  version?: string
  /** 内置规则条数 */
  rules?: number
  /** semgrep 原始命中条数（去重/裁剪前） */
  found?: number
  error?: string
  /** 原始结果，交由调用方统一去重、编号、限量 */
  results: SemgrepJsonResult[]
}

/** semgrep 输出路径 → 相对仓库根的路径 */
export function relativize(p: string, repo: string): string {
  let norm = p.replace(/\\/g, '/')
  const repoNorm = repo.replace(/\\/g, '/').replace(/\/+$/, '') + '/'
  if (norm.startsWith(repoNorm)) norm = norm.slice(repoNorm.length)
  else if (norm.startsWith('/')) norm = norm.replace(/^\/+/, '')
  return norm
}

const SEVERITY_MAP: Record<string, RepoSecurityFinding['severity']> = {
  ERROR: 'high',
  WARNING: 'medium',
  INFO: 'info',
  INVENTORY: 'info'
}

/**
 * 把 semgrep JSON 结果映射为仓库安全发现。
 * existingKeys：已有发现的 "path:line" 集合，用于与内置密钥检查去重。
 */
export function mapSemgrepResults(
  results: SemgrepJsonResult[],
  repo: string,
  existingKeys: Set<string>
): Omit<RepoSecurityFinding, 'id'>[] {
  const out: Omit<RepoSecurityFinding, 'id'>[] = []
  const seen = new Set<string>()
  for (const r of results ?? []) {
    const line = r.start?.line ?? 0
    const rel = relativize(r.path ?? '', repo)
    const key = `${rel}:${line}`
    if (existingKeys.has(key) || seen.has(key)) continue
    seen.add(key)
    const meta = r.extra?.metadata ?? {}
    const rawSnippet = (r.extra?.lines ?? r.extra?.message ?? '').trim().replace(/\s+/g, ' ')
    out.push({
      severity: SEVERITY_MAP[r.extra?.severity ?? ''] ?? 'info',
      category: meta.secret ? 'code-secret' : 'code-risk',
      path: rel,
      line,
      kind: meta.kind ?? (r.check_id ?? '').replace(/^[\w.-]+\./, ''),
      // 双保险：即便规则本身只报代码风险，片段里的密钥形态也一律脱敏
      snippet: maskSecretsInText(rawSnippet).slice(0, 200),
      advice: meta.advice ?? r.extra?.message ?? '请结合上下文人工复核该处代码。'
    })
  }
  return out
}

function writeRulesFile(): string {
  const p = join(tmpdir(), `agent-tower-semgrep-${process.pid}.yml`)
  fs.writeFileSync(p, SEMGREP_RULES_YAML, 'utf8')
  return p
}

/** 对仓库跑一次本地 semgrep 扫描；未安装返回 available:false */
export async function runSemgrepScan(repo: string): Promise<SemgrepOutcome> {
  const probe = probeSemgrep()
  if (!probe.available) return { available: false, results: [] }
  const rules = semgrepRuleCount()
  const rulesPath = writeRulesFile()
  try {
    const args = [
      'scan',
      '--json',
      '--quiet',
      '--metrics=off',
      '--disable-version-check',
      '--no-git-ignore',
      '--config',
      rulesPath,
      '--timeout',
      String(TIMEOUT_PER_RULE_MS / 1000),
      '--max-target-bytes',
      '1048576',
      '--jobs',
      '2',
      repo
    ]
    const { stdout } = await execFileAsync(probe.bin!, args, {
      timeout: OVERALL_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER
    })
    const json = JSON.parse(stdout) as SemgrepJson
    const err = json.errors?.length ? json.errors.map((e) => e.message ?? '').join('; ') : undefined
    return {
      available: true,
      version: probe.version,
      rules,
      found: json.results?.length ?? 0,
      error: err || undefined,
      results: json.results ?? []
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { available: true, version: probe.version, rules, error: msg, results: [] }
  } finally {
    try {
      fs.rmSync(rulesPath, { force: true })
    } catch {
      // 清理失败不影响结果
    }
  }
}
