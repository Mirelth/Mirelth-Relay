import * as fs from 'fs'
import { join } from 'path'
import * as os from 'os'
import YAML from 'yaml'

export const HOME = os.homedir()

export function exists(p: string): boolean {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}

export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

export function readText(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

export function readJson<T = Record<string, unknown>>(p: string): T | null {
  const text = readText(p)
  if (text == null) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

export function readJsonc<T = Record<string, unknown>>(p: string): T | null {
  const text = readText(p)
  if (text == null) return null
  try {
    // 先尝试标准 JSON，失败后去掉注释再试
    try {
      return JSON.parse(text) as T
    } catch {
      const stripped = text
        .replace(/^\uFEFF/, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:"'\\])\/\/.*$/gm, '$1')
      return JSON.parse(stripped) as T
    }
  } catch {
    return null
  }
}

export function readYaml<T = Record<string, unknown>>(p: string): T | null {
  const text = readText(p)
  if (text == null) return null
  try {
    return YAML.parse(text) as T
  } catch {
    return null
  }
}

export function listDirs(p: string): string[] {
  try {
    return fs
      .readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => join(p, d.name))
  } catch {
    return []
  }
}

export function listEntries(p: string): string[] {
  try {
    return fs.readdirSync(p).filter((n) => !n.startsWith('.'))
  } catch {
    return []
  }
}

/** 递归统计目录大小（字节），失败返回 -1 */
export function dirSize(p: string, depth = 0): number {
  if (depth > 6) return 0
  try {
    const st = fs.statSync(p)
    if (!st.isDirectory()) return st.size
    let total = 0
    for (const entry of fs.readdirSync(p)) {
      if (entry === 'node_modules') continue
      total += dirSize(join(p, entry), depth + 1)
    }
    return total
  } catch {
    return -1
  }
}

/** 深拷贝并脱敏：值里疑似 key/token/secret 的字段替换为掩码 */
const SENSITIVE_KEY = /key|token|secret|password|credential|authorization|api[-_]?key/i
const SENSITIVE_VALUE = /^(sk|ghp|gho|xox|eyJ)[\w-]{12,}/

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '…'
  if (Array.isArray(value)) {
    if (value.length > 20) return value.slice(0, 20).map((v) => redact(v, depth + 1))
    return value.map((v) => redact(v, depth + 1))
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(k) && typeof v === 'string' && v.length > 4) {
        out[k] = '••••••••' + v.slice(-4)
      } else {
        out[k] = redact(v, depth + 1)
      }
    }
    return out
  }
  if (typeof value === 'string' && SENSITIVE_VALUE.test(value)) return '••••••••'
  return value
}

/** 解析 SKILL.md 的 frontmatter（name/description/version） */
export function parseSkillMd(p: string): { name?: string; description?: string; version?: string } {
  const text = readText(p)
  if (!text) return {}
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return {}
  const out: { name?: string; description?: string; version?: string } = {}
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(name|description|version):\s*(.+)\s*$/)
    if (kv) {
      const val = kv[2].replace(/^["']|["']$/g, '').trim()
      if (kv[1] === 'name') out.name = val
      else if (kv[1] === 'description') out.description = val
      else out.version = val
    }
  }
  return out
}

/** 文件/目录的修改时间作为安装时间参考 */
export function mtimeIso(p: string): string | undefined {
  try {
    return fs.statSync(p).mtime.toISOString()
  } catch {
    return undefined
  }
}

// ---------- 安全写：解析失败拒写 + 校验失败自动回滚 ----------

/** 写前异常：格式漂移/校验失败，应中止并向用户解释 */
export class ConfigWriteError extends Error {}

/**
 * 写入前读取原配置。文件存在但解析失败或不是对象结构（上游版本改了格式）→ 抛错拒写，
 * 绝不允许静默降级成空对象后把用户已有配置整体覆盖掉。文件不存在返回 {} 供新建。
 */
export function loadForWrite(
  filePath: string,
  read: (p: string) => unknown
): Record<string, unknown> {
  const parsed = read(filePath)
  if (parsed == null) {
    if (exists(filePath))
      throw new ConfigWriteError('无法解析现有配置（文件格式可能已变更），已中止写入，原文件未做任何改动')
    return {}
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed))
    throw new ConfigWriteError('现有配置不是对象结构，已中止写入，原文件未做任何改动')
  return parsed as Record<string, unknown>
}

/**
 * 备份 → 写入 → 回读校验 三步原子化：
 * 写入后立刻用同一解析器回读，失败则自动从备份回滚（原文件不存在时删除新建文件），
 * 保证「校验不过 = 现场恢复原状」，而不是留下写坏的半截配置只给用户一个备份路径。
 */
export function commitWithVerify(
  filePath: string,
  write: () => void,
  read: (p: string) => unknown
): string | undefined {
  const bak = exists(filePath) ? `${filePath}.agentmgr-bak-${Date.now()}` : null
  if (bak) fs.copyFileSync(filePath, bak)
  let failure: unknown = null
  try {
    write()
    const parsed = read(filePath)
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new ConfigWriteError('写入后回读校验失败')
  } catch (err) {
    failure = err
  }
  if (failure) {
    if (bak) {
      try {
        fs.copyFileSync(bak, filePath)
      } catch {
        /* 回滚失败：保留备份文件本身 */
      }
      throw new ConfigWriteError('写入校验失败，已自动回滚原配置')
    }
    try {
      fs.unlinkSync(filePath)
    } catch {
      /* 新建文件删除失败时忽略 */
    }
    throw new ConfigWriteError('写入校验失败，已撤销本次新建')
  }
  return bak ?? undefined
}

/** 读取 macOS 应用包版本（Info.plist 为 XML，借助 plutil 转换） */
export function readAppBundleVersion(appPath: string): string | undefined {
  try {
    const { execFileSync } = require('child_process') as typeof import('child_process')
    const out = execFileSync('plutil', ['-convert', 'json', '-o', '-', join(appPath, 'Contents/Info.plist')], {
      encoding: 'utf8',
      timeout: 3000
    })
    const plist = JSON.parse(out) as { CFBundleShortVersionString?: string }
    return plist.CFBundleShortVersionString
  } catch {
    return undefined
  }
}
