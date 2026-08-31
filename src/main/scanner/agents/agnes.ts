import { join } from 'path'
import type { DataDirInfo } from '@shared/types'
import type { UsageRecord } from '../types'
import { HOME, dirSize, exists, readAppBundleVersion, readYaml, redact } from '../../lib/fs'
import { appPaths, emptySnapshot, type Scanner, type ScannerMeta } from '../types'
import Database from 'better-sqlite3'

const meta: ScannerMeta = {
  id: 'agnes',
  name: 'AgnesCode',
  vendor: 'Agnes',
  kind: 'desktop',
  color: '#ec4899',
  probes: [join(HOME, '.agnes'), '/Applications/AgnesCode.app'],
  installProbes: appPaths('AgnesCode.app')
}

export const agnesScanner: Scanner = {
  meta,
  scan() {
    const home = join(HOME, '.agnes')
    const detected = exists(home)
    const snap = emptySnapshot(meta, detected)
    if (!detected) return snap

    // 配置（YAML，extensions 即技能清单）
    const configPath = join(home, 'config/config.yaml')
    const config = readYaml<{
      AGNES_MODE?: string
      extensions?: Record<string, { enabled?: boolean; name?: string; description?: string; bundled?: boolean; display_name?: string }>
    }>(configPath)
    snap.configs = [
      {
        path: configPath,
        exists: config != null,
        summary: config ? (redact(config) as Record<string, unknown>) : null
      }
    ]

    // 数据目录
    const dirs: [string, string][] = [
      [join(home, 'data/sessions'), '会话数据库'],
      [join(home, 'data'), '数据目录'],
      [join(home, 'memories'), '记忆库'],
      [join(home, 'state'), '运行状态']
    ]
    snap.dataDirs = dirs
      .filter(([p]) => exists(p))
      .map(([p, label]): DataDirInfo => ({ path: p, label, sizeBytes: dirSize(p) }))

    // 技能：config.yaml extensions
    type AgnesExt = { enabled?: boolean; name?: string; description?: string; bundled?: boolean; display_name?: string }
    const extensions: Record<string, AgnesExt> = config?.extensions ?? {}
    for (const [key, ext] of Object.entries(extensions)) {
      snap.skills.push({
        id: `${meta.id}:ext:${key}`,
        agentId: meta.id,
        name: ext?.display_name || ext?.name || key,
        description: ext?.description,
        source: configPath,
        builtin: ext?.bundled ?? false
      })
    }

    // 用量：sessions.db usage_ledger 表
    try {
      const db = new Database(join(home, 'data/sessions/sessions.db'), {
        readonly: true,
        fileMustExist: true
      })
      const rows = db
        .prepare(
          `select l.created_timestamp, l.model, l.input_tokens, l.output_tokens,
                  l.cache_read_tokens, l.cache_write_tokens, l.cost, s.working_dir
           from usage_ledger l left join sessions s on s.id = l.session_id`
        )
        .all() as {
        created_timestamp: number
        model: string | null
        input_tokens: number
        output_tokens: number
        cache_read_tokens: number | null
        cache_write_tokens: number | null
        cost: number | null
        working_dir: string | null
      }[]
      for (const r of rows) {
        snap.usage.push({
          ts: r.created_timestamp < 1e12 ? r.created_timestamp * 1000 : r.created_timestamp,
          model: r.model || 'unknown',
          inputTokens: r.input_tokens || 0,
          outputTokens: r.output_tokens || 0,
          cacheReadTokens: r.cache_read_tokens || 0,
          cacheWriteTokens: r.cache_write_tokens || 0,
          reasoningTokens: 0,
          requests: 1,
          costUsd: r.cost || 0
        } satisfies UsageRecord)
        if (r.working_dir) snap.projectDirs.push(r.working_dir)
      }
      db.close()
    } catch {
      /* 忽略 */
    }
    snap.projectDirs = [...new Set(snap.projectDirs)]

    snap.info.version = readAppBundleVersion('/Applications/AgnesCode.app')
    snap.info.skillCount = snap.skills.length
    snap.info.mcpCount = 0
    snap.info.hasUsage = snap.usage.length > 0
    snap.info.projectCount = snap.projectDirs.length
    return snap
  }
}
