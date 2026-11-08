import { useEffect, useState } from 'react'
import { call, callRaw, downloadCSV, fmtMoney, fmtNum, fmtTime } from '../relay'
import { Card, Empty, btnStyle, inputStyle, tableStyle, tdStyle, thStyle } from './ui'

export default function Usage() {
  const [dim, setDim] = useState('day')
  const [days, setDays] = useState(14)
  const [stats, setStats] = useState<any[]>([])
  const [rows, setRows] = useState<any[]>([])
  const [rate, setRate] = useState(7.2)

  useEffect(() => {
    let alive = true
    Promise.all([
      call<any[]>('GetStats', dim, days),
      call<any[]>('GetRecords', 100),
      call<any>('GetConfig')
    ]).then(([s, r, c]) => {
      if (!alive) return
      setStats(s || [])
      setRows(r || [])
      setRate(c?.rateUsdCny || 7.2)
    })
    return () => { alive = false }
  }, [dim, days])

  const exportCsv = async (kind: string) => {
    const csv = await callRaw('ExportCSV', kind, dim, days)
    if (csv) downloadCSV(kind === 'aggregate' ? 'relay-aggregate.csv' : 'relay-records.csv', csv)
  }

  return (
    <div>
      <Card title="聚合统计" extra="仅统计经网关出口的调用">
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginBottom: 12 }}>
          <select value={dim} onChange={(e) => setDim(e.target.value)} style={{ ...inputStyle, width: 'auto' }}>
            <option value="day">按天</option>
            <option value="model">按模型</option>
            <option value="source">按来源</option>
          </select>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ ...inputStyle, width: 'auto' }}>
            <option value={7}>近 7 天</option><option value={14}>近 14 天</option>
            <option value={30}>近 30 天</option><option value={90}>近 90 天</option>
          </select>
          <button style={btnStyle} onClick={() => exportCsv('aggregate')}>导出聚合 CSV</button>
        </div>
        {stats.length ? (
          <table style={tableStyle}>
            <thead><tr>
              <th style={thStyle}>{dim === 'day' ? '日期' : dim === 'model' ? '模型' : '来源'}</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Token</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>请求</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>估算成本</th>
            </tr></thead>
            <tbody>{stats.map((s) => (
              <tr key={s.key}>
                <td style={tdStyle}>{s.key || '未知'}</td>
                <td style={{ ...tdStyle, textAlign: 'right' }}>{fmtNum(s.tokens)}</td>
                <td style={{ ...tdStyle, textAlign: 'right' }}>{fmtNum(s.requests)}</td>
                <td style={{ ...tdStyle, textAlign: 'right' }}>{fmtMoney(s.costCny)}</td>
              </tr>
            ))}</tbody>
          </table>
        ) : <Empty>所选范围内暂无数据</Empty>}
      </Card>

      <Card title="最近请求" extra="最新 100 条 · 真实 usage 优先，缺失时标记估算">
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
          <button style={btnStyle} onClick={() => exportCsv('records')}>导出明细 CSV</button>
        </div>
        {rows.length ? (
          <div style={{ overflowX: 'auto' }}>
            <table style={tableStyle}>
              <thead><tr>
                <th style={thStyle}>时间</th><th style={thStyle}>模型</th><th style={thStyle}>来源</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>输入</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>输出</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>缓存读</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>合计</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>成本</th>
                <th style={thStyle}>状态</th>
              </tr></thead>
              <tbody>{rows.map((r) => {
                const total = (r.inputTokens || 0) + (r.outputTokens || 0) + (r.cacheRead || 0) +
                  (r.cacheWrite || 0) + (r.reasoning || 0)
                return (
                  <tr key={r.requestId}>
                    <td style={tdStyle}>{fmtTime(r.ts)}</td>
                    <td style={tdStyle}>{r.model || '—'}</td>
                    <td style={tdStyle}>{r.source || 'http'}</td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>{fmtNum(r.inputTokens)}</td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>{fmtNum(r.outputTokens)}</td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>{fmtNum(r.cacheRead)}</td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>{fmtNum(total)}</td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>{fmtMoney((r.costUsd || 0) * rate)}</td>
                    <td style={tdStyle}>
                      <span style={{ color: r.estimated ? 'var(--warn)' : 'var(--ok)', fontSize: 11 }}>
                        {r.estimated ? '估算' : r.status || '—'}
                      </span>
                    </td>
                  </tr>
                )
              })}</tbody>
            </table>
          </div>
        ) : <Empty>还没有经过网关的请求</Empty>}
      </Card>
    </div>
  )
}
