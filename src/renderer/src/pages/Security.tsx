import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  Bug,
  FileLock2,
  FolderSearch,
  GitBranch,
  KeyRound,
  RefreshCw,
  ShieldCheck
} from 'lucide-react'
import type { SecurityScanResult } from '@shared/types'
import type { RepoSecurityScanResult } from '@shared/types'
import { formatDate } from '../lib/format'

const SEVERITY: Record<'high' | 'medium' | 'info', { label: string; color: string }> = {
  high: { label: '高危', color: 'var(--bad)' },
  medium: { label: '需关注', color: 'var(--warn)' },
  info: { label: '提示', color: 'var(--muted)' }
}

type CommonFinding = {
  id: string
  severity: 'high' | 'medium' | 'info'
  category: string
  path: string
  line?: number
  kind: string
  snippet: string
  advice: string
  agentName?: string
}

const CATEGORY_ICON: Record<string, React.ReactNode> = {
  'loose-permissions': <FileLock2 size={16} />,
  'committed-env': <GitBranch size={16} />,
  'gitignore-missing': <FolderSearch size={16} />,
  'code-risk': <Bug size={16} />,
  'code-secret': <KeyRound size={16} />
}

function FindingList({ findings }: { findings: CommonFinding[] }) {
  return (
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
              <div className="mt-0.5 shrink-0" style={{ color: sv.color }}>
                {CATEGORY_ICON[f.category] ?? <KeyRound size={16} />}
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
                  {f.category !== 'loose-permissions' &&
                    f.line == null &&
                    f.category !== 'plaintext-secret' && (
                      <span className="text-xs" style={{ color: 'var(--muted)' }}>
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
                <div className="mt-1.5 text-xs leading-relaxed" style={{ color: 'var(--text)' }}>
                  <AlertTriangle size={11} className="mr-1 inline" style={{ color: sv.color }} />
                  {f.advice}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function SummaryCards({
  scanned,
  highs,
  meds
}: {
  scanned: number | string
  highs: number | string
  meds: number | string
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-3 gap-3">
      <div className="card p-4">
        <div className="text-xs" style={{ color: 'var(--muted)' }}>
          扫描文件
        </div>
        <div className="mt-1 text-xl font-semibold">{scanned}</div>
      </div>
      <div className="card p-4">
        <div className="text-xs" style={{ color: 'var(--muted)' }}>
          高危
        </div>
        <div className="mt-1 text-xl font-semibold" style={{ color: 'var(--bad)' }}>
          {highs}
        </div>
      </div>
      <div className="card p-4">
        <div className="text-xs" style={{ color: 'var(--muted)' }}>
          需关注
        </div>
        <div className="mt-1 text-xl font-semibold" style={{ color: 'var(--warn)' }}>
          {meds}
        </div>
      </div>
    </div>
  )
}

function CleanState({ text, sub }: { text: string; sub: string }): React.JSX.Element {
  return (
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
      <div className="text-sm font-medium">{text}</div>
      <div className="text-xs" style={{ color: 'var(--muted)' }}>
        {sub}
      </div>
    </div>
  )
}

function AgentAudit(): React.JSX.Element {
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

  const findings: CommonFinding[] = result?.findings ?? []
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

      <SummaryCards
        scanned={result ? result.scannedFiles : '—'}
        highs={result ? highs : '—'}
        meds={result ? meds : '—'}
      />

      {!scanning && !error && result && findings.length === 0 && (
        <CleanState
          text="未发现明文密钥或权限风险"
          sub={`已检查 ${result.scannedFiles} 个文件（智能体配置 + shell rc + 常见凭证文件），检查时间 ${formatDate(result.at)}`}
        />
      )}

      {findings.length > 0 && <FindingList findings={findings} />}

      {result && (
        <div className="text-xs" style={{ color: 'var(--muted)' }}>
          检查时间 {formatDate(result.at)} · 覆盖 {result.checkedPaths} 个登记路径（存在{' '}
          {result.scannedFiles} 个）
        </div>
      )}
    </div>
  )
}

function RepoAudit(): React.JSX.Element {
  const [dir, setDir] = useState('')
  const [result, setResult] = useState<RepoSecurityScanResult | null>(null)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState('')

  const run = async (target?: string): Promise<void> => {
    const repoDir = target ?? dir
    if (!repoDir.trim()) {
      setError('请先填写或选择仓库目录')
      return
    }
    setScanning(true)
    setError('')
    try {
      setResult(await window.api.repoSecurityScan(repoDir))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setScanning(false)
    }
  }

  const pick = async (): Promise<void> => {
    const picked = await window.api.pickRepoDir()
    if (picked) {
      setDir(picked)
      void run(picked)
    }
  }

  const findings: CommonFinding[] = result?.findings ?? []
  const highs = findings.filter((f) => f.severity === 'high').length
  const meds = findings.filter((f) => f.severity === 'medium').length

  return (
    <div className="space-y-4">
      <div className="text-sm" style={{ color: 'var(--muted)' }}>
        对一个本地代码仓库做只读安全审查：工作区明文密钥、已提交的 .env/私钥等敏感文件、.gitignore
        覆盖情况；本机装有 Semgrep 时还会自动叠加离线的代码风险扫描（eval
        动态执行、命令拼接、硬编码口令、内嵌私钥等）。不联网、不改动任何文件，密钥片段均已脱敏。
      </div>

      <div className="card flex flex-wrap items-center gap-2 p-3">
        <input
          className="input min-w-0 flex-1 font-mono text-xs"
          placeholder="/path/to/your/repo"
          value={dir}
          onChange={(e) => setDir(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !scanning) void run()
          }}
        />
        <button className="btn" onClick={() => void pick()} disabled={scanning}>
          <FolderSearch size={14} />
          选择目录
        </button>
        <button className="btn btn-primary" onClick={() => void run()} disabled={scanning}>
          <RefreshCw size={14} className={scanning ? 'animate-spin' : ''} />
          {scanning ? '审查中…' : '开始审查'}
        </button>
      </div>

      {error && (
        <div className="card p-4 text-sm" style={{ color: 'var(--bad)' }}>
          审查失败:{error}
        </div>
      )}

      {result && (
        <>
          <SummaryCards scanned={result.scannedFiles} highs={highs} meds={meds} />

          <div
            className="flex flex-wrap items-center gap-3 text-xs"
            style={{ color: 'var(--muted)' }}
          >
            <span className="font-mono">{result.repo}</span>
            <span
              className="badge"
              style={{
                background: 'color-mix(in srgb, var(--accent) 14%, transparent)',
                color: 'var(--accent)'
              }}
            >
              {result.isGitRepo ? 'Git 仓库' : '普通目录（未发现 .git）'}
            </span>
            <span>审查时间 {formatDate(result.at)}</span>
            {result.semgrep?.available ? (
              <span
                className="badge"
                title="本地 Semgrep 引擎（离线规则），本次审查已叠加代码风险扫描"
                style={{
                  background: 'color-mix(in srgb, var(--ok) 14%, transparent)',
                  color: 'var(--ok)'
                }}
              >
                <Bug size={11} className="mr-1 inline" />
                Semgrep {result.semgrep.version ?? ''} · 本地规则 {result.semgrep.rules ?? 0} 条
                {result.semgrep.error ? ' · 部分出错' : ''}
              </span>
            ) : (
              <span
                title="安装 Semgrep 后可增强检测：brew install semgrep"
                style={{ color: 'var(--muted)' }}
              >
                未启用 Semgrep（可选增强：brew install semgrep）
              </span>
            )}
            {result.truncated && (
              <span style={{ color: 'var(--warn)' }}>文件数超过上限，仅扫描了前 5000 个文件</span>
            )}
          </div>

          {findings.length === 0 ? (
            <CleanState
              text="未发现明文密钥或敏感文件风险"
              sub={`已扫描 ${result.scannedFiles} 个文本文件${result.isGitRepo ? '（含未跟踪但未被忽略的文件）' : ''}`}
            />
          ) : (
            <FindingList findings={findings} />
          )}
        </>
      )}
    </div>
  )
}

export default function Security(): React.JSX.Element {
  const [tab, setTab] = useState<'agents' | 'repo'>('agents')

  const tabs: { key: 'agents' | 'repo'; label: string }[] = [
    { key: 'agents', label: '智能体体检' },
    { key: 'repo', label: '仓库审查' }
  ]

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {tabs.map((t) => (
          <button
            key={t.key}
            className="btn"
            onClick={() => setTab(t.key)}
            style={
              tab === t.key
                ? {
                    background: 'color-mix(in srgb, var(--accent) 16%, transparent)',
                    color: 'var(--accent)',
                    borderColor: 'var(--accent)'
                  }
                : undefined
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'agents' ? <AgentAudit /> : <RepoAudit />}
    </div>
  )
}
