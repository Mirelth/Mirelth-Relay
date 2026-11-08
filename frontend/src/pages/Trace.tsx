import { Fragment, useCallback, useEffect, useState } from 'react'
import { call, fmtNum, fmtTime } from '../relay'
import { Card, Empty, Stat, btnStyle, tableStyle, tdStyle, thStyle } from './ui'

type Attempt = {
  index: number
  account: string
  accountName?: string
  model: string
  status: number
  ms: number
  ttftMs: number
  error?: string
  retryAfterMs?: number
  cooldownMs?: number
  skipped?: boolean
}

type Trace = {
  id: string
  ts: number
  endpoint: string
  agent: string
  model: string
  status: number
  ms: number
  tries: number
  ttftMs: number
  firstByteMs: number
  flowMs: number
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  upBytes: number
  error?: string
  attempts: Attempt[]
}

type Account = {
  id: string
  name: string
  group: string
  models: string[] | null
  enabled: boolean
  weight: number
  maxConcurrent: number
  inflight: number
  coolingForMs: number
  authFailed: boolean
  consecutiveFails: number
  lastServedAt: number
  lastStatus: number
  lastError: string
  okCount: number
  failCount: number
}

function fmtMs(n: number): string {
  const v = Number(n || 0)
  if (v <= 0) return '—'
  if (v < 1000) return `${v}ms`
  return `${(v / 1000).toFixed(2)}s`
}

function statusColor(status: number, error?: string): string {
  if (error && !status) return 'var(--bad)'
  if (status >= 200 && status < 300) return 'var(--ok)'
  return 'var(--bad)'
}

function Badge({ text, color }: { text: string; color: string }): React.JSX.Element {
  return (
    <span
      style={{
        color,
        border: `1px solid ${color}`,
        borderRadius: 6,
        padding: '1px 6px',
        fontSize: 11,
        whiteSpace: 'nowrap'
      }}
    >
      {text}
    </span>
  )
}

function accountState(a: Account): { text: string; color: string } {
  if (!a.enabled) return { text: '已停用', color: 'var(--muted)' }
  if (a.coolingForMs > 0) {
    return { text: `冷却 ${Math.ceil(a.coolingForMs / 1000)}s`, color: '#facc15' }
  }
  if (a.authFailed) return { text: '鉴权失败', color: 'var(--bad)' }
  return { text: '可用', color: 'var(--ok)' }
}

export default function TracePage(): React.JSX.Element {
  const [stats, setStats] = useState<any>(null)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [traces, setTraces] = useState<Trace[]>([])
  const [expanded, setExpanded] = useState<string>('')

  const load = useCallback(async () => {
    const [s, a, t] = await Promise.all([
      call('GetTraceStats', 60),
      call('GetGatewayAccounts'),
      call('GetTraces', 60)
    ])
    setStats(s || {})
    setAccounts(Array.isArray(a) ? a : [])
    setTraces(Array.isArray(t) ? t : [])
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 5000)
    return () => clearInterval(timer)
  }, [load])

  const requests = Number(stats?.requests || 0)
  const failures = Number(stats?.failures || 0)
  const retried = Number(stats?.retried || 0)
  const rate = (n: number): string => (requests ? `${((n / requests) * 100).toFixed(1)}%` : '—')

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 14, marginBottom: 16 }}>
        <Stat label="近 1 小时请求" value={fmtNum(requests)} hint="来自网关自身埋点" />
        <Stat label="失败率" value={rate(failures)} hint={`${fmtNum(failures)} 次失败`} />
        <Stat label="重试率" value={rate(retried)} hint={`${fmtNum(retried)} 次换过账号`} />
        <Stat label="平均首字延迟" value={fmtMs(stats?.avgTtftMs || 0)} hint={`平均总耗时 ${fmtMs(stats?.avgMs || 0)}`} />
      </div>

      <Card title="账号面板" extra="冷却状态实时更新 · 成败数取自近 1 小时">
        {accounts.length === 0 ? (
          <Empty>尚未配置上游账号，先在「网关」页添加上游</Empty>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>账号</th>
                <th style={thStyle}>状态</th>
                <th style={thStyle}>近 1 小时</th>
                <th style={thStyle}>并发</th>
                <th style={thStyle}>最近服务</th>
                <th style={thStyle}>最近错误</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => {
                const state = accountState(a)
                return (
                  <tr key={a.id}>
                    <td style={tdStyle}>
                      <div style={{ fontWeight: 600 }}>{a.name || a.id}</div>
                      <div style={{ color: 'var(--muted)', fontSize: 11 }}>
                        {(a.models || []).join(' / ') || '通配模型'}
                        {a.group ? ` · ${a.group}` : ''} · 权重 {a.weight}
                      </div>
                    </td>
                    <td style={tdStyle}>
                      <Badge text={state.text} color={state.color} />
                    </td>
                    <td style={tdStyle}>
                      <span style={{ color: 'var(--ok)' }}>{fmtNum(a.okCount)}</span>
                      {' / '}
                      <span style={{ color: a.failCount ? 'var(--bad)' : 'var(--muted)' }}>{fmtNum(a.failCount)}</span>
                    </td>
                    <td style={tdStyle}>
                      {a.maxConcurrent > 0 ? `${a.inflight}/${a.maxConcurrent}` : fmtNum(a.inflight)}
                    </td>
                    <td style={tdStyle}>{a.lastServedAt ? fmtTime(a.lastServedAt) : '—'}</td>
                    <td
                      style={{
                        ...tdStyle,
                        color: 'var(--muted)',
                        maxWidth: 320,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis'
                      }}
                      title={a.lastError}
                    >
                      {a.lastError || '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="请求轨迹" extra="点击一行查看逐次尝试">
        {traces.length === 0 ? (
          <Empty>暂无请求</Empty>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>时间</th>
                <th style={thStyle}>调用方</th>
                <th style={thStyle}>模型</th>
                <th style={thStyle}>状态</th>
                <th style={thStyle}>总耗时</th>
                <th style={thStyle}>TTFT</th>
                <th style={thStyle}>尝试</th>
                <th style={thStyle}>Token</th>
              </tr>
            </thead>
            <tbody>
              {traces.map((t) => {
                const open = expanded === t.id
                const color = statusColor(t.status, t.error)
                const tokens = t.inputTokens + t.outputTokens + t.cacheRead + t.cacheWrite + t.reasoning
                return (
                  <Fragment key={t.id}>
                    <tr
                      onClick={() => setExpanded(open ? '' : t.id)}
                      style={{ cursor: 'pointer', background: open ? 'var(--panel-2)' : undefined }}
                    >
                      <td style={tdStyle}>{fmtTime(t.ts)}</td>
                      <td style={tdStyle}>{t.agent || '—'}</td>
                      <td style={tdStyle}>{t.model || '—'}</td>
                      <td style={tdStyle}>
                        <Badge text={t.status ? String(t.status) : '失败'} color={color} />
                      </td>
                      <td style={tdStyle}>{fmtMs(t.ms)}</td>
                      <td style={tdStyle}>{fmtMs(t.ttftMs)}</td>
                      <td style={tdStyle}>
                        {t.tries}
                        {t.tries > 1 && <span style={{ color: '#facc15' }}> · 重试</span>}
                      </td>
                      <td style={tdStyle}>{fmtNum(tokens)}</td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={8} style={{ ...tdStyle, whiteSpace: 'normal', background: 'var(--panel-2)' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            <div style={{ color: 'var(--muted)', fontSize: 11.5 }}>
                              {t.endpoint} · 首字节 {fmtMs(t.firstByteMs)} · 流式时长 {fmtMs(t.flowMs)} ·
                              上游 {fmtNum(t.upBytes)} 字节
                              {t.error ? ` · ${t.error}` : ''}
                            </div>
                            {(t.attempts || []).map((a) => (
                              <div
                                key={`${t.id}-${a.index}`}
                                style={{
                                  display: 'grid',
                                  gridTemplateColumns: '40px 1.2fr 90px 90px 90px 2fr',
                                  gap: 10,
                                  alignItems: 'center',
                                  fontSize: 11.5
                                }}
                              >
                                <span style={{ color: 'var(--muted)' }}>#{a.index}</span>
                                <span>{a.accountName || a.account || '—'}</span>
                                <span>
                                  {a.skipped ? (
                                    <Badge text="跳过" color="var(--muted)" />
                                  ) : (
                                    <Badge
                                      text={a.status ? String(a.status) : '失败'}
                                      color={statusColor(a.status, a.error)}
                                    />
                                  )}
                                </span>
                                <span>{fmtMs(a.ms)}</span>
                                <span>{fmtMs(a.ttftMs)}</span>
                                <span style={{ color: 'var(--muted)' }}>
                                  {a.error || ''}
                                  {a.cooldownMs > 0 ? ` · 冷却 ${Math.ceil(a.cooldownMs / 1000)}s` : ''}
                                  {a.retryAfterMs > 0 ? ` · Retry-After ${Math.ceil(a.retryAfterMs / 1000)}s` : ''}
                                </span>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
          <button style={btnStyle} onClick={() => void load()}>
            刷新
          </button>
        </div>
      </Card>
    </div>
  )
}
