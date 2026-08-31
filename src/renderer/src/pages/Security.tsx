import { useEffect, useState } from 'react'
import { AlertTriangle, FileLock2, KeyRound, RefreshCw, ShieldCheck } from 'lucide-react'
import type { SecurityFinding, SecurityScanResult } from '@shared/types'
import { formatDate } from '../lib/format'

const SEVERITY: Record<SecurityFinding['severity'], { label: string; color: string }> = {
  high: { label: '高危', color: 'var(--bad)' },
  medium: { label: '需关注', color: 'var(--warn)' },
  info: { label: '提示', color: 'var(--muted)' }
}

export default function Security(): React.JSX.Element {
  const [result, setResult] = useState<SecurityScanResult | null>(null)
  const [scanning, setScanning] = useState(true)
  const [error, setError] = useState('')

  const scan = async (): Promise<void> => {
    setScanning(true)
    setError('')
    try {
      setResult(await window.api.securityScan())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setScanning(false)
    }
  }

  useEffect(() => {
    void scan()
  }, [])

  const findings = result?.findings || []
  const highs = findings.filter((f) => f.severity === 'high').length
  const meds = findings.filter((f) => f.severity === 'medium').length

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm" style={{ color: 'var(--muted)' }}>
          只读检查各智能体配置文件与常见凭证文件：明文密钥、文件权限。所有密钥片段均已脱敏，不会完整展示。
        </div>
        <button className="btn btn-primary" onClick={() => void scan()} disabled={scanning}>
          <RefreshCw size={14} className={scanning ? 'animate-spin' : ''} />
          {scanning ? '体检中…' : '重新体检'}
        </button>
      </div>

      {error && (
        <div className="card p-4 text-sm" style={{ color: 'var(--bad)' }}>
          体检失败：{error}
        </div>
      )}

      {/* 汇总 */}
      <div className="grid grid-cols-3 gap-3">
        <div className="card p-4">
          <div className="text-xs" style={{ color: 'var(--muted)' }}>
            检查文件
          </div>
          <div className="mt-1 text-xl font-semibold">{result ? result.scannedFiles : '—'}</div>
        </div>
        <div className="card p-4">
          <div className="text-xs" style={{ color: 'var(--muted)' }}>
            高危
          </div>
          <div className="mt-1 text-xl font-semibold" style={{ color: 'var(--bad)' }}>
            {result ? highs : '—'}
          </div>
        </div>
        <div className="card p-4">
          <div className="text-xs" style={{ color: 'var(--muted)' }}>
            需关注
          </div>
          <div className="mt-1 text-xl font-semibold" style={{ color: 'var(--warn)' }}>
            {result ? meds : '—'}
          </div>
        </div>
      </div>

      {!scanning && !error && result && findings.length === 0 && (
        <div className="card flex flex-col items-center gap-3 p-12 text-center">
          <div
            className="flex h-14 w-14 items-center justify-center rounded-full"
            style={{
              background: 'color-mix(in srgb, var(--ok) 15%, transparent)',
              color: 'var(--ok)'
            }}
          >
            <ShieldCheck size={28} />
          </div>
          <div className="text-sm font-medium">未发现明文密钥或权限风险</div>
          <div className="text-xs" style={{ color: 'var(--muted)' }}>
            已检查 {result.scannedFiles} 个文件（智能体配置 + shell rc + 常见凭证文件），检查时间{' '}
            {formatDate(result.at)}
          </div>
        </div>
      )}

      {result && findings.length > 0 && (
        <div className="card overflow-hidden">
          <div
            className="border-b px-4 py-3 text-sm font-medium"
            style={{ borderColor: 'var(--border)' }}
          >
            风险清单（{findings.length} 项）
          </div>
          <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
            {findings.map((f) => {
              const sv = SEVERITY[f.severity]
              return (
                <div
                  key={f.id}
                  className="flex items-start gap-3 px-4 py-3.5"
                  style={{ borderColor: 'var(--border)' }}
                >
                  <div
                    className="mt-0.5 shrink-0"
                    style={{ color: f.category === 'loose-permissions' ? 'var(--bad)' : sv.color }}
                  >
                    {f.category === 'loose-permissions' ? (
                      <FileLock2 size={16} />
                    ) : (
                      <KeyRound size={16} />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span
                        className="badge"
                        style={{
                          background: `color-mix(in srgb, ${sv.color} 16%, transparent)`,
                          color: sv.color
                        }}
                      >
                        {sv.label}
                      </span>
                      <span className="font-medium">{f.kind}</span>
                      {f.agentName && (
                        <span
                          className="badge"
                          style={{
                            background: 'color-mix(in srgb, var(--accent) 14%, transparent)',
                            color: 'var(--accent)'
                          }}
                        >
                          {f.agentName}
                        </span>
                      )}
                      {f.line != null && (
                        <span className="text-xs" style={{ color: 'var(--muted)' }}>
                          第 {f.line} 行 · {f.snippet}
                        </span>
                      )}
                      {f.category === 'loose-permissions' && (
                        <span className="font-mono text-xs" style={{ color: 'var(--muted)' }}>
                          {f.snippet}
                        </span>
                      )}
                    </div>
                    <div
                      className="mt-1 truncate font-mono text-xs"
                      style={{ color: 'var(--muted)' }}
                      title={f.path}
                    >
                      {f.path}
                    </div>
                    <div
                      className="mt-1.5 text-xs leading-relaxed"
                      style={{ color: 'var(--text)' }}
                    >
                      <AlertTriangle
                        size={11}
                        className="mr-1 inline"
                        style={{ color: sv.color }}
                      />
                      {f.advice}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {result && (
        <div className="text-xs" style={{ color: 'var(--muted)' }}>
          检查时间 {formatDate(result.at)} · 覆盖 {result.checkedPaths} 个登记路径（存在{' '}
          {result.scannedFiles} 个）
        </div>
      )}
    </div>
  )
}
