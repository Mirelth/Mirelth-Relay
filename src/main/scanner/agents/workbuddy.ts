import { join } from 'path'
import type { ConfigFileInfo, DataDirInfo } from '@shared/types'
import type { UsageRecord } from '../types'
import { HOME, dirSize, exists, readAppBundleVersion, readJson, readText, redact } from '../../lib/fs'
import { appPaths, emptySnapshot, skillsFromDir, type Scanner, type ScannerMeta } from '../types'
import Database from 'better-sqlite3'

const meta: ScannerMeta = {
  id: 'workbuddy',
  name: 'WorkBuddy',
  vendor: 'Tencent',
  kind: 'desktop',
  color: '#10b981',
  probes: [join(HOME, '.workbuddy'), '/Applications/WorkBuddy.app'],
  installProbes: appPaths('WorkBuddy.app')
}

export const workbuddyScanner: Scanner = {
  meta,
  scan() {
    const home = join(HOME, '.workbuddy')
    const detected = exists(home)
    const snap = emptySnapshot(meta, detected)
    if (!detected) return snap

    snap.info.version = readAppBundleVersion('/Applications/WorkBuddy.app')

    // 配置
    const configPaths = [join(home, 'settings.json'), join(home, '.mcp.json')]
    snap.configs = configPaths.map((p): ConfigFileInfo => {
      const raw = readJson(p) ?? (readText(p) ? { raw: true } : null)
      return { path: p, exists: raw != null, summary: raw ? (redact(raw) as Record<string, unknown>) : null }
    })

    // 数据目录
    const dirs: [string, string][] = [
      [join(home, 'skills'), '技能'],
      [join(home, 'plugins'), '插件'],
      [join(home, 'sessions'), '会话'],
      [join(home, 'projects'), '项目记录'],
      [join(home, 'memory'), '记忆库'],
      [join(home, 'connectors'), '连接器']
    ]
    snap.dataDirs = dirs
      .filter(([p]) => exists(p))
      .map(([p, label]): DataDirInfo => ({ path: p, label, sizeBytes: dirSize(p) }))

    // 技能：skills/ 下带 SKILL.md 的目录
    snap.skills.push(...skillsFromDir(meta.id, join(home, 'skills')))

    // MCP：.mcp.json
    const mcpJson = readJson<{ mcpServers?: Record<string, { type?: string; url?: string; command?: string; description?: string; disabled?: boolean }> }>(join(home, '.mcp.json'))
    type WbMcp = { type?: string; url?: string; command?: string; description?: string; disabled?: boolean }
    const servers: Record<string, WbMcp> = mcpJson?.mcpServers ?? {}
    for (const [name, entry] of Object.entries(servers)) {
      snap.mcpServers.push({
        name,
        transport: entry.url ? 'http' : entry.command ? 'stdio' : 'unknown',
        endpoint: entry.url || entry.command,
        enabled: !entry.disabled,
        tools: [],
        status: 'unverified',
        statusDetail: entry.description
      })
    }

    // 用量 + 项目：workbuddy.db
    try {
      const db = new Database(join(home, 'workbuddy.db'), { readonly: true, fileMustExist: true })
      const rows = db
        .prepare(
          `select s.id, s.cwd, s.model, s.created_at, u.used, u.updated_at
           from sessions s left join session_usage u on u.session_id = s.id`
        )
        .all() as {
        id: string
        cwd: string | null
        model: string | null
        created_at: number
        used: number | null
        updated_at: number | null
      }[]
      for (const r of rows) {
        if (r.used != null && r.used > 0) {
          snap.usage.push({
            ts: r.updated_at || r.created_at || Date.now(),
            model: r.model || 'unknown',
            inputTokens: r.used,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            requests: 1
          } satisfies UsageRecord)
        }
        if (r.cwd) snap.projectDirs.push(r.cwd)
      }
      const ws = db.prepare('select path from workspaces').all() as { path: string }[]
      for (const w of ws) snap.projectDirs.push(w.path)
      db.close()
    } catch {
      // 忽略
    }
    snap.projectDirs = [...new Set(snap.projectDirs)]

    snap.info.skillCount = snap.skills.length
    snap.info.mcpCount = snap.mcpServers.length
    snap.info.hasUsage = snap.usage.length > 0
    snap.info.projectCount = snap.projectDirs.length
    return snap
  }
}
