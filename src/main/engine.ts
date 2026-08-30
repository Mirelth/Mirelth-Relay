import { scanners } from './scanner/registry'
import { getStore } from './cache'

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
      const snap = await Promise.resolve(scanner.scan())
      store.saveSnapshot(snap)
      scanned.push(scanner.meta.id)
    } catch (err) {
      errors.push(`${scanner.meta.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
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
