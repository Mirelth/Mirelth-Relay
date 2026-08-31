import { join } from 'path'
import type { DataDirInfo } from '@shared/types'
import { HOME, dirSize, exists, readYaml, redact } from '../../lib/fs'
import { emptySnapshot, type Scanner, type ScannerMeta } from '../types'

const meta: ScannerMeta = {
  id: 'ycli',
  name: 'ycli',
  kind: 'cli',
  color: '#64748b',
  probes: [join(HOME, '.ycli')],
  installBins: ['ycli']
}

export const ycliScanner: Scanner = {
  meta,
  scan() {
    const home = join(HOME, '.ycli')
    const detected = exists(home)
    const snap = emptySnapshot(meta, detected)
    if (!detected) return snap

    // 配置（含 API key，必须脱敏）
    const configPath = join(home, 'config.yaml')
    const config = readYaml(configPath)
    snap.configs = [
      {
        path: configPath,
        exists: config != null,
        summary: config ? (redact(config) as Record<string, unknown>) : null
      }
    ]

    // 数据目录
    const dirs: [string, string][] = [
      [home, '数据目录'],
      [join(home, 'logs'), '日志']
    ]
    snap.dataDirs = dirs
      .filter(([p]) => exists(p))
      .map(([p, label]): DataDirInfo => ({ path: p, label, sizeBytes: dirSize(p) }))

    // 用量数据：session.db 仅存记忆 episodes，无 token 字段 → hasUsage=false

    snap.info.skillCount = 0
    snap.info.mcpCount = 0
    snap.info.hasUsage = false
    snap.info.projectCount = 0
    return snap
  }
}
