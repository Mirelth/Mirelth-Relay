import { useEffect, useMemo, useState } from 'react'
import { BadgeDollarSign, Download, Plus, Trash2, X } from 'lucide-react'
import type {
  ModelPrice,
  PriceConfig,
  TokenDimension,
  TokenSeries,
  TokenStatsResult
} from '@shared/types'
import { toCsv } from '@shared/csv'
import Chart, { CHART_COLORS } from '../components/Chart'
import { useChartPalette } from '../components/Theme'
import { useRefresh } from '../components/Layout'
import { formatTokens, formatMoneyCny } from '../lib/format'

const DIMENSIONS: { key: TokenDimension; label: string }[] = [
  { key: 'day', label: '按天' },
  { key: 'agent', label: '按智能体' },
  { key: 'model', label: '按模型' }
]

const RANGES = [
  { label: '当天', ms: 1 * 86400_000 },
  { label: '最近 3 天', ms: 3 * 86400_000 },
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
  const [pricingTick, setPricingTick] = useState(0)
  const [pricingOpen, setPricingOpen] = useState(false)
  const [exportMsg, setExportMsg] = useState('')
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
  }, [dimension, rangeMs, refreshTick, pricingTick])

  const lineOption = useMemo(() => {
    const daily = stats?.daily || []
    const x = daily.map((d) => d.key)
    return {
      tooltip: { trigger: 'axis' as const, valueFormatter: (v) => formatTokens(Number(v)) },
      legend: {
        data: ['输入', '输出', '缓存读', '缓存写'],
        textStyle: { color: palette.text },
        top: 0
      },
      grid: { left: 50, right: 16, top: 32, bottom: 28 },
      xAxis: {
        type: 'category' as const,
        data: x,
        axisLabel: { color: palette.text },
        axisLine: { lineStyle: { color: palette.axis } }
      },
      yAxis: {
        type: 'value' as const,
        axisLabel: { color: palette.text, formatter: (v: number) => formatTokens(v) },
        splitLine: { lineStyle: { color: palette.split } }
      },
      series: [
        {
          name: '输入',
          type: 'line' as const,
          smooth: true,
          data: daily.map((d) => d.inputTokens),
          symbolSize: 4,
          color: '#6366f1'
        },
        {
          name: '输出',
          type: 'line' as const,
          smooth: true,
          data: daily.map((d) => d.outputTokens),
          symbolSize: 4,
          color: '#10b981'
        },
        {
          name: '缓存读',
          type: 'line' as const,
          smooth: true,
          data: daily.map((d) => d.cacheReadTokens),
          symbolSize: 4,
          color: '#f59e0b'
        },
        {
          name: '缓存写',
          type: 'line' as const,
          smooth: true,
          data: daily.map((d) => d.cacheWriteTokens),
          symbolSize: 4,
          color: '#ef4444'
        }
      ]
    }
  }, [stats, palette])

  const barOption = useMemo(() => {
    const series = stats?.series || []
    return {
      tooltip: {
        trigger: 'axis' as const,
        axisPointer: { type: 'shadow' as const },
        valueFormatter: (v) => formatTokens(Number(v))
      },
      grid: { left: 50, right: 16, top: 32, bottom: dimension === 'model' ? 70 : 40 },
      xAxis: {
        type: 'category' as const,
        data: series.map((s) => s.key),
        axisLabel: {
          color: palette.text,
          rotate: dimension === 'model' ? 30 : 0,
          formatter: (v: string) => (v.length > 18 ? v.slice(0, 18) + '…' : v)
        },
        axisLine: { lineStyle: { color: palette.axis } }
      },
      yAxis: {
        type: 'value' as const,
        axisLabel: { color: palette.text, formatter: (v: number) => formatTokens(v) },
        splitLine: { lineStyle: { color: palette.split } }
      },
      series: [
        {
          name: '输入',
          type: 'bar' as const,
          stack: 'tokens',
          data: series.map((s) => s.inputTokens),
          color: '#6366f1'
        },
        {
          name: '输出',
          type: 'bar' as const,
          stack: 'tokens',
          data: series.map((s) => s.outputTokens),
          color: '#10b981'
        },
        {
          name: '缓存读',
          type: 'bar' as const,
          stack: 'tokens',
          data: series.map((s) => s.cacheReadTokens),
          color: '#f59e0b'
        },
        {
          name: '缓存写',
          type: 'bar' as const,
          stack: 'tokens',
          data: series.map((s) => s.cacheWriteTokens),
          color: '#ef4444'
        }
      ]
    }
  }, [stats, dimension, palette])

  // 模型占比用 model 维度数据（单独请求一次）
  const [modelShare, setModelShare] = useState<TokenSeries[]>([])
  useEffect(() => {
    const query = rangeMs > 0 ? { since: new Date(Date.now() - rangeMs).toISOString() } : undefined
    void window.api.tokenStats('model', query).then((s) => setModelShare(s.series))
  }, [rangeMs, refreshTick, pricingTick])

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
        tooltip: {
          trigger: 'item' as const,
          valueFormatter: (v: unknown) => formatTokens(Number(v))
        },
        legend: {
          type: 'scroll' as const,
          orient: 'vertical' as const,
          right: 0,
          top: 'middle',
          textStyle: { color: palette.text },
          pageTextStyle: { color: palette.text }
        },
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

  const costInfo = stats?.costInfo
  const coverage =
    costInfo && costInfo.totalTokens > 0
      ? Math.round((costInfo.pricedTokens / costInfo.totalTokens) * 100)
      : 0

  const exportCsv = async (): Promise<void> => {
    if (!stats) return
    const dimLabel = DIMENSIONS.find((d) => d.key === dimension)?.label || dimension
    const rangeLabel = RANGES.find((r) => r.ms === rangeMs)?.label || ''
    const rows = stats.series.map((s) => [
      s.key,
      s.inputTokens,
      s.outputTokens,
      s.cacheReadTokens,
      s.cacheWriteTokens,
      s.reasoningTokens,
      s.totalTokens,
      s.requests,
      s.estCostCny.toFixed(4),
      s.costUsd.toFixed(4)
    ])
    const res = await window.api.exportSave({
      defaultName: `agent-tower-tokens-${dimension}-${rangeMs > 0 ? rangeMs / 86400_000 + 'd' : 'all'}.csv`,
      content:
        `维度,${dimLabel},范围,${rangeLabel},生成时间,${new Date().toLocaleString('zh-CN', { hour12: false })}` +
        '\r\n' +
        toCsv(
          [
            '名称',
            '输入',
            '输出',
            '缓存读',
            '缓存写',
            '推理',
            '合计',
            '请求数',
            '估算成本(元)',
            '上报成本(USD)'
          ],
          rows
        ),
      kind: 'csv'
    })
    setExportMsg(
      res.savedPath ? `已导出：${res.savedPath}` : res.error ? `导出失败：${res.error}` : ''
    )
    setTimeout(() => setExportMsg(''), 6000)
  }

  return (
    <div className="space-y-4">
      {/* 控制条 */}
      <div className="flex flex-wrap items-center gap-2">
        <div
          className="flex overflow-hidden rounded-lg"
          style={{ border: '1px solid var(--border)' }}
        >
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
        <select
          className="input"
          value={rangeMs}
          onChange={(e) => setRangeMs(Number(e.target.value))}
        >
          {RANGES.map((r) => (
            <option key={r.label} value={r.ms}>
              {r.label}
            </option>
          ))}
        </select>
        <button className="btn" onClick={() => setPricingOpen(true)} title="编辑模型单价">
          <BadgeDollarSign size={14} /> 模型单价
        </button>
        <button className="btn" onClick={() => void exportCsv()} disabled={!stats}>
          <Download size={14} /> 导出 CSV
        </button>
        {exportMsg && (
          <span
            className="truncate text-xs"
            style={{ color: 'var(--muted)', maxWidth: 300 }}
            title={exportMsg}
          >
            {exportMsg}
          </span>
        )}
        {stats && (
          <span className="ml-auto text-sm" style={{ color: 'var(--muted)' }}>
            合计{' '}
            <span className="font-semibold" style={{ color: 'var(--text)' }}>
              {formatTokens(stats.total.totalTokens)}
            </span>{' '}
            tokens · {formatTokens(stats.total.requests)} 次请求
            {costInfo && costInfo.totalTokens > 0 && (
              <>
                {' '}
                · 估算成本{' '}
                <span className="font-semibold" style={{ color: 'var(--text)' }}>
                  {formatMoneyCny(costInfo.totalCostCny)}
                </span>
                {coverage < 100 && (
                  <span title={costInfo.unpricedModels.join('、')}>（覆盖 {coverage}%）</span>
                )}
              </>
            )}
          </span>
        )}
      </div>

      {/* 汇总卡片 */}
      {stats && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {[
            { label: '总 Tokens', value: formatTokens(stats.total.totalTokens), color: '#6366f1' },
            { label: '输入', value: formatTokens(stats.total.inputTokens), color: '#818cf8' },
            { label: '输出', value: formatTokens(stats.total.outputTokens), color: '#10b981' },
            {
              label: '缓存命中',
              value: formatTokens(stats.total.cacheReadTokens),
              color: '#f59e0b'
            },
            {
              label: '估算成本',
              value: formatMoneyCny(costInfo?.totalCostCny || 0),
              color: '#ec4899',
              sub:
                costInfo && costInfo.totalTokens > 0
                  ? coverage === 100
                    ? '全部模型已定价'
                    : `覆盖 ${coverage}% · ${costInfo.unpricedModels.length} 个模型未定价`
                  : '暂无用量'
            }
          ].map((c) => (
            <div key={c.label} className="card p-4">
              <div className="text-xs" style={{ color: 'var(--muted)' }}>
                {c.label}
              </div>
              <div className="mt-1 text-xl font-semibold" style={{ color: c.color }}>
                {c.value}
              </div>
              {'sub' in c && c.sub && (
                <div className="mt-0.5 truncate text-[11px]" style={{ color: 'var(--muted)' }}>
                  {c.sub}
                </div>
              )}
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
          {stats && stats.series.some((s) => s.estCostCny > 0) && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {stats.series
                .filter((s) => s.estCostCny > 0)
                .slice(0, 14)
                .map((s) => (
                  <span key={s.key} className="badge" title={`${s.key} 估算成本`}>
                    <span style={{ color: 'var(--muted)' }}>
                      {s.key.length > 16 ? s.key.slice(0, 16) + '…' : s.key}
                    </span>{' '}
                    <span style={{ color: '#ec4899' }}>{formatMoneyCny(s.estCostCny)}</span>
                  </span>
                ))}
            </div>
          )}
        </div>
        <div className="card p-4">
          <h3 className="mb-2 text-sm font-medium">模型消耗占比</h3>
          {pieEl || (
            <div className="py-20 text-center text-sm" style={{ color: 'var(--muted)' }}>
              暂无数据
            </div>
          )}
        </div>
        <div className="card p-4">
          <h3 className="mb-2 text-sm font-medium">模型消耗明细</h3>
          <select
            className="input mb-3 w-full"
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
          >
            <option value="">选择模型查看明细…</option>
            {(stats?.models || []).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          {selectedModel ? (
            <ModelDetail model={selectedModel} rangeMs={rangeMs} />
          ) : (
            <div className="py-14 text-center text-sm" style={{ color: 'var(--muted)' }}>
              请选择一个模型
            </div>
          )}
        </div>
      </div>

      {loading && (
        <div className="text-center text-sm" style={{ color: 'var(--muted)' }}>
          加载中…
        </div>
      )}

      {pricingOpen && (
        <PricingModal
          onClose={() => setPricingOpen(false)}
          onSaved={() => setPricingTick((t) => t + 1)}
        />
      )}
    </div>
  )
}

function ModelDetail({ model, rangeMs }: { model: string; rangeMs: number }) {
  const [records, setRecords] = useState<
    {
      ts: string
      agentId: string
      inputTokens: number
      outputTokens: number
      totalTokens: number
      requests: number
    }[]
  >([])

  useEffect(() => {
    const query = {
      model,
      since: rangeMs > 0 ? new Date(Date.now() - rangeMs).toISOString() : undefined
    }
    void window.api.tokenRecords(query).then((rs) => {
      setRecords(
        rs.map((r) => ({
          ts: r.ts,
          agentId: r.agentId,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          totalTokens:
            r.inputTokens +
            r.outputTokens +
            r.cacheReadTokens +
            r.cacheWriteTokens +
            r.reasoningTokens,
          requests: r.requests
        }))
      )
    })
  }, [model, rangeMs])

  if (records.length === 0) {
    return (
      <div className="py-14 text-center text-sm" style={{ color: 'var(--muted)' }}>
        该模型在此时间范围内无记录
      </div>
    )
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
              <td className="py-1.5" style={{ color: 'var(--muted)' }}>
                {new Date(r.ts).toLocaleString('zh-CN', { hour12: false })}
              </td>
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

/** 模型单价表编辑弹窗 */
function PricingModal({
  onClose,
  onSaved
}: {
  onClose: () => void
  onSaved: () => void
}): React.JSX.Element {
  const [cfg, setCfg] = useState<PriceConfig | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    void window.api.getPricing().then(setCfg)
  }, [])

  const patchPrice = (idx: number, patch: Partial<ModelPrice>): void => {
    if (!cfg) return
    setCfg({ ...cfg, prices: cfg.prices.map((p, i) => (i === idx ? { ...p, ...patch } : p)) })
  }
  const removePrice = (idx: number): void => {
    if (!cfg) return
    setCfg({ ...cfg, prices: cfg.prices.filter((_, i) => i !== idx) })
  }
  const addPrice = (): void => {
    if (!cfg) return
    setCfg({
      ...cfg,
      prices: [...cfg.prices, { model: '', currency: 'CNY', inputPerM: 0, outputPerM: 0 }]
    })
  }

  const save = async (): Promise<void> => {
    if (!cfg) return
    const keys = cfg.prices.map((p) => p.model.trim().toLowerCase()).filter(Boolean)
    if (new Set(keys).size !== keys.length) {
      setErr('存在重复的匹配键')
      return
    }
    setBusy(true)
    try {
      await window.api.savePricing({ ...cfg, prices: cfg.prices.filter((p) => p.model.trim()) })
      onSaved()
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const resetDefaults = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.api.resetPricing()
      setCfg(await window.api.getPricing())
    } finally {
      setBusy(false)
    }
  }

  const numCell = (
    value: number | undefined,
    onChange: (v: number) => void,
    placeholder = ''
  ): React.JSX.Element => (
    <input
      className="input w-full px-1.5 py-1 text-right font-mono text-xs"
      type="number"
      min={0}
      step="0.1"
      value={value == null || value === 0 ? '' : value}
      placeholder={placeholder || '—'}
      onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
    />
  )

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      onClick={onClose}
    >
      <div
        className="card flex max-h-[85vh] w-full max-w-3xl flex-col p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">模型单价（每百万 Token）</h2>
          <button className="btn px-2 py-1" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <div className="mb-3 text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>
          匹配键用模型 ID 的片段（如 deepseek-chat、glm-4.6），越长越优先；USD
          定价按下方汇率折人民币； 缓存读/写留空按输入价 10% / 125%
          估算。内置价格为厂商公开标价参考，请按你的实际套餐修改。
          智能体上报过真实成本的模型会优先采用上报值。
        </div>
        {!cfg ? (
          <div className="py-10 text-center text-sm" style={{ color: 'var(--muted)' }}>
            加载中…
          </div>
        ) : (
          <div className="min-h-0 flex-1 space-y-2 overflow-auto pr-1">
            <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
              美元→人民币汇率
              <input
                className="input w-24 px-1.5 py-1 text-right font-mono"
                type="number"
                min={0}
                step={0.1}
                value={cfg.rateUsdCny}
                onChange={(e) => setCfg({ ...cfg, rateUsdCny: parseFloat(e.target.value) || 7.2 })}
              />
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr
                  className="border-b text-left"
                  style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
                >
                  <th className="py-2 pr-2">匹配键</th>
                  <th className="py-2 pr-2">币制</th>
                  <th className="py-2 pr-2 text-right">输入</th>
                  <th className="py-2 pr-2 text-right">缓存读</th>
                  <th className="py-2 pr-2 text-right">输出</th>
                  <th className="py-2 pr-2 text-right">缓存写</th>
                  <th className="w-8 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {cfg.prices.map((p, i) => (
                  <tr key={i} className="border-b" style={{ borderColor: 'var(--border)' }}>
                    <td className="py-1 pr-2">
                      <input
                        className="input w-full px-1.5 py-1 font-mono text-xs"
                        value={p.model}
                        placeholder="如 deepseek-chat"
                        onChange={(e) => patchPrice(i, { model: e.target.value })}
                      />
                    </td>
                    <td className="py-1 pr-2">
                      <select
                        className="input w-full px-1 py-1"
                        value={p.currency}
                        onChange={(e) =>
                          patchPrice(i, { currency: e.target.value as ModelPrice['currency'] })
                        }
                      >
                        <option value="CNY">¥</option>
                        <option value="USD">$</option>
                      </select>
                    </td>
                    <td className="py-1 pr-2 w-20">
                      {numCell(p.inputPerM, (v) => patchPrice(i, { inputPerM: v }))}
                    </td>
                    <td className="py-1 pr-2 w-20">
                      {numCell(p.cacheReadPerM, (v) => patchPrice(i, { cacheReadPerM: v }))}
                    </td>
                    <td className="py-1 pr-2 w-20">
                      {numCell(p.outputPerM, (v) => patchPrice(i, { outputPerM: v }))}
                    </td>
                    <td className="py-1 pr-2 w-20">
                      {numCell(p.cacheWritePerM, (v) => patchPrice(i, { cacheWritePerM: v }))}
                    </td>
                    <td className="py-1">
                      <button
                        className="btn px-1.5 py-1"
                        onClick={() => removePrice(i)}
                        title="删除"
                      >
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="btn" onClick={addPrice}>
              <Plus size={13} /> 添加一行
            </button>
          </div>
        )}
        {err && (
          <div className="mt-2 text-xs" style={{ color: 'var(--bad)' }}>
            {err}
          </div>
        )}
        <div className="mt-4 flex items-center justify-between">
          <button className="btn" onClick={() => void resetDefaults()} disabled={busy}>
            恢复内置参考价
          </button>
          <div className="flex gap-2">
            <button className="btn" onClick={onClose}>
              取消
            </button>
            <button className="btn btn-primary" onClick={() => void save()} disabled={busy || !cfg}>
              {busy ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
