import { join } from 'path'
import type { ConfigFileInfo, DataDirInfo } from '@shared/types'
import type { UsageRecord } from '../types'
import { HOME, dirSize, exists, readJsonc } from '../../lib/fs'
import { emptySnapshot, type Scanner, type ScannerMeta } from '../types'
import Database from 'better-sqlite3'

/**
 * OpenCode 家族扫描器：标准 OpenCode 与 Loomy（讯飞 fork）共享同一套数据布局。
 * - session 表含 tokens_input/output/reasoning/cache_read/cache_write、cost、model、directory
 * - Loomy 旧版 session 表无 token 列，token 存在 part 表的 step-finish JSON 里
 */
export function createOpencodeFamilyScanner(opts: {
  id: string
  name: string
  vendor: string
  color: string
  configPath: string
  dataDir: string
  configAppDir?: string
}): Scanner {
  const meta: ScannerMeta = {
    id: opts.id,
    name: opts.name,
    vendor: opts.vendor,
    kind: 'desktop',
    color: opts.color,
    probes: [opts.configPath, opts.dataDir]
  }

  return {
    meta,
    scan() {
      const detected = exists(opts.configPath) || exists(opts.dataDir)
      const snap = emptySnapshot(meta, detected)
      if (!detected) return snap

      // 配置
      snap.configs = [
        {
          path: opts.configPath,
          exists: exists(opts.configPath),
          summary: (readJsonc(opts.configPath) || null) as ConfigFileInfo['summary']
        }
      ]

      // 数据目录
      const dirs: [string, string][] = [
        [opts.dataDir, '数据库与快照'],
        [join(opts.dataDir, 'log'), '日志'],
        [join(opts.dataDir, 'snapshot'), '文件快照']
      ]
      if (opts.configAppDir) dirs.push([opts.configAppDir, '应用数据'])
      snap.dataDirs = dirs
        .filter(([p]) => exists(p))
        .map(([p, label]): DataDirInfo => ({ path: p, label, sizeBytes: dirSize(p) }))

      const dbPath = join(opts.dataDir, 'opencode.db')
      try {
        const db = new Database(dbPath, { readonly: true, fileMustExist: true })
        // 项目目录
        try {
          const pd = db.prepare('select distinct directory from project_directory').all() as {
            directory: string
          }[]
          snap.projectDirs = pd.map((r) => r.directory)
        } catch {
          /* 表不存在 */
        }

        // 优先 session 表的 token 汇总列（标准 OpenCode）
        let usedSessionTable = false
        try {
          const rows = db
            .prepare(
              `select directory, model, time_created, cost,
                      tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write
               from session where tokens_input is not null`
            )
            .all() as {
            directory: string | null
            model: string | null
            time_created: number
            cost: number | null
            tokens_input: number
            tokens_output: number
            tokens_reasoning: number | null
            tokens_cache_read: number | null
            tokens_cache_write: number | null
          }[]
          for (const r of rows) {
            let model = 'unknown'
            try {
              const m = JSON.parse(r.model || '{}')
              model = m.id || r.model || 'unknown'
            } catch {
              model = r.model || 'unknown'
            }
            snap.usage.push({
              ts: r.time_created,
              model,
              inputTokens: r.tokens_input || 0,
              outputTokens: r.tokens_output || 0,
              cacheReadTokens: r.tokens_cache_read || 0,
              cacheWriteTokens: r.tokens_cache_write || 0,
              reasoningTokens: r.tokens_reasoning || 0,
              requests: 1,
              costUsd: r.cost || 0
            } satisfies UsageRecord)
            if (r.directory) snap.projectDirs.push(r.directory)
          }
          usedSessionTable = true
        } catch {
          /* 无 token 列（Loomy），回落到 part 表 */
        }

        // Loomy：从 part.step-finish JSON 聚合，模型取自所属 assistant message
        if (!usedSessionTable) {
          try {
            const rows = db
              .prepare(
                `select p.session_id, p.data as part_data, m.data as msg_data
                 from part p join message m on m.id = p.message_id
                 where p.data like '%step-finish%'`
              )
              .all() as { session_id: string; part_data: string; msg_data: string }[]
            for (const r of rows) {
              const part = JSON.parse(r.part_data)
              const tokens = part?.tokens
              if (!tokens) continue
              let model = 'unknown'
              let msgTime = 0
              try {
                const msg = JSON.parse(r.msg_data)
                model = msg?.modelID || msg?.model || 'unknown'
                msgTime = msg?.time?.created || 0
              } catch {
                /* 忽略 */
              }
              snap.usage.push({
                ts: msgTime || part?.time?.created || 0,
                model,
                inputTokens: tokens.input || 0,
                outputTokens: tokens.output || 0,
                cacheReadTokens: tokens.cache?.read || 0,
                cacheWriteTokens: tokens.cache?.write || 0,
                reasoningTokens: tokens.reasoning || 0,
                requests: 1,
                costUsd: part?.cost || 0
              } satisfies UsageRecord)
            }
            try {
              const dirs2 = db.prepare('select distinct directory from session where directory is not null').all() as {
                directory: string
              }[]
              for (const d of dirs2) snap.projectDirs.push(d.directory)
            } catch {
              /* 忽略 */
            }
          } catch {
            /* 忽略 */
          }
        }
        db.close()
      } catch {
        /* 数据库不可用 */
      }
      snap.projectDirs = [...new Set(snap.projectDirs)]

      snap.info.skillCount = 0
      snap.info.mcpCount = 0
      snap.info.hasUsage = snap.usage.length > 0
      snap.info.projectCount = snap.projectDirs.length
      return snap
    }
  }
}

export const opencodeScanner: Scanner = createOpencodeFamilyScanner({
  id: 'opencode',
  name: 'OpenCode',
  vendor: 'SST / OpenCode',
  color: '#f97316',
  configPath: join(HOME, '.config/opencode/opencode.jsonc'),
  dataDir: join(HOME, '.local/share/opencode'),
  configAppDir: join(HOME, 'Library/Application Support/ai.opencode.desktop')
})

export const loomyScanner: Scanner = createOpencodeFamilyScanner({
  id: 'loomy',
  name: 'Loomy OpenCode',
  vendor: 'iFlytek',
  color: '#06b6d4',
  configPath: join(HOME, '.config/loomy-opencode/opencode.json'),
  dataDir: join(HOME, '.local/share/loomy/opencode'),
  configAppDir: join(HOME, '.config/loomy')
})
