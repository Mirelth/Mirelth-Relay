import { useEffect, useState } from 'react'
import { call, fmtNum, fmtMoney } from '../relay'
import { Card, Stat, Empty } from './ui'

function Trend({ series }: { series: any[] }) {
  if (!series.length) return <Empty>暂无网关用量数据</Empty>
  const w = 640
  const h = 190
  const padT = 14
  const padB = 24
  const max = Math.max(...series.map((s) => s.tokens || 0), 1)
  const pts = series.map((s, i) => ({
    x: 8 + (i * (w - 16)) / Math.max(series.length - 1, 1),
    y: padT + (h - padT - padB) * (1 - (s.tokens || 0) / max),
    s
  }))
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  const area = `${line} L${pts[pts.length - 1].x.toFixed(1)},${h - padB} L${pts[0].x.toFixed(1)},${h - padB} Z`
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height: 200 }}>
      <defs>
        <linearGradient id="relayGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity=".3" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0, 0.5, 1].map((r) => (
        <line key={r} x1="8" y1={padT + (h - padT - padB) * r} x2={w - 8}
          y2={padT + (h - padT - padB) * r} stroke="var(--border)" strokeDasharray="3 5" />
      ))}
      <path d={area} fill="url(#relayGrad)" />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" />
      {pts.filter((p) => p.s.tokens > 0).map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r="3" fill="var(--accent)">
          <title>{`${p.s.key}: ${fmtNum(p.s.tokens)} tokens`}</title>
        </circle>
      ))}
      {pts.map((p, i) =>
        i % Math.ceil(series.length / 5) === 0 || i === pts.length - 1 ? (
          <text key={i} x={p.x} y={h - 6} fill="var(--muted)" fontSize="10" textAnchor="middle">
            {String(p.s.key).slice(5)}
          </text>
        ) : null
      )}
    </svg>
  )
}

export default function Overview() {
  const [data, setData] = useState<any>(null)

  useEffect(() => {
    let alive = true
    const load = () => call('GetOverview').then((d) => { if (alive) setData(d || {}) })
    load()
    const timer = setInterval(load, 15000)
    return () => { alive = false; clearInterval(timer) }
  }, [])

  if (!data) return <Empty>加载中…</Empty>
  const models: any[] = data.topModels || []
  const max = Math.max(...models.map((m) => m.tokens || 0), 1)

  return (
    <div>
      {data.startupError && (
        <div style={{ background: 'rgba(248,113,113,.1)', border: '1px solid rgba(248,113,113,.3)',
          color: 'var(--bad)', borderRadius: 9, padding: '9px 13px', marginBottom: 14, fontSize: 12.5 }}>
          {data.startupError}
        </div>
      )}
      {data.configWarning && (
        <div style={{ background: 'rgba(250,204,21,.12)', border: '1px solid rgba(250,204,21,.35)',
          color: '#facc15', borderRadius: 9, padding: '9px 13px', marginBottom: 14, fontSize: 12.5 }}>
          {data.configWarning}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 14, marginBottom: 16 }}>
        <Stat label="今日 Token" value={fmtNum(data.todayTokens)} hint="本地时间 00:00 起" />
        <Stat label="近 7 日" value={fmtNum(data.weekTokens)} hint="含缓存与推理 token" />
        <Stat label="累计请求" value={fmtNum(data.totalRequests)} hint={`${data.modelCount || 0} 个模型`} />
        <Stat label="估算成本" value={fmtMoney(data.estCostCny)} hint="按内置参考单价 · CNY" />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1.35fr 1fr', gap: 14 }}>
        <Card title="14 天消耗趋势" extra={`累计 ${fmtNum(data.totalTokens)} tokens`}>
          <Trend series={data.series || []} />
        </Card>
        <Card title="模型分布" extra="按累计 Token">
          {models.length ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 13, minHeight: 190 }}>
              {models.map((m) => (
                <div key={m.key} style={{ display: 'grid', gridTemplateColumns: '110px 1fr auto', gap: 10, alignItems: 'center', fontSize: 12 }}>
                  <div style={{ color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.key || '未知'}</div>
                  <div style={{ height: 7, background: 'var(--panel-2)', borderRadius: 6, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${((m.tokens || 0) / max * 100).toFixed(1)}%`, background: 'var(--accent)', borderRadius: 6 }} />
                  </div>
                  <div>{fmtNum(m.tokens)}</div>
                </div>
              ))}
            </div>
          ) : <Empty>暂无模型数据</Empty>}
        </Card>
      </div>
    </div>
  )
}
