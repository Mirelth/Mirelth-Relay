import { join } from 'path'
import type { DataDirInfo } from '@shared/types'
import { HOME, dirSize, exists, readJsonc, redact } from '../../lib/fs'
import { emptySnapshot, skillsFromDir, type Scanner, type ScannerMeta } from '../types'

const meta: ScannerMeta = {
  id: 'hub',
  name: 'Hub',
  kind: 'cli',
  color: '#14b8a6',
  probes: [join(HOME, '.hub')]
}

export const hubScanner: Scanner = {
  meta,
  scan() {
    const home = join(HOME, '.hub')
    const detected = exists(home)
    const snap = emptySnapshot(meta, detected)
    if (!detected) return snap

    // 配置：base.json 含 tools/mcp/agent/plugin
    const basePath = join(home, '.config-v2/base.json')
    const base = readJsonc(basePath)
    snap.configs = [
      {
        path: basePath,
        exists: base != null,
        summary: base ? (redact(base) as Record<string, unknown>) : null
      }
    ]

    // 数据目录
    const dirs: [string, string][] = [
      [join(home, '.config-v2'), '配置中心'],
      [join(home, 'skills'), '技能'],
      [join(home, 'runtimes'), '运行时']
    ]
    snap.dataDirs = dirs
      .filter(([p]) => exists(p))
      .map(([p, label]): DataDirInfo => ({ path: p, label, sizeBytes: dirSize(p) }))

    // 技能：~/.hub/skills/ 与 .config-v2/skills/
    snap.skills.push(...skillsFromDir(meta.id, join(home, 'skills')))
    snap.skills.push(...skillsFromDir(meta.id, join(home, '.config-v2/skills')))

    // MCP：base.json 的 mcp 键
    const mcpConfig = (base as { mcp?: Record<string, { command?: string | string[]; url?: string; enabled?: boolean }> } | null)?.mcp
    for (const [name, entry] of Object.entries(mcpConfig || {})) {
      const cmd = Array.isArray(entry.command) ? entry.command.join(' ') : entry.command
      snap.mcpServers.push({
        name,
        transport: entry.url ? 'http' : cmd ? 'stdio' : 'unknown',
        endpoint: entry.url || cmd,
        enabled: entry.enabled !== false,
        tools: [],
        status: 'unverified',
        statusDetail: undefined
      })
    }

    snap.info.skillCount = snap.skills.length
    snap.info.mcpCount = snap.mcpServers.length
    snap.info.hasUsage = false
    snap.info.projectCount = 0
    return snap
  }
}
