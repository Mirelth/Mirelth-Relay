import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  Activity,
  Bot,
  Cpu,
  GitCommitHorizontal,
  Layers,
  Moon,
  Puzzle,
  Webhook,
  RefreshCw,
  Sun,
  Wrench
} from 'lucide-react'
import { relativeTime } from '@renderer/lib/format'
import { ThemeProvider, useTheme } from './Theme'

/** 全局刷新上下文：refreshTick 变化时各页面重新拉数据 */
interface RefreshContextValue {
  refreshTick: number
  refreshing: boolean
  triggerRefresh: () => Promise<void>
  lastScanAt?: string
}
export const RefreshContext = createContext<RefreshContextValue>({
  refreshTick: 0,
  refreshing: false,
  triggerRefresh: async () => {}
})
export const useRefresh = (): RefreshContextValue => useContext(RefreshContext)

const AUTO_INTERVALS = [
  { label: '关闭', ms: 0 },
  { label: '30 秒', ms: 30_000 },
  { label: '1 分钟', ms: 60_000 },
  { label: '5 分钟', ms: 300_000 }
]

const NAV = [
  { to: '/', label: '仪表盘', icon: Activity },
  { to: '/agents', label: '智能体', icon: Bot },
  { to: '/skills', label: 'Skills', icon: Puzzle },
  { to: '/mcp', label: 'MCP 服务', icon: Wrench },
  { to: '/git', label: 'Git 提交', icon: GitCommitHorizontal },
  { to: '/tokens', label: 'Token 统计', icon: Layers },
  { to: '/models', label: '模型配置', icon: Cpu },
  { to: '/hooks', label: 'Hooks', icon: Webhook }
]

export default function Layout() {
  const [refreshTick, setRefreshTick] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [lastScanAt, setLastScanAt] = useState<string | undefined>()
  const [autoIdx, setAutoIdx] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const navigate = useNavigate()
  const location = useLocation()

  const doRefresh = useCallback(async (): Promise<void> => {
    setRefreshing(true)
    try {
      await window.api.refresh()
      setLastScanAt((await window.api.lastScan()).at)
      setRefreshTick((t) => t + 1)
    } finally {
      setRefreshing(false)
    }
  }, [])

  // 初始加载上次扫描时间，并监听主进程"扫描完成"事件
  useEffect(() => {
    void window.api.lastScan().then((r) => setLastScanAt(r.at))
    const off = window.onScanCompleted(() => {
      void window.api.lastScan().then((r) => setLastScanAt(r.at))
      setRefreshTick((t) => t + 1)
    })
    return off
  }, [])

  // 自动刷新
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current)
    const ms = AUTO_INTERVALS[autoIdx].ms
    if (ms > 0) {
      timerRef.current = setInterval(() => {
        void doRefresh()
      }, ms)
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [autoIdx, doRefresh])

  const current = NAV.find((n) => n.to === location.pathname)

  return (
    <ThemeProvider>
    <RefreshContext.Provider
      value={{ refreshTick, refreshing, triggerRefresh: doRefresh, lastScanAt }}
    >
      <div className="flex h-full">
        {/* 侧边导航 */}
        <aside className="flex w-48 shrink-0 flex-col border-r" style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}>
          <div className="flex items-center gap-2 px-4 py-5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg text-white" style={{ background: 'var(--accent)' }}>
              <Bot size={18} />
            </div>
            <div>
              <div className="text-sm font-semibold">Agent Manager</div>
              <div className="text-xs" style={{ color: 'var(--muted)' }}>智能体监控台</div>
            </div>
          </div>
          <nav className="flex-1 space-y-1 px-2">
            {NAV.map((item) => {
              const Icon = item.icon
              const active = location.pathname === item.to
              return (
                <button
                  key={item.to}
                  onClick={() => navigate(item.to)}
                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors"
                  style={{
                    background: active ? 'var(--panel-2)' : 'transparent',
                    color: active ? 'var(--text)' : 'var(--muted)'
                  }}
                >
                  <Icon size={16} style={{ color: active ? 'var(--accent)' : 'inherit' }} />
                  {item.label}
                </button>
              )
            })}
          </nav>
          <div className="px-4 py-3 text-xs" style={{ color: 'var(--muted)' }}>
            上次扫描：{relativeTime(lastScanAt)}
          </div>
        </aside>

        {/* 主区域 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header
            className="flex h-14 shrink-0 items-center justify-between border-b px-6"
            style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}
          >
            <h1 className="text-base font-semibold">{current?.label || '仪表盘'}</h1>
            <div className="flex items-center gap-2">
              <ThemeToggle />
              <select className="input" value={autoIdx} onChange={(e) => setAutoIdx(Number(e.target.value))}>
                {AUTO_INTERVALS.map((it, i) => (
                  <option key={it.label} value={i}>
                    自动刷新：{it.label}
                  </option>
                ))}
              </select>
              <button className="btn btn-primary" onClick={() => void doRefresh()} disabled={refreshing}>
                <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
                {refreshing ? '扫描中…' : '立即刷新'}
              </button>
            </div>
          </header>
          <main className="min-h-0 flex-1 overflow-y-auto p-6">
            <Outlet />
          </main>
        </div>
      </div>
    </RefreshContext.Provider>
    </ThemeProvider>
  )
}

function ThemeToggle(): React.JSX.Element {
  const { theme, toggle } = useTheme()
  return (
    <button className="btn" onClick={toggle} title={theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'}>
      {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
      {theme === 'dark' ? '亮色' : '暗色'}
    </button>
  )
}
