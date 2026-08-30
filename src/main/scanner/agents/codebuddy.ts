import { join } from 'path'
import type { ConfigFileInfo, DataDirInfo } from '@shared/types'
import { HOME, dirSize, exists, listDirs, mtimeIso, parseSkillMd, readJson, redact } from '../../lib/fs'
import { emptySnapshot, makeSkillId, type Scanner, type ScannerMeta } from '../types'

const meta: ScannerMeta = {
  id: 'codebuddy',
  name: 'CodeBuddy',
  vendor: 'Tencent',
  kind: 'ide',
  color: '#3b82f6',
  probes: [join(HOME, '.codebuddy'), join(HOME, '.codebuddycn')]
}

export const codebuddyScanner: Scanner = {
  meta,
  scan() {
    const home = join(HOME, '.codebuddy')
    const detected = exists(home)
    const snap = emptySnapshot(meta, detected)
    if (!detected) return snap

    // 配置
    const configPaths = [join(home, 'settings.json'), join(home, 'mcp.json')]
    snap.configs = configPaths.map((p): ConfigFileInfo => {
      const raw = readJson(p)
      return { path: p, exists: raw != null, summary: raw ? (redact(raw) as Record<string, unknown>) : null }
    })

    // 数据目录
    const dirs: [string, string][] = [
      [join(home, 'skills'), '技能'],
      [join(home, 'skills-marketplace'), '技能市场'],
      [join(home, 'plugins'), '插件'],
      [join(home, 'memery'), '记忆库']
    ]
    snap.dataDirs = dirs
      .filter(([p]) => exists(p))
      .map(([p, label]): DataDirInfo => ({ path: p, label, sizeBytes: dirSize(p) }))

    // 技能：skills/<name>/SKILL.md
    for (const d of listDirs(join(home, 'skills'))) {
      const md = parseSkillMd(join(d, 'SKILL.md'))
      const name = md.name || d.split('/').pop() as string
      snap.skills.push({
        id: makeSkillId(meta.id, name),
        agentId: meta.id,
        name,
        version: md.version,
        description: md.description,
        installedAt: mtimeIso(d),
        source: d,
        builtin: false
      })
    }
    // 技能市场：skills-marketplace/skills/<name>
    for (const d of listDirs(join(home, 'skills-marketplace', 'skills'))) {
      const md = parseSkillMd(join(d, 'SKILL.md'))
      const name = md.name || d.split('/').pop() as string
      if (!snap.skills.some((s) => s.name === name)) {
        snap.skills.push({
          id: makeSkillId(meta.id, name),
          agentId: meta.id,
          name,
          version: md.version,
          description: md.description,
          installedAt: mtimeIso(d),
          source: d,
          builtin: false
        })
      }
    }

    // MCP：mcp.json { mcpServers: {...} }
    const mcpJson = readJson<{ mcpServers?: Record<string, McpEntry> }>(join(home, 'mcp.json'))
    const servers = mcpJson?.mcpServers ?? {}
    for (const [name, entry] of Object.entries(servers) as [string, McpEntry][]) {
      snap.mcpServers.push(toRawMcp(name, entry))
    }

    snap.info.skillCount = snap.skills.length
    snap.info.mcpCount = snap.mcpServers.length
    snap.info.hasUsage = false
    snap.info.projectCount = 0
    return snap
  }
}

export interface McpEntry {
  type?: string
  command?: string | string[]
  args?: string[]
  url?: string
  disabled?: boolean
  env?: Record<string, string>
}

export function toRawMcp(name: string, entry: McpEntry) {
  const cmd = Array.isArray(entry.command) ? entry.command.join(' ') : entry.command
  const transport = entry.url
    ? 'http'
    : cmd
      ? 'stdio'
      : 'unknown'
  return {
    name,
    transport: transport as 'http' | 'stdio' | 'unknown',
    endpoint: entry.url || cmd,
    enabled: !entry.disabled,
    tools: [] as { name: string; description?: string }[],
    status: 'unverified' as const,
    statusDetail: undefined as string | undefined
  }
}
