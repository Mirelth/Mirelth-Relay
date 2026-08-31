import { join } from 'path'
import type { ConfigFileInfo, DataDirInfo, McpTool } from '@shared/types'
import { HOME, dirSize, exists, listDirs, readJson, redact } from '../../lib/fs'
import { appPaths, emptySnapshot, skillsFromDir, type RawMcp, type Scanner, type ScannerMeta } from '../types'

/**
 * 通用探测：Claude Code / Codex CLI / Gemini CLI / Cursor。
 * 本机未安装时自动隐藏，安装后无需改代码即可识别。
 */

interface GenericDef {
  id: string
  name: string
  vendor: string
  kind: 'cli' | 'ide'
  color: string
  probes: string[]
  configPaths: string[]
  dataDirs: [string, string][]
  skillsDirs: string[]
  mcpJsonPaths: { path: string; root?: string }[]
  projectDirs?: string[]
  installProbes?: string[]
  installBins?: string[]
}

const DEFS: GenericDef[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    vendor: 'Anthropic',
    kind: 'cli',
    color: '#d97706',
    probes: [join(HOME, '.claude'), join(HOME, '.claude.json')],
    installBins: ['claude'],
    configPaths: [join(HOME, '.claude.json'), join(HOME, '.claude/settings.json')],
    dataDirs: [
      [join(HOME, '.claude/projects'), '会话记录'],
      [join(HOME, '.claude/skills'), '技能'],
      [join(HOME, '.claude/plugins'), '插件']
    ],
    skillsDirs: [join(HOME, '.claude/skills')],
    mcpJsonPaths: [{ path: join(HOME, '.claude.json'), root: 'mcpServers' }],
    projectDirs: [join(HOME, '.claude/projects')]
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    vendor: 'OpenAI',
    kind: 'cli',
    color: '#22c55e',
    probes: [join(HOME, '.codex')],
    installBins: ['codex'],
    configPaths: [join(HOME, '.codex/config.toml')],
    dataDirs: [
      [join(HOME, '.codex/sessions'), '会话记录'],
      [join(HOME, '.codex'), '数据目录']
    ],
    skillsDirs: [],
    mcpJsonPaths: [],
    projectDirs: []
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    vendor: 'Google',
    kind: 'cli',
    color: '#0ea5e9',
    probes: [join(HOME, '.gemini')],
    installBins: ['gemini'],
    configPaths: [join(HOME, '.gemini/settings.json')],
    dataDirs: [[join(HOME, '.gemini'), '数据目录']],
    skillsDirs: [],
    mcpJsonPaths: [{ path: join(HOME, '.gemini/settings.json'), root: 'mcpServers' }],
    projectDirs: []
  },
  {
    id: 'cursor',
    name: 'Cursor',
    vendor: 'Anysphere',
    kind: 'ide',
    color: '#a3a3a3',
    probes: [join(HOME, '.cursor'), join(HOME, 'Library/Application Support/Cursor')],
    installProbes: appPaths('Cursor.app'),
    installBins: ['cursor'],
    configPaths: [join(HOME, '.cursor/mcp.json')],
    dataDirs: [
      [join(HOME, '.cursor/extensions'), '扩展'],
      [join(HOME, 'Library/Application Support/Cursor/User'), '用户数据']
    ],
    skillsDirs: [],
    mcpJsonPaths: [{ path: join(HOME, '.cursor/mcp.json'), root: 'mcpServers' }],
    projectDirs: []
  }
]

interface McpServerEntry {
  command?: string | string[]
  args?: string[]
  url?: string
  disabled?: boolean
}

export function createGenericScanner(def: GenericDef): Scanner {
  const meta: ScannerMeta = {
    id: def.id,
    name: def.name,
    vendor: def.vendor,
    kind: def.kind,
    color: def.color,
    probes: def.probes,
    installProbes: def.installProbes,
    installBins: def.installBins
  }
  return {
    meta,
    scan() {
      const detected = def.probes.some((p) => exists(p))
      const snap = emptySnapshot(meta, detected)
      if (!detected) return snap

      snap.configs = def.configPaths.map((p): ConfigFileInfo => {
        const raw = p.endsWith('.toml') ? null : readJson(p)
        return {
          path: p,
          exists: raw != null || exists(p),
          summary: raw ? (redact(raw) as Record<string, unknown>) : null
        }
      })

      snap.dataDirs = def.dataDirs
        .filter(([p]) => exists(p))
        .map(([p, label]): DataDirInfo => ({ path: p, label, sizeBytes: dirSize(p) }))

      for (const d of def.skillsDirs) {
        snap.skills.push(...skillsFromDir(meta.id, d))
      }

      for (const { path: p, root } of def.mcpJsonPaths) {
        const json = readJson<Record<string, unknown>>(p)
        const servers = (root ? json?.[root] : json) as Record<string, McpServerEntry> | undefined
        for (const [name, entry] of Object.entries(servers || {})) {
          const cmd = Array.isArray(entry.command) ? entry.command.join(' ') : entry.command
          snap.mcpServers.push({
            name,
            transport: entry.url ? 'http' : cmd ? 'stdio' : 'unknown',
            endpoint: entry.url || cmd,
            enabled: !entry.disabled,
            tools: [] as McpTool[],
            status: 'unverified',
            statusDetail: undefined
          } satisfies RawMcp)
        }
      }

      if (def.projectDirs) {
        for (const p of def.projectDirs) {
          for (const d of listDirs(p)) {
            // Claude Code 的 projects 目录名把路径编码为 -Users-new-... 形式
            const decoded = d.split('/').pop() || ''
            if (decoded.startsWith('-')) snap.projectDirs.push(decoded.replaceAll('-', '/'))
          }
        }
      }
      snap.projectDirs = [...new Set(snap.projectDirs)]

      snap.info.skillCount = snap.skills.length
      snap.info.mcpCount = snap.mcpServers.length
      snap.info.hasUsage = false
      snap.info.projectCount = snap.projectDirs.length
      return snap
    }
  }
}

export const genericScanners: Scanner[] = DEFS.map(createGenericScanner)
