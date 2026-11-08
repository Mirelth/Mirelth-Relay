export async function call<T = any>(name: string, ...args: any[]): Promise<T | null> {
  const app = (window as any).go?.main?.App
  if (!app || typeof app[name] !== 'function') return null
  try {
    const raw = await app[name](...args)
    if (raw === null || raw === undefined) return null
    return (typeof raw === 'string' ? JSON.parse(raw) : raw) as T
  } catch (err) {
    console.error('wails binding', name, err)
    return null
  }
}

// RevealKey / RegenerateKey / ExportCSV 等返回的是原始字符串，不能按 JSON 解析。
export async function callRaw(name: string, ...args: any[]): Promise<string | null> {
  const app = (window as any).go?.main?.App
  if (!app || typeof app[name] !== 'function') return null
  try {
    const raw = await app[name](...args)
    return raw == null ? null : String(raw)
  } catch (err) {
    console.error('wails binding', name, err)
    return null
  }
}

export const fmtNum = (n: any): string => {
  const v = Number(n || 0)
  if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿'
  if (v >= 1e4) return (v / 1e4).toFixed(2) + '万'
  return v.toLocaleString('zh-CN')
}

export const fmtMoney = (n: any): string => '¥' + Number(n || 0).toFixed(2)

export const fmtTime = (ts: number): string =>
  new Date(ts).toLocaleString('zh-CN', { hour12: false })

export function downloadCSV(name: string, content: string): void {
  const blob = new Blob([content || '\ufeff'], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
