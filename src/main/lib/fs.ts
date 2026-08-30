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
