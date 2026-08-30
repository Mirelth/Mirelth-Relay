import { readdirSync } from 'fs'
import { join } from 'path'
import type { DataDirInfo } from '@shared/types'
import type { UsageRecord } from '../types'
import { HOME, dirSize, exists, isDir, readJson, readYaml, redact } from '../../lib/fs'
import { emptySnapshot, type Scanner, type ScannerMeta } from '../types'

const meta: ScannerMeta = {
  id: 'dsh',
  name: 'DSH',
  vendor: 'DeepSeek',
  kind: 'desktop',
  color: '#8b5cf6',
  probes: [join(HOME, '.dsh'), join(HOME, '.dsh-desktop')]
}

interface DshModelStat {
  calls: number
  input: number
  output: number
  cacheHit: number
  cacheMiss: number
  cost: number
  reasoning: number
}

interface DshStats {
  total?: DshModelStat
  byModel?: Record<string, DshModelStat>
  byDay?: Record<string, DshModelStat>
  byDayModels?: Record<string, Record<string, DshModelStat>>
}

interface DshLedger {
  sessions?: { cwd?: string; [k: string]: unknown }[] | Record<string, { cwd?: string; [k: string]: unknown }>
}

export const dshScanner: Scanner = {
  meta,
  scan() {
    const home = exists(join(HOME, '.dsh')) ? join(HOME, '.dsh') : join(HOME, '.dsh-desktop')
    const detected = exists(home)
    const snap = emptySnapshot(meta, detected)
    if (!detected) return snap

    // 配置（YAML，含 provider，凭据脱敏）
    const settingsPath = join(home, 'settings.yaml')
    const settings = readYaml(settingsPath)
    snap.configs = [
      {
        path: settingsPath,
        exists: settings != null,
        summary: settings ? (redact(settings) as Record<string, unknown>) : null
      }
    ]

    // 数据目录
    const dirs: [string, string][] = [
      [join(home, 'sessions'), '会话记录'],
      [join(home, 'memory'), '记忆库'],
      [join(home, '.agent-presets'), '智能体预设'],
      [join(home, 'storages'), '存储缓存']
    ]
    snap.dataDirs = dirs
      .filter(([p]) => exists(p))
      .map(([p, label]): DataDirInfo => ({ path: p, label, sizeBytes: dirSize(p) }))

    // 技能：.agent-presets 视为技能/预设清单
    for (const p of [join(home, '.agent-presets'), join(HOME, '.dsh-desktop/.agent-presets')]) {
      if (!isDir(p)) continue
      try {
        for (const name of readdirSync(p)) {
          if (name.startsWith('.')) continue
          snap.skills.push({
            id: `${meta.id}:preset:${name}`,
            agentId: meta.id,
            name,
            source: join(p, name),
            builtin: false
          })
        }
      } catch {
        // 忽略
      }
    }

    // 用量：.dsh-usage-stats.json（byDayModels 提供逐日逐模型明细）
    const stats = readJson<DshStats>(join(home, '.dsh-usage-stats.json'))
    if (stats) {
      const byDayModels = stats.byDayModels || {}
      const dayKeys = new Set([...Object.keys(stats.byDay || {}), ...Object.keys(byDayModels)])
      for (const day of dayKeys) {
        const models: Record<string, DshModelStat> = byDayModels[day] || { unknown: stats.byDay?.[day] || ({} as DshModelStat) }
        for (const [model, s] of Object.entries(models)) {
          if (!s || (s.input === 0 && s.output === 0)) continue
          snap.usage.push({
            ts: new Date(day + 'T12:00:00').getTime(),
            model,
            inputTokens: s.input || 0,
            outputTokens: s.output || 0,
            cacheReadTokens: s.cacheHit || 0,
            cacheWriteTokens: s.cacheMiss || 0,
            reasoningTokens: s.reasoning || 0,
            requests: s.calls || 0,
            costUsd: s.cost || 0
          } satisfies UsageRecord)
        }
      }
    }

    // 项目目录：ledger 中逐会话 cwd
    const ledger = readJson<DshLedger>(join(home, '.dsh-usage-ledger.json'))
    const sessions = Array.isArray(ledger?.sessions)
      ? ledger.sessions
      : Object.values(ledger?.sessions || {})
    for (const s of sessions) {
      if (s?.cwd && typeof s.cwd === 'string') snap.projectDirs.push(s.cwd)
    }
    snap.projectDirs = [...new Set(snap.projectDirs)]

    snap.info.skillCount = snap.skills.length
    snap.info.mcpCount = 0
    snap.info.hasUsage = snap.usage.length > 0
    snap.info.projectCount = snap.projectDirs.length
    return snap
  }
}
