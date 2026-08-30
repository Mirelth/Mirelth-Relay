import React, { useEffect, useRef } from 'react'
import * as echarts from 'echarts'
import { useTheme } from './Theme'

let chartsThemeRegistered = false

function registerChartTheme(): void {
  if (chartsThemeRegistered) return
  chartsThemeRegistered = true
  // 通用注册仅为占位，具体配色由各 option 通过 useChartPalette 注入
  echarts.registerTheme('agentmgr', { backgroundColor: 'transparent' })
}

interface ChartProps {
  option: echarts.EChartsOption
  height?: number
  className?: string
  onZrClick?: (params: { componentType: string; seriesType?: string; name: string }) => void
}

export default function Chart({ option, height = 300, className, onZrClick }: ChartProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)
  const clickRef = useRef(onZrClick)
  clickRef.current = onZrClick
  const { theme } = useTheme()

  useEffect(() => {
    if (!ref.current) return
    registerChartTheme()
    const chart = echarts.init(ref.current, 'agentmgr')
    chartRef.current = chart
    const observer = new ResizeObserver(() => chart.resize())
    observer.observe(ref.current)
    chart.on('click', (params) => {
      clickRef.current?.(params as unknown as { componentType: string; seriesType?: string; name: string })
    })
    return () => {
      observer.disconnect()
      chart.dispose()
      chartRef.current = null
    }
  }, [theme])

  useEffect(() => {
    chartRef.current?.setOption(option, true)
  }, [option, theme])

  return <div ref={ref} className={className} style={{ width: '100%', height }} />
}

export const CHART_COLORS = [
  '#6366f1', '#10b981', '#f59e0b', '#ef4444', '#06b6d4',
  '#8b5cf6', '#ec4899', '#f97316', '#22c55e', '#64748b', '#eab308', '#14b8a6'
]
