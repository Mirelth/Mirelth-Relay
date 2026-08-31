import type { UpdateInfo } from '@shared/types'

/**
 * 检查更新：拉取发行版附带的 latest.json 资产（CNB 支持
 * /-/releases/latest/download/<asset> 的稳定公开链接），
 * 与当前版本比较。不下载不安装，只提示并给下载链接。
 * 发布流程要求每个 Release 附带 latest.json（见 docs/RELEASE.md）。
 */

export const FEED_URL =
  'https://cnb.cool/WeiGuangXunTu/AgentTower/-/releases/latest/download/latest.json'
export const RELEASES_PAGE = 'https://cnb.cool/WeiGuangXunTu/AgentTower/-/releases'

export function isNewer(current: string, latest: string): boolean {
  const a = current.split('.').map((n) => parseInt(n, 10) || 0)
  const b = latest.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (y !== x) return y > x
  }
  return false
}

interface FeedShape {
  version?: string
  notes?: string
  publishedAt?: string
  downloads?: { macArm?: string; macIntel?: string; win?: string }
}

export async function checkForUpdate(opts: {
  current: string
  ignored?: string | null
  timeoutMs?: number
}): Promise<UpdateInfo> {
  const checkedAt = new Date().toISOString()
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000)
    const res = await fetch(FEED_URL, {
      signal: controller.signal,
      headers: { accept: 'application/json' }
    })
    clearTimeout(timer)
    if (!res.ok)
      return {
        current: opts.current,
        hasUpdate: false,
        error: `版本源请求失败（HTTP ${res.status}），请确认发行版已按 docs/RELEASE.md 附带 latest.json`,
        checkedAt
      }
    const data = (await res.json()) as FeedShape
    const latest = typeof data.version === 'string' ? data.version.trim() : ''
    if (!latest)
      return {
        current: opts.current,
        hasUpdate: false,
        error: '版本源格式异常（缺少 version 字段）',
        checkedAt
      }
    const updateAvailable = isNewer(opts.current, latest)
    return {
      current: opts.current,
      latest,
      updateAvailable,
      hasUpdate: updateAvailable && opts.ignored !== latest,
      notes: data.notes,
      publishedAt: data.publishedAt,
      downloads: data.downloads,
      checkedAt
    }
  } catch (err) {
    const msg =
      err instanceof Error && err.name === 'AbortError'
        ? '检查超时，请稍后重试'
        : `检查失败：${err instanceof Error ? err.message : String(err)}`
    return { current: opts.current, hasUpdate: false, error: msg, checkedAt }
  }
}
