import { useEffect, useMemo, useState } from 'react'
import { Bot, GitCommitHorizontal, TrendingDown, TrendingUp, Wrench } from 'lucide-react'
import type { DashboardSummary, TokenStatsResult } from '@shared/types'
import Chart, { CHART_COLORS } from '../components/Chart'
import { useChartPalette } from '../components/Theme'
import { useRefresh } from '../components/Layout'
import { formatTokens, relativeTime } from '../lib/format'

export default function Dashboard() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null)
  const [stats, setStats] = useState<TokenStatsResult | null>(null)
  const { refreshTick } = useRefresh()
  const palette = useChartPalette()

  useEffect(() => {
    void window.api.dashboard().then(setSummary)
    void window.api.tokenStats('day', { since: new Date(Date.now() - 13 * 86400_000).toISOString() }).then(setStats)
  }, [refreshTick])

  const delta = useMemo(() => {
    if (!summary || !summary.yesterdayTokens) return 0
    return ((summary.todayTokens - summary.yesterdayTokens) / summary.yesterdayTokens) * 100
  }, [summary])

  const lineOption = useMemo(
    () => ({
      tooltip: { trigger: 'axis' as const, valueFormatter: (v) => formatTokens(Number(v)) },
      grid: { left: 50, right: 16, top: 16, bottom: 28 },
      xAxis: {
        type: 'category' as const,
        data: (stats?.daily || []).map((d) => d.key.slice(5)),
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
          name: 'Token 消耗',
          type: 'line' as const,
          smooth: true,
          data: (stats?.daily || []).map((d) => d.totalTokens),
          areaStyle: { color: '#6366f122' },
          lineStyle: { color: '#6366f1' },
          itemStyle: { color: '#6366f1' },
          symbolSize: 4
        }
      ]
    }),
    [stats, palette]
  )

  const agentBarOption = useMemo(
    () => ({
      tooltip: { trigger: 'axis' as const, axisPointer: { type: 'shadow' as const }, valueFormatter: (v) => formatTokens(Number(v)) },
      grid: { left: 80, right: 16, top: 8, bottom: 24 },
      xAxis: {
        type: 'value' as const,
        axisLabel: { color: palette.text, formatter: (v: number) => formatTokens(v) },
        splitLine: { lineStyle: { color: palette.split } }
      },
      yAxis: {
        type: 'category' as const,
        data: (summary?.topAgents || []).map((a) => a.name).reverse(),
        axisLabel: { color: palette.text },
        axisLine: { lineStyle: { color: palette.axis } }
      },
      series: [
        {
          type: 'bar' as const,
          data: (summary?.topAgents || []).map((a) => a.totalTokens).reverse(),
          itemStyle: { color: '#6366f1', borderRadius: [0, 4, 4, 0] },
          barMaxWidth: 18
        }
      ]
    }),
    [summary, palette]
  )

  if (!summary) {
    return <div className="py-20 text-center" style={{ color: 'var(--muted)' }}>加载仪表盘数据…</div>
  }

  const cards = [
    {
      label: '检测到智能体',
      value: String(summary.agentCount),
      icon: Bot,
      color: '#6366f1',
      sub: `${summary.skillCount} 个技能`
    },
    {
      label: 'MCP 服务',
      value: `${summary.mcpOnline}/${summary.mcpTotal}`,
      icon: Wrench,
      color: '#10b981',
      sub:
        summary.mcpTotal === 0
          ? '暂无服务'
          : summary.mcpOffline > 0
            ? `${summary.mcpOffline} 个离线`
            : summary.mcpOnline === summary.mcpTotal
              ? '全部在线'
              : `${summary.mcpTotal - summary.mcpOnline} 个未验证`
    },
    {
      label: '今日 Token 消耗',
      value: formatTokens(summary.todayTokens),
      icon: delta >= 0 ? TrendingUp : TrendingDown,
      color: '#f59e0b',
      sub: `较昨日 ${delta >= 0 ? '+' : ''}${delta.toFixed(0)}%`
    },
    {
      label: '近 7 天消耗',
      value: formatTokens(summary.last7dTokens),
      icon: GitCommitHorizontal,
      color: '#ec4899',
      sub: `${summary.repoCount} 个关联仓库`
    }
  ]

  return (
    <div className="space-y-4">
      {/* 总览卡片 */}
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {cards.map((c) => {
          const Icon = c.icon
          return (
            <div key={c.label} className="card flex items-center gap-4 p-5">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl" style={{ background: c.color + '22', color: c.color }}>
                <Icon size={20} />
              </div>
              <div className="min-w-0">
                <div className="truncate text-xs" style={{ color: 'var(--muted)' }}>{c.label}</div>
                <div className="text-2xl font-semibold">{c.value}</div>
                <div className="truncate text-xs" style={{ color: 'var(--muted)' }}>{c.sub}</div>
              </div>
            </div>
          )
        })}
      </div>

      {/* 图表 */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="card p-4">
          <div className="mb-1 flex items-center justify-between">
            <h3 className="text-sm font-medium">Token 消耗趋势（14 天）</h3>
            {summary.lastScanAt && (
              <span className="text-xs" style={{ color: 'var(--muted)' }}>数据更新于 {relativeTime(summary.lastScanAt)}</span>
            )}
          </div>
          <Chart option={lineOption} height={260} />
        </div>
        <div className="card p-4">
          <h3 className="mb-1 text-sm font-medium">智能体消耗排行</h3>
          {summary.topAgents.length ? (
            <Chart option={agentBarOption} height={260} />
          ) : (
            <div className="py-20 text-center text-sm" style={{ color: 'var(--muted)' }}>暂无用量的智能体</div>
          )}
        </div>
      </div>

      {/* 模型占比 */}
      {summary.topModels.length > 0 && (
        <div className="card p-4">
          <h3 className="mb-3 text-sm font-medium">模型分布</h3>
          <div className="flex flex-wrap gap-2">
            {summary.topModels.map((m, i) => (
              <span key={m.model} className="badge" style={{ background: CHART_COLORS[i % CHART_COLORS.length] + '22', color: CHART_COLORS[i % CHART_COLORS.length] }}>
                {m.model} · {formatTokens(m.totalTokens)}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
