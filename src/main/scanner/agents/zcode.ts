import { join } from 'path'
import type { ConfigFileInfo, DataDirInfo } from '@shared/types'
import type { UsageRecord } from '../types'
import {
  HOME,
  dirSize,
  exists,
  listDirs,
  mtimeIso,
  readAppBundleVersion,
  readJson,
  redact
} from '../../lib/fs'
import { appPaths, emptySnapshot, makeSkillId, type Scanner, type ScannerMeta } from '../types'
import Database from 'better-sqlite3'

const meta: ScannerMeta = {
  id: 'zcode',
  name: 'ZCode',
  vendor: 'Zhipu AI',
  kind: 'desktop',
  color: '#6366f1',
  probes: [join(HOME, '.zcode'), '/Applications/ZCode.app'],
  installProbes: appPaths('ZCode.app')
}

function skillsFromPluginCache(snap: ReturnType<typeof emptySnapshot>): void {
  const cacheRoot = join(HOME, '.zcode/cli/plugins/cache')
  for (const marketplace of listDirs(cacheRoot)) {
    for (const plugin of listDirs(marketplace)) {
      // 结构：plugin/<version>/skills/<skill>/SKILL.md，也可能 skills 直接在 plugin 下
      const candidates = [...listDirs(plugin), plugin]
      for (const candidate of candidates) {
        const skillsDir = join(candidate, 'skills')
        for (const skillDir of listDirs(skillsDir)) {
          const name = skillDir.split('/').pop() as string
          snap.skills.push({
            id: makeSkillId(meta.id, name),
            agentId: meta.id,
            name,
            description: undefined,
            installedAt: mtimeIso(skillDir),
            source: skillDir,
            builtin: false
          })
        }
      }
    }
  }
}

export const zcodeScanner: Scanner = {
  meta,
  scan() {
    const detected = exists(meta.probes[0]) || exists(meta.probes[1])
    const snap = emptySnapshot(meta, detected)
    if (!detected) return snap

    // 版本：从应用包 Info.plist 读取
    snap.info.version = readAppBundleVersion('/Applications/ZCode.app')

    // 配置文件
    const configPaths = [
      join(HOME, '.zcode/v2/config.json'),
      join(HOME, '.zcode/v2/setting.json'),
      join(HOME, '.zcode/v2/credentials.json')
    ]
    snap.configs = configPaths.map((p): ConfigFileInfo => {
      const raw = readJson(p)
      return { path: p, exists: raw != null, summary: raw ? (redact(raw) as Record<string, unknown>) : null }
    })

    // 数据目录
    const dirs: [string, string][] = [
      [join(HOME, '.zcode/cli/db'), '会话/用量数据库'],
      [join(HOME, '.zcode/cli/plugins'), '插件与技能'],
      [join(HOME, '.zcode/cli/rollout'), '模型调用日志'],
      [join(HOME, '.zcode/cli/log'), '运行日志'],
      [join(HOME, '.zcode/cli/memories'), '记忆库'],
      [join(HOME, '.zcode/v2'), '应用配置']
    ]
    snap.dataDirs = dirs
      .filter(([p]) => exists(p))
      .map(([p, label]): DataDirInfo => ({ path: p, label, sizeBytes: dirSize(p) }))

    // 技能
    skillsFromPluginCache(snap)

    // Token 用量：model_usage 表逐次请求记录
    const dbPath = join(HOME, '.zcode/cli/db/db.sqlite')
    try {
      const db = new Database(dbPath, { readonly: true, fileMustExist: true })
      const rows = db
        .prepare(
          `select m.model_id, m.started_at, m.input_tokens, m.output_tokens,
                  m.reasoning_tokens, m.cache_creation_input_tokens, m.cache_read_input_tokens,
                  m.computed_total_tokens, s.directory
           from model_usage m left join session s on s.id = m.session_id
           where m.started_at is not null`
        )
        .all() as {
        model_id: string
        started_at: number
        input_tokens: number
        output_tokens: number
        reasoning_tokens: number
        cache_creation_input_tokens: number
        cache_read_input_tokens: number
        directory: string | null
      }[]
      for (const r of rows) {
        snap.usage.push({
          ts: r.started_at,
          model: r.model_id || 'unknown',
          inputTokens: r.input_tokens || 0,
          outputTokens: r.output_tokens || 0,
          cacheReadTokens: r.cache_read_input_tokens || 0,
          cacheWriteTokens: r.cache_creation_input_tokens || 0,
          reasoningTokens: r.reasoning_tokens || 0,
          requests: 1
        } satisfies UsageRecord)
      }
      const dirsRows = db.prepare('select distinct directory from session where directory is not null').all() as {
        directory: string
      }[]
      snap.projectDirs = dirsRows.map((r) => r.directory)
      db.close()
    } catch {
      // 数据库不可用时忽略
    }

    snap.info.skillCount = snap.skills.length
    snap.info.mcpCount = snap.mcpServers.length
    snap.info.hasUsage = snap.usage.length > 0
    snap.info.projectCount = snap.projectDirs.length
    return snap
  }
}
