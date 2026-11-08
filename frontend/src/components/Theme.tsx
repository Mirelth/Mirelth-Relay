import { createContext, useContext, useEffect, useMemo, useState } from 'react'

export type Theme = 'dark' | 'light'

const STORAGE_KEY = 'agentmgr-theme'

interface ThemeContextValue {
  theme: Theme
  toggle: () => void
}
const ThemeContext = createContext<ThemeContextValue>({ theme: 'dark', toggle: () => {} })

export const useTheme = (): ThemeContextValue => useContext(ThemeContext)

export function ThemeProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    return saved === 'light' || saved === 'dark' ? saved : 'dark'
  })

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem(STORAGE_KEY, theme)
  }, [theme])

  const value = useMemo(
    () => ({ theme, toggle: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')) }),
    [theme]
  )
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export interface ChartPalette {
  /** 轴标签 / 图例文字 */
  text: string
  /** 分隔线 */
  split: string
  /** 轴线 */
  axis: string
  /** 高亮标签文字 */
  label: string
  /** 空态文字 */
  muted: string
  series: string[]
}

const DARK_PALETTE: ChartPalette = {
  text: '#9ca3af',
  split: '#2a2f4266',
  axis: '#2a2f42',
  label: '#e5e7eb',
  muted: '#9ca3af',
  series: ['#6366f1', '#10b981', '#f59e0b', '#ef4444']
}

const LIGHT_PALETTE: ChartPalette = {
  text: '#6b7280',
  split: '#e5e7eb99',
  axis: '#d1d5db',
  label: '#111827',
  muted: '#6b7280',
  series: ['#6366f1', '#059669', '#d97706', '#dc2626']
}

/** 图表调色板（canvas 内无法使用 CSS 变量，随主题在 JS 侧切换） */
export function useChartPalette(): ChartPalette {
  const { theme } = useTheme()
  return theme === 'light' ? LIGHT_PALETTE : DARK_PALETTE
}
