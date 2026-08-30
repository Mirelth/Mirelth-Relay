import { useEffect, useMemo, useState } from 'react'
import type { TokenDimension, TokenSeries, TokenStatsResult } from '@shared/types'
import Chart, { CHART_COLORS } from '../components/Chart'
import { useChartPalette } from '../components/Theme'
import { useRefresh } from '../components/Layout'
import { formatTokens } from '../lib/format'

const DIMENSIONS: { key: TokenDimension; label: string }[] = [
  { key: 'day', label: '按天' },
  { key: 'agent', label: '按智能体' },
  { key: 'model', label: '按模型' }
]

const RANGES = [
  { label: '最近 7 天', ms: 7 * 86400_000 },
  { label: '最近 30 天', ms: 30 * 86400_000 },
  { label: '最近 90 天', ms: 90 * 86400_000 },
  { label: '全部', ms: 0 }
]

export default function Tokens() {
  const [dimension, setDimension] = useState<TokenDimension>('day')
  const [rangeMs, setRangeMs] = useState(30 * 86400_000)
  const [stats, setStats] = useState<TokenStatsResult | null>(null)
  const [selectedModel, setSelectedModel] = useState('')
  const [loading, setLoading] = useState(true)
  const { refreshTick } = useRefresh()
  const palette = useChartPalette()

  useEffect(() => {
    setLoading(true)
    const query = rangeMs > 0 ? { since: new Date(Date.now() - rangeMs).toISOString() } : undefined
    void window.api
      .tokenStats(dimension, query)
      .then((s) => {
        setStats(s)
        if (selectedModel && !s.models.includes(selectedModel)) setSelectedModel('')
      })
      .finally(() => setLoading(false))
  }, [dimension, rangeMs, refreshTick])

  const lineOption = useMemo(() => {
    const daily = stats?.daily || []
    const x = daily.map((d) => d.key)
    return {
      tooltip: { trigger: 'axis' as const, valueFormatter: (v) => formatTokens(Number(v)) },
      legend: { data: ['输入', '输出', '缓存读', '缓存写'], textStyle: { color: palette.text }, top: 0 },
      grid: { left: 50, right: 16, top: 32, bottom: 28 },
      xAxis: { type: 'category' as const, data: x, axisLabel: { color: palette.text }, axisLine: { lineStyle: { color: palette.axis } } },
      yAxis: {
        type: 'value' as const,
        axisLabel: { color: palette.text, formatter: (v: number) => formatTokens(v) },
        splitLine: { lineStyle: { color: palette.split } }
      },
      series: [
        { name: '输入', type: 'line' as const, smooth: true, data: daily.map((d) => d.inputTokens), symbolSize: 4, color: '#6366f1' },
        { name: '输出', type: 'line' as const, smooth: true, data: daily.map((d) => d.outputTokens), symbolSize: 4, color: '#10b981' },
        { name: '缓存读', type: 'line' as const, smooth: true, data: daily.map((d) => d.cacheReadTokens), symbolSize: 4, color: '#f59e0b' },
        { name: '缓存写', type: 'line' as const, smooth: true, data: daily.map((d) => d.cacheWriteTokens), symbolSize: 4, color: '#ef4444' }
      ]
    }
  }, [stats, palette])

  const barOption = useMemo(() => {
    const series = stats?.series || []
    return {
      tooltip: { trigger: 'axis' as const, axisPointer: { type: 'shadow' as const }, valueFormatter: (v) => formatTokens(Number(v)) },
      grid: { left: 50, right: 16, top: 32, bottom: dimension === 'model' ? 70 : 40 },
      xAxis: {
        type: 'category' as const,
        data: series.map((s) => s.key),
        axisLabel: { color: palette.text, rotate: dimension === 'model' ? 30 : 0, formatter: (v: string) => (v.length > 18 ? v.slice(0, 18) + '…' : v) },
        axisLine: { lineStyle: { color: palette.axis } }
      },
      yAxis: {
        type: 'value' as const,
        axisLabel: { color: palette.text, formatter: (v: number) => formatTokens(v) },
        splitLine: { lineStyle: { color: palette.split } }
      },
      series: [
        { name: '输入', type: 'bar' as const, stack: 'tokens', data: series.map((s) => s.inputTokens), color: '#6366f1' },
        { name: '输出', type: 'bar' as const, stack: 'tokens', data: series.map((s) => s.outputTokens), color: '#10b981' },
        { name: '缓存读', type: 'bar' as const, stack: 'tokens', data: series.map((s) => s.cacheReadTokens), color: '#f59e0b' },
        { name: '缓存写', type: 'bar' as const, stack: 'tokens', data: series.map((s) => s.cacheWriteTokens), color: '#ef4444' }
      ]
    }
  }, [stats, dimension, palette])

  // 模型占比用 model 维度数据（单独请求一次）
  const [modelShare, setModelShare] = useState<TokenSeries[]>([])
  useEffect(() => {
    const query = rangeMs > 0 ? { since: new Date(Date.now() - rangeMs).toISOString() } : undefined
    void window.api.tokenStats('model', query).then((s) => setModelShare(s.series))
  }, [rangeMs, refreshTick])

  const pieData = useMemo(
    () =>
      modelShare.slice(0, 10).map((m, i) => ({
        name: m.key,
        value: m.totalTokens,
        itemStyle: { color: CHART_COLORS[i % CHART_COLORS.length] }
      })),
    [modelShare]
  )

  const pieEl = pieData.length ? (
    <Chart
      height={280}
      option={{
        tooltip: { trigger: 'item' as const, valueFormatter: (v: unknown) => formatTokens(Number(v)) },
        legend: { type: 'scroll' as const, orient: 'vertical' as const, right: 0, top: 'middle', textStyle: { color: palette.text }, pageTextStyle: { color: palette.text } },
        series: [
          {
            type: 'pie' as const,
            radius: ['42%', '68%'],
            center: ['38%', '50%'],
            data: pieData,
            label: { show: false },
            emphasis: { label: { show: true, formatter: '{b}\n{d}%', color: palette.label } }
          }
        ]
      }}
    />
  ) : null

  return (
    <div className="space-y-4">
      {/* 控制条 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-lg" style={{ border: '1px solid var(--border)' }}>
          {DIMENSIONS.map((d) => (
            <button
              key={d.key}
              className="px-3 py-1.5 text-sm"
              style={{
                background: dimension === d.key ? 'var(--accent)' : 'var(--panel-2)',
                color: dimension === d.key ? 'white' : 'var(--muted)'
              }}
              onClick={() => setDimension(d.key)}
            >
              {d.label}
            </button>
          ))}
        </div>
        <select className="input" value={rangeMs} onChange={(e) => setRangeMs(Number(e.target.value))}>
          {RANGES.map((r) => (
            <option key={r.label} value={r.ms}>{r.label}</option>
          ))}
        </select>
        {stats && (
          <span className="ml-auto text-sm" style={{ color: 'var(--muted)' }}>
            合计 <span className="font-semibold" style={{ color: 'var(--text)' }}>{formatTokens(stats.total.totalTokens)}</span> tokens ·{' '}
            {formatTokens(stats.total.requests)} 次请求{stats.total.costUsd > 0 && ` · $${stats.total.costUsd.toFixed(2)}`}
          </span>
        )}
      </div>

      {/* 汇总卡片 */}
      {stats && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[
            { label: '总 Tokens', value: formatTokens(stats.total.totalTokens), color: '#6366f1' },
            { label: '输入', value: formatTokens(stats.total.inputTokens), color: '#818cf8' },
            { label: '输出', value: formatTokens(stats.total.outputTokens), color: '#10b981' },
            { label: '缓存命中', value: formatTokens(stats.total.cacheReadTokens), color: '#f59e0b' }
          ].map((c) => (
            <div key={c.label} className="card p-4">
              <div className="text-xs" style={{ color: 'var(--muted)' }}>{c.label}</div>
              <div className="mt-1 text-xl font-semibold" style={{ color: c.color }}>{c.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* 图表区 */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="card p-4">
          <h3 className="mb-2 text-sm font-medium">每日消耗趋势</h3>
          <Chart option={lineOption} height={280} />
        </div>
        <div className="card p-4">
          <h3 className="mb-2 text-sm font-medium">
            {{ day: '按天', agent: '按智能体', model: '按模型' }[dimension]}堆叠对比
          </h3>
          <Chart option={barOption} height={280} />
        </div>
        <div className="card p-4">
          <h3 className="mb-2 text-sm font-medium">模型消耗占比</h3>
          {pieEl || <div className="py-20 text-center text-sm" style={{ color: 'var(--muted)' }}>暂无数据</div>}
        </div>
        <div className="card p-4">
          <h3 className="mb-2 text-sm font-medium">模型消耗明细</h3>
          <select className="input mb-3 w-full" value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)}>
            <option value="">选择模型查看明细…</option>
            {(stats?.models || []).map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          {selectedModel ? <ModelDetail model={selectedModel} rangeMs={rangeMs} /> : (
            <div className="py-14 text-center text-sm" style={{ color: 'var(--muted)' }}>请选择一个模型</div>
          )}
        </div>
      </div>

      {loading && <div className="text-center text-sm" style={{ color: 'var(--muted)' }}>加载中…</div>}
    </div>
  )
}

function ModelDetail({ model, rangeMs }: { model: string; rangeMs: number }) {
  const [records, setRecords] = useState<{ ts: string; agentId: string; inputTokens: number; outputTokens: number; totalTokens: number; requests: number }[]>([])

  useEffect(() => {
    const query = { model, since: rangeMs > 0 ? new Date(Date.now() - rangeMs).toISOString() : undefined }
    void window.api.tokenRecords(query).then((rs) => {
      setRecords(
        rs.map((r) => ({
          ts: r.ts,
          agentId: r.agentId,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          totalTokens: r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens + r.reasoningTokens,
          requests: r.requests
        }))
      )
    })
  }, [model, rangeMs])

  if (records.length === 0) {
    return <div className="py-14 text-center text-sm" style={{ color: 'var(--muted)' }}>该模型在此时间范围内无记录</div>
  }
  return (
    <div className="max-h-52 overflow-auto">
      <table className="w-full text-xs">
        <thead className="sticky top-0" style={{ background: 'var(--panel)' }}>
          <tr className="text-left" style={{ color: 'var(--muted)' }}>
            <th className="py-2">时间</th>
            <th className="py-2">智能体</th>
            <th className="py-2 text-right">输入</th>
            <th className="py-2 text-right">输出</th>
            <th className="py-2 text-right">合计</th>
          </tr>
        </thead>
        <tbody>
          {records.slice(0, 100).map((r, i) => (
            <tr key={i} className="border-t" style={{ borderColor: 'var(--border)' }}>
              <td className="py-1.5" style={{ color: 'var(--muted)' }}>{new Date(r.ts).toLocaleString('zh-CN', { hour12: false })}</td>
              <td className="py-1.5">{r.agentId}</td>
              <td className="py-1.5 text-right">{formatTokens(r.inputTokens)}</td>
              <td className="py-1.5 text-right">{formatTokens(r.outputTokens)}</td>
              <td className="py-1.5 text-right font-medium">{formatTokens(r.totalTokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
