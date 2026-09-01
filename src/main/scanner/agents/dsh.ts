import { readdirSync } from 'fs'
import { join } from 'path'
import type { DataDirInfo } from '@shared/types'
import type { UsageRecord } from '../types'
import { HOME, decompressZstdFile, dirSize, exists, findAppOnVolumes, isDir, listDirs, readYaml, redact } from '../../lib/fs'
import { appPaths, emptySnapshot, type Scanner, type ScannerMeta } from '../types'

/**
 * DSH 家族扫描器。同一引擎有两种分发形态，数据目录不同，作为两个独立实体分别统计：
 * - DSH Web：~/.dsh/sessions
 * - DSH Desktop：~/.dsh-desktop/sessions（DeepSeek Harness Desktop）
 *
 * 两边走同一套用量格式：sessions/<proj>/<session>/session.jsonl.zstd
 * （zstd 多帧追加式日志，用量在 assistant/chunk 的 usage 行）。
 * 逐请求解析，时间戳与模型名真实且粒度一致；两边的会话 id 不重叠，
 * 不存在重复计数。旧的 .dsh-usage-stats.json 是按天粗聚、时间戳靠猜，
 * 已弃用。
 */

/** 解析一个 session.jsonl 文本（纯函数，供测试）。用量行：assistant/chunk 且 data.chunk.type=usage */
export function parseDshSessionLines(text: string): { usage: UsageRecord[]; cwd?: string } {
  const usage: UsageRecord[] = []
  let cwd: string | undefined
  let model = 'unknown'
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let j: Record<string, unknown>
    try {
      j = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const data = (j.data || {}) as Record<string, unknown>
    switch (j.type) {
      case 'session':
        if (typeof j.cwd === 'string' && j.cwd) cwd = j.cwd
        break
      case 'request/header': {
        const m = ((data.header as Record<string, unknown> | undefined)?.config as Record<string, unknown> | undefined)?.model
        if (typeof m === 'string' && m) model = m
        break
      }
      case 'assistant/chunk': {
        const chunk = data.chunk as Record<string, unknown> | undefined
        if (chunk?.type === 'usage') {
          const u = (chunk.usage || {}) as Record<string, number>
          usage.push({
            ts: typeof j.time === 'number' ? j.time : Date.now(),
            model,
            inputTokens: u.inputTokens || 0,
            outputTokens: u.outputTokens || 0,
            cacheReadTokens: u.cacheReadTokens || 0,
            cacheWriteTokens: u.cacheWriteTokens || 0,
            reasoningTokens: u.reasoningTokens || 0,
            requests: 1
          })
        }
        break
      }
    }
  }
  return { usage, cwd }
}

/** 遍历 sessions 目录树（<proj>/<session>/session.jsonl.zstd），解 zstd 并聚合用量与项目目录 */
function scanDshSessions(sessionsDir: string, cap = 2000): { usage: UsageRecord[]; projectDirs: string[] } {
  const usage: UsageRecord[] = []
  const projectDirs = new Set<string>()
  let files = 0
  for (const proj of listDirs(sessionsDir)) {
    console.log(`[dsh] proj ${proj.split('/').pop()} 子目录 ${listDirs(proj).length}`)
    const t0 = Date.now()
    for (const sess of listDirs(proj)) {
      const f = join(sess, 'session.jsonl.zstd')
      if (!exists(f) || files++ >= cap) continue
      try {
        const parsed = parseDshSessionLines(decompressZstdFile(f))
        usage.push(...parsed.usage)
        if (parsed.cwd) projectDirs.add(parsed.cwd)
      } catch (err) {
        console.warn(`[dsh] 会话解析失败 ${sess.split('/').pop()}: ${err instanceof Error ? err.message : err}`)
      }
    }
    console.log(`[dsh] proj done ${proj.split('/').pop()} ${Date.now() - t0}ms 累计files=${files}`)
  }
  console.log(`[dsh] scan 结束 files=${files} usage=${usage.length}`)
  return { usage, projectDirs: [...projectDirs] }
}

interface DshOpts {
  id: string
  name: string
  home: string
  color: string
  installProbeResolver?: () => string[]
}

function createDshScanner(opts: DshOpts): Scanner {
  const meta: ScannerMeta = {
    id: opts.id,
    name: opts.name,
    vendor: 'DeepSeek',
    kind: 'desktop',
    color: opts.color,
    probes: [opts.home],
    installProbeResolver: opts.installProbeResolver
  }

  return {
    meta,
    scan() {
      const home = opts.home
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
      const presetDir = join(home, '.agent-presets')
      if (isDir(presetDir)) {
        try {
          for (const name of readdirSync(presetDir)) {
            if (name.startsWith('.')) continue
            snap.skills.push({
              id: `${meta.id}:preset:${name}`,
              agentId: meta.id,
              name,
              source: join(presetDir, name),
              builtin: false
            })
          }
        } catch {
          /* 忽略 */
        }
      }

      // 用量：逐请求解析 zstd 会话日志
      const r = scanDshSessions(join(home, 'sessions'))
      snap.usage.push(...r.usage)
      snap.projectDirs.push(...r.projectDirs)
      snap.projectDirs = [...new Set(snap.projectDirs)]

      snap.info.skillCount = snap.skills.length
      snap.info.mcpCount = 0
      snap.info.hasUsage = snap.usage.length > 0
      snap.info.projectCount = snap.projectDirs.length
      return snap
    }
  }
}

const DESKTOP_APP = 'DeepSeek Harness Desktop.app'

export const dshWebScanner: Scanner = createDshScanner({
  id: 'dsh-web',
  name: 'DSH Web',
  home: join(HOME, '.dsh'),
  color: '#8b5cf6'
  // Web 形态无可靠的本地本体位置 → 状态"未确认"
})

export const dshDesktopScanner: Scanner = createDshScanner({
  id: 'dsh-desktop',
  name: 'DSH Desktop',
  home: join(HOME, '.dsh-desktop'),
  color: '#a78bfa',
  // 桌面版是绿色分发的 .app：/Applications、用户级或挂载卷里任意位置运行
  installProbeResolver: () => {
    const onVol = findAppOnVolumes(DESKTOP_APP)
    return [...appPaths(DESKTOP_APP), ...(onVol ? [onVol] : [])]
  }
})
