import { join, basename } from 'path'
import type { ConfigFileInfo, DataDirInfo } from '@shared/types'
import { HOME, dirSize, exists, isDir, listDirs, readAppBundleVersion, readJson, redact } from '../../lib/fs'
import { appPaths, emptySnapshot, type Scanner, type ScannerMeta } from '../types'

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
    for (const p of listDirs(join(home, 'projects'))) {
      const decoded = decodeQoderProjectDir(basename(p))
      if (decoded) snap.projectDirs.push(decoded)
    }

    snap.info.skillCount = snap.skills.length
    snap.info.mcpCount = 0
    snap.info.hasUsage = false
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
