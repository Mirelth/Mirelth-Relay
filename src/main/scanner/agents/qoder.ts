import { join, basename } from 'path'
import type { ConfigFileInfo, DataDirInfo } from '@shared/types'
import { HOME, dirSize, exists, isDir, listDirs, listEntries, readAppBundleVersion, readJson, readText, redact } from '../../lib/fs'
import { logger } from '../../lib/logger'
import { DEFAULT_RATE_USD_CNY } from '../../pricing'
import { appPaths, emptySnapshot, type Scanner, type ScannerMeta } from '../types'
import type { UsageRecord } from '../types'

const meta: ScannerMeta = {
  id: 'qoder',
  name: 'Qoder',
  vendor: 'Alibaba',
  kind: 'ide',
  color: '#f59e0b',
  probes: [join(HOME, '.qoder'), '/Applications/Qoder.app'],
  installProbes: appPaths('Qoder.app')
}

interface InstalledPlugins {
  plugins?: Record<
    string,
    { scope: string; installPath: string; version: string; installedAt?: string; lastUpdated?: string }[]
  >
}

export const qoderScanner: Scanner = {
  meta,
  scan() {
    const home = join(HOME, '.qoder')
    const detected = exists(home)
    const snap = emptySnapshot(meta, detected)
    if (!detected) return snap

    snap.info.version = readAppBundleVersion('/Applications/Qoder.app')

    // 配置
    const configPaths = [join(home, 'settings.json'), join(home, '.qoder-app-status.json')]
    snap.configs = configPaths.map((p): ConfigFileInfo => {
      const raw = readJson(p)
      return { path: p, exists: raw != null, summary: raw ? (redact(raw) as Record<string, unknown>) : null }
    })

    // 数据目录
    const dirs: [string, string][] = [
      [join(home, 'projects'), '会话记录'],
      [join(home, 'plugins'), '插件'],
      [join(home, 'logs'), '日志'],
      [join(home, '.models'), '模型配置']
    ]
    snap.dataDirs = dirs
      .filter(([p]) => exists(p))
      .map(([p, label]): DataDirInfo => ({ path: p, label, sizeBytes: dirSize(p) }))

    // 技能（插件）：installed_plugins_v2.json
    const plugins = readJson<InstalledPlugins>(join(home, 'plugins', 'installed_plugins_v2.json'))
    if (plugins?.plugins) {
      const pluginMap = plugins.plugins as NonNullable<InstalledPlugins['plugins']>
      for (const [pluginKey, installs] of Object.entries(pluginMap)) {
        const [name] = pluginKey.split('@')
        const inst = installs[0]
        snap.skills.push({
          id: `${meta.id}:${pluginKey}`,
          agentId: meta.id,
          name: name || pluginKey,
          version: inst?.version,
          installedAt: inst?.installedAt,
          source: inst?.installPath || pluginKey,
          builtin: false
        })
      }
    }
    // plugins/cache 下的目录也算技能来源
    for (const mkt of listDirs(join(home, 'plugins', 'cache'))) {
      for (const p of listDirs(mkt)) {
        const name = basename(p)
        if (!snap.skills.some((s) => s.name === name)) {
          snap.skills.push({
            id: `${meta.id}:cache:${name}`,
            agentId: meta.id,
            name,
            source: p,
            builtin: false
          })
        }
      }
    }

    // 项目目录：projects/-Users-new-... 目录名反解为路径
    const projectsDir = join(home, 'projects')
    for (const p of listDirs(projectsDir)) {
      const decoded = decodeQoderProjectDir(basename(p))
      if (decoded) snap.projectDirs.push(decoded)
    }

    // 用量：解析 projects 下的 JSONL 会话文件，提取 credits 消耗
    snap.usage = parseQoderUsage(projectsDir)

    snap.info.skillCount = snap.skills.length
    snap.info.mcpCount = 0
    snap.info.hasUsage = snap.usage.length > 0
    snap.info.projectCount = snap.projectDirs.length
    return snap
  }
}

/** '-Users-new-Documents-Qoder-2026-08-27-xxx' → '/Users/new/Documents/Qoder/2026-08-27/xxx'（尽力反解） */
function decodeQoderProjectDir(name: string): string | null {
  if (!name.startsWith('-')) return null
  const parts = name.split('-').filter(Boolean)
  // 逐段贪心回溯：从最长的可能前缀开始尝试存在的目录
  let candidate = '/' + parts.join('/')
  if (isDir(candidate)) return candidate
  // 简化处理：把 '-Users-new-...' 还原为 '/Users/new/...'，空格类目录无法可靠恢复
  candidate = '/' + parts.join('/')
  return candidate
}

/** Qoder 模型上下文窗口（用于从 context_usage_ratio 估算 input tokens） */
const QODER_CONTEXT_WINDOW = 200_000

/**
 * 解析 Qoder JSONL 会话文件，提取用量数据。
 * Qoder 不直接上报 token 数，但可通过 context_usage_ratio × 上下文窗口 估算 input tokens，
 * 从 assistant 消息 content 长度估算 output tokens。同时记录 credits 用于成本估算。
 */
function parseQoderUsage(projectsDir: string): UsageRecord[] {
  const records: UsageRecord[] = []
  if (!exists(projectsDir)) return records

  for (const projectDir of listDirs(projectsDir)) {
    for (const file of listEntries(projectDir)) {
      if (!file.endsWith('.jsonl')) continue
      const text = readText(join(projectDir, file))
      if (!text) continue
      for (const line of text.split('\n')) {
        if (!line.includes('"usage"')) continue
        try {
          const obj = JSON.parse(line) as {
            type?: string
            timestamp?: string
            message?: {
              model?: string
              content?: unknown[]
              usage?: {
                credits?: number
                context_usage_ratio?: number
              }
            }
          }
          if (obj.type !== 'assistant') continue
          const u = obj.message?.usage
          if (!u || !u.credits || u.credits <= 0) continue
          const ts = obj.timestamp ? Date.parse(obj.timestamp) : 0
          if (!ts) continue

          const ratio = u.context_usage_ratio ?? 0
          const estInputTokens = Math.round(ratio * QODER_CONTEXT_WINDOW)

          let estOutputTokens = 100
          if (obj.message?.content && Array.isArray(obj.message.content)) {
            let chars = 0
            for (const block of obj.message.content) {
              chars += JSON.stringify(block).length
            }
            estOutputTokens = Math.max(100, Math.round(chars / 3))
          }

          records.push({
            ts,
            model: obj.message?.model || 'unknown',
            inputTokens: estInputTokens,
            outputTokens: estOutputTokens,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            requests: 1,
            costUsd: u.credits / DEFAULT_RATE_USD_CNY
          })
        } catch {
          // JSONL 行解析失败，跳过
        }
      }
    }
  }
  logger.debug('qoder', `解析到 ${records.length} 条用量记录`)
  return records
}
