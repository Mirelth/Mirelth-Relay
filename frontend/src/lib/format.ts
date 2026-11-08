export function formatTokens(n: number): string {
  if (n == null || isNaN(n)) return '0'
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(n)
}

export function formatBytes(bytes: number): string {
  if (bytes == null || bytes < 0) return '—'
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB'
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB'
  if (bytes >= 1e3) return (bytes / 1e3).toFixed(1) + ' KB'
  return bytes + ' B'
}

export function formatDate(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', { hour12: false })
}

export function formatDateOnly(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleDateString('zh-CN')
}

/** 金额显示（人民币）：大额用万，小额保底 3 位小数 */
export function formatMoneyCny(n: number): string {
  if (!isFinite(n) || n === 0) return '¥0'
  const abs = Math.abs(n)
  if (abs >= 10000) return '¥' + (n / 10000).toFixed(2) + '万'
  if (abs >= 100) return '¥' + n.toFixed(1)
  if (abs >= 1) return '¥' + n.toFixed(2)
  return '¥' + n.toFixed(3)
}

export function relativeTime(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const diff = Date.now() - d.getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  const day = Math.floor(h / 24)
  if (day < 30) return `${day} 天前`
  return formatDateOnly(iso)
}
