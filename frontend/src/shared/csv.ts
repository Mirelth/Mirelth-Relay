/** 极简 CSV 生成（RFC 4180 转义），主/渲染进程与测试共用 */
export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const esc = (v: string | number | null | undefined): string => {
    const s = v == null ? '' : String(v)
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }
  return [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\r\n')
}
