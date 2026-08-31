import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  Activity,
  Bot,
  Cpu,
  Download,
  ExternalLink,
  GitCommitHorizontal,
  Layers,
  Moon,
  Puzzle,
  ShieldCheck,
  Webhook,
  RefreshCw,
  Sun,
  Wrench,
  X
} from 'lucide-react'
import type { UpdateInfo } from '@shared/types'
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
  { to: '/hooks', label: 'Hooks', icon: Webhook },
  { to: '/security', label: '安全体检', icon: ShieldCheck }
]

const RELEASES_PAGE = 'https://cnb.cool/WeiGuangXunTu/AgentTower/-/releases'

export default function Layout() {
  const [refreshTick, setRefreshTick] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [lastScanAt, setLastScanAt] = useState<string | undefined>()
  const [autoIdx, setAutoIdx] = useState(0)
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [updateOpen, setUpdateOpen] = useState(false)
  const [checking, setChecking] = useState(false)
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

  const runCheckUpdate = useCallback(async (open: boolean): Promise<void> => {
    setChecking(true)
    if (open) setUpdateOpen(true)
    try {
      setUpdate(await window.api.checkUpdate())
    } finally {
      setChecking(false)
    }
  }, [])

  // 初始加载上次扫描时间 + 静默检查一次更新，监听主进程事件
  useEffect(() => {
    void window.api.lastScan().then((r) => setLastScanAt(r.at))
    void window.api
      .checkUpdate()
      .then(setUpdate)
      .catch(() => undefined)
    const off = window.onScanCompleted(() => {
      void window.api.lastScan().then((r) => setLastScanAt(r.at))
      setRefreshTick((t) => t + 1)
    })
    const offUpd = window.onUpdaterOpen(() => void runCheckUpdate(true))
    return () => {
      off()
      offUpd()
    }
  }, [runCheckUpdate])

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
          <aside
            className="flex w-48 shrink-0 flex-col border-r"
            style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}
          >
            <div className="flex items-center gap-2 px-4 py-5">
              <div
                className="flex h-8 w-8 items-center justify-center rounded-lg text-white"
                style={{ background: 'var(--accent)' }}
              >
                <Bot size={18} />
              </div>
              <div>
                <div className="text-sm font-semibold">AgentTower</div>
                <div className="text-xs" style={{ color: 'var(--muted)' }}>
                  智能体塔台
                </div>
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
                <button
                  className="btn"
                  onClick={() => void runCheckUpdate(true)}
                  title="检查更新"
                  style={
                    update?.hasUpdate
                      ? { borderColor: 'var(--accent)', color: 'var(--accent)', fontWeight: 600 }
                      : undefined
                  }
                >
                  {update?.hasUpdate
                    ? `可更新 v${update.latest}`
                    : checking
                      ? '检查中…'
                      : `v${update?.current || '…'}`}
                  {update?.hasUpdate && (
                    <span
                      className="ml-1 inline-block h-1.5 w-1.5 rounded-full"
                      style={{ background: 'var(--accent)' }}
                    />
                  )}
                </button>
                <ThemeToggle />
                <select
                  className="input"
                  value={autoIdx}
                  onChange={(e) => setAutoIdx(Number(e.target.value))}
                >
                  {AUTO_INTERVALS.map((it, i) => (
                    <option key={it.label} value={i}>
                      自动刷新：{it.label}
                    </option>
                  ))}
                </select>
                <button
                  className="btn btn-primary"
                  onClick={() => void doRefresh()}
                  disabled={refreshing}
                >
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

        {updateOpen && (
          <UpdateModal
            info={update}
            checking={checking}
            onClose={() => setUpdateOpen(false)}
            onRecheck={() => void runCheckUpdate(false)}
            onIgnore={async () => {
              if (update?.latest) {
                await window.api.settingSet('updateIgnoredVersion', update.latest)
                setUpdate({ ...update, hasUpdate: false })
              }
              setUpdateOpen(false)
            }}
          />
        )}
      </RefreshContext.Provider>
    </ThemeProvider>
  )
}

function UpdateModal({
  info,
  checking,
  onClose,
  onRecheck,
  onIgnore
}: {
  info: UpdateInfo | null
  checking: boolean
  onClose: () => void
  onRecheck: () => void
  onIgnore: () => void
}): React.JSX.Element {
  const openExternal = (url?: string): void => {
    if (url) void window.api.openExternal(url)
  }
  const downloads: { label: string; url?: string }[] = [
    { label: 'macOS（Apple Silicon · .dmg）', url: info?.downloads?.macArm },
    { label: 'macOS（Intel · .dmg）', url: info?.downloads?.macIntel },
    { label: 'Windows 10/11（x64 · .exe）', url: info?.downloads?.win }
  ]
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      onClick={onClose}
    >
      <div className="card w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">软件更新</h2>
          <button className="btn px-2 py-1" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        {checking && (
          <div className="py-6 text-center text-sm" style={{ color: 'var(--muted)' }}>
            正在检查更新…
          </div>
        )}

        {!checking && info?.error && (
          <div className="space-y-2 text-sm">
            <div
              className="rounded-lg px-3 py-2.5"
              style={{ background: 'var(--panel-2)', color: 'var(--warn)' }}
            >
              {info.error}
            </div>
            <div style={{ color: 'var(--muted)' }}>
              当前版本 v{info.current}，可前往发行页手动查看新版本。
            </div>
          </div>
        )}

        {!checking && !info?.error && info && !info.updateAvailable && (
          <div className="space-y-1 text-sm">
            <div style={{ color: 'var(--ok)' }}>已是最新版本</div>
            <div style={{ color: 'var(--muted)' }}>
              当前版本 v{info.current}，检查于{' '}
              {new Date(info.checkedAt).toLocaleString('zh-CN', { hour12: false })}
            </div>
          </div>
        )}

        {!checking && !info?.error && info?.updateAvailable && (
          <div className="space-y-3 text-sm">
            <div>
              <span className="font-semibold" style={{ color: 'var(--accent)' }}>
                发现新版本 v{info.latest}
              </span>
              <span style={{ color: 'var(--muted)' }}>
                （当前 v{info.current}
                {info.publishedAt ? ` · ${info.publishedAt}` : ''}）
              </span>
            </div>
            {info.notes && (
              <div
                className="whitespace-pre-wrap rounded-lg px-3 py-2.5 text-xs"
                style={{ background: 'var(--panel-2)', color: 'var(--muted)' }}
              >
                {info.notes}
              </div>
            )}
            <div className="space-y-1.5">
              {downloads
                .filter((d) => d.url)
                .map((d) => (
                  <button
                    key={d.label}
                    className="btn w-full justify-center"
                    onClick={() => openExternal(d.url)}
                  >
                    <Download size={13} /> 下载 {d.label}
                  </button>
                ))}
              {!info.hasUpdate && (
                <div className="text-xs" style={{ color: 'var(--muted)' }}>
                  你已选择忽略该版本，点击「不再忽略」恢复提醒。
                </div>
              )}
            </div>
          </div>
        )}

        <div className="mt-4 flex items-center justify-between">
          <button className="btn" onClick={() => openExternal(RELEASES_PAGE)}>
            <ExternalLink size={13} /> 发行页
          </button>
          <div className="flex gap-2">
            {info?.updateAvailable && info.hasUpdate && (
              <button className="btn" onClick={onIgnore}>
                忽略此版本
              </button>
            )}
            {info?.updateAvailable && !info.hasUpdate && (
              <button
                className="btn"
                onClick={() => {
                  void window.api.settingSet('updateIgnoredVersion', '').then(onRecheck)
                }}
              >
                不再忽略
              </button>
            )}
            <button className="btn btn-primary" onClick={onRecheck} disabled={checking}>
              {checking ? '检查中…' : '重新检查'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function ThemeToggle(): React.JSX.Element {
  const { theme, toggle } = useTheme()
  return (
    <button
      className="btn"
      onClick={toggle}
      title={theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'}
    >
      {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
      {theme === 'dark' ? '亮色' : '暗色'}
    </button>
  )
}
