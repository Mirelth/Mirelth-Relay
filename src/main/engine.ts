import { scanners } from './scanner/registry'
import { detectInstallState } from './scanner/types'
import { getStore } from './cache'
import { logger } from './lib/logger'

export interface RefreshResult {
  ok: boolean
  error?: string
  scannedAgents: string[]
  durationMs: number
}

/** 全量扫描：逐个执行适配器并写入缓存。单个适配器失败不影响其他。 */
export async function refreshAll(agentIdFilter?: string): Promise<RefreshResult> {
  const start = Date.now()
  const store = getStore()
  const scanned: string[] = []
  const errors: string[] = []
  for (const scanner of scanners) {
    if (agentIdFilter && scanner.meta.id !== agentIdFilter) continue
    try {
      console.log(`[scan] ${scanner.meta.id} start`);
      const snap = await Promise.resolve(scanner.scan())
      // 集中判定安装状态：本体证据（应用包/CLI）存在=installed；只有数据=已卸载的 residual；无证据=unknown
      snap.info.installState = detectInstallState(scanner.meta, snap.info.detected)
      store.saveSnapshot(snap)
      console.log(`[scan] ${scanner.meta.id} saved (${Date.now() - start}ms since scan start)`)
      scanned.push(scanner.meta.id)
    } catch (err) {
      logger.error('scan', `${scanner.meta.id} failed`, err)
      errors.push(`${scanner.meta.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  // 全量扫描时清理不在注册表中的陈旧行（如适配器拆分/改名遗留的旧 id）
  if (!agentIdFilter) store.deleteAgentsExcept(scanners.map((s) => s.meta.id))
  return {
    ok: errors.length === 0,
    error: errors.length ? errors.join('; ') : undefined,
    scannedAgents: scanned,
    durationMs: Date.now() - start
  }
}

/** 刷新并把已扫描列表写入 meta，供 lastScan 查询 */
export async function refreshAndRecord(agentIdFilter?: string): Promise<RefreshResult> {
  const result = await refreshAll(agentIdFilter)
  const store = getStore()
  store.setMeta('scannedAgents', JSON.stringify(result.scannedAgents))
  return result
}
