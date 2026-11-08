import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
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
  X,
  FolderGit,
  Scale,
  ListTodo, Waypoints, Radar } from 'lucide-react'
import type { UpdateInfo } from '@shared/types'
import { relativeTime } from '@app/lib/format'
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

const AUTO_INTERVALS: { key: string; ms: number }[] = [
  { key: 'common.autoOff', ms: 0 },
  { key: 'common.auto30s', ms: 30_000 },
  { key: 'common.auto1m', ms: 60_000 },
  { key: 'common.auto5m', ms: 300_000 }
]

const NAV = [
  { to: '/', key: 'nav.dashboard', icon: Activity },
  { to: '/agents', key: 'nav.agents', icon: Bot },
  { to: '/skills', key: 'nav.skills', icon: Puzzle },
  { to: '/mcp', key: 'nav.mcp', icon: Wrench },
  { to: '/git', key: 'nav.git', icon: GitCommitHorizontal },
  { to: '/tokens', key: 'nav.tokens', icon: Layers },
  { to: '/models', key: 'nav.models', icon: Cpu },
  { to: '/gateway', key: 'nav.gateway', icon: Waypoints },
  { to: '/trace', key: 'nav.trace', icon: Radar },
  { to: '/hooks', key: 'nav.hooks', icon: Webhook },
  { to: '/security', key: 'nav.security', icon: ShieldCheck },
  { to: '/team-repo', key: 'nav.teamRepo', icon: FolderGit },
  { to: '/rules', key: 'nav.rules', icon: Scale },
  { to: '/tasks', key: 'nav.tasks', icon: ListTodo }
]

const RELEASES_PAGE = 'https://cnb.cool/WeiGuangXunTu/AgentTower/-/releases'

export default function Layout() {
  const { t } = useTranslation()
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
                <div className="text-sm font-semibold">{t('brand.name')}</div>
                <div className="text-xs" style={{ color: 'var(--muted)' }}>
                  {t('brand.tagline')}
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
                    {t(item.key)}
                  </button>
                )
              })}
            </nav>
            <div className="px-4 py-3 text-xs" style={{ color: 'var(--muted)' }}>
              {t('common.lastScan', { time: relativeTime(lastScanAt) })}
            </div>
          </aside>

          {/* 主区域 */}
          <div className="flex min-w-0 flex-1 flex-col">
            <header
              className="flex h-14 shrink-0 items-center justify-between border-b px-6"
              style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}
            >
              <h1 className="text-base font-semibold">{current ? t(current.key) : t('nav.dashboard')}</h1>
              <div className="flex items-center gap-2">
                <button
                  className="btn"
                  onClick={() => void runCheckUpdate(true)}
                  title={t('common.checkUpdate')}
                  style={
                    update?.hasUpdate
                      ? { borderColor: 'var(--accent)', color: 'var(--accent)', fontWeight: 600 }
                      : undefined
                  }
                >
                  {update?.hasUpdate
                    ? t('common.updateAvailable', { version: update.latest })
                    : checking
                      ? t('common.checking')
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
                    <option key={it.key} value={i}>
                      {t('common.autoRefresh', { label: t(it.key) })}
                    </option>
                  ))}
                </select>
                <button
                  className="btn btn-primary"
                  onClick={() => void doRefresh()}
                  disabled={refreshing}
                >
                  <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
                  {refreshing ? t('common.scanning') : t('common.refreshNow')}
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
  const { t, i18n } = useTranslation()
  const openExternal = (url?: string): void => {
    if (url) void window.api.openExternal(url)
  }
  const downloads: { key: string; url?: string }[] = [
    { key: 'update.downloads.macArm', url: info?.downloads?.macArm },
    { key: 'update.downloads.macIntel', url: info?.downloads?.macIntel },
    { key: 'update.downloads.win', url: info?.downloads?.win }
  ]
  const dateLocale = i18n.language === 'zh-CN' ? 'zh-CN' : 'en-US'
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      onClick={onClose}
    >
      <div className="card w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">{t('update.modalTitle')}</h2>
          <button className="btn px-2 py-1" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        {checking && (
          <div className="py-6 text-center text-sm" style={{ color: 'var(--muted)' }}>
            {t('update.checkingLong')}
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
              {t('update.fetchError', { current: info.current })}
            </div>
          </div>
        )}

        {!checking && !info?.error && info && !info.updateAvailable && (
          <div className="space-y-1 text-sm">
            <div style={{ color: 'var(--ok)' }}>{t('update.upToDate')}</div>
            <div style={{ color: 'var(--muted)' }}>
              {t('update.upToDateDetail', {
                current: info.current,
                time: new Date(info.checkedAt).toLocaleString(dateLocale, { hour12: false })
              })}
            </div>
          </div>
        )}

        {!checking && !info?.error && info?.updateAvailable && (
          <div className="space-y-3 text-sm">
            <div>
              <span className="font-semibold" style={{ color: 'var(--accent)' }}>
                {t('update.newVersionFound', { latest: info.latest })}
              </span>
              <span style={{ color: 'var(--muted)' }}>
                {t('update.currentWithDate', {
                  current: info.current,
                  date: info.publishedAt
                    ? t('update.currentDateSep') + info.publishedAt
                    : ''
                })}
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
                    key={d.key}
                    className="btn w-full justify-center"
                    onClick={() => openExternal(d.url)}
                  >
                    <Download size={13} /> {t('update.downloadLabel', { platform: t(d.key) })}
                  </button>
                ))}
              {!info.hasUpdate && (
                <div className="text-xs" style={{ color: 'var(--muted)' }}>
                  {t('update.ignoredHint')}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="mt-4 flex items-center justify-between">
          <button className="btn" onClick={() => openExternal(RELEASES_PAGE)}>
            <ExternalLink size={13} /> {t('update.releasesPage')}
          </button>
          <div className="flex gap-2">
            {info?.updateAvailable && info.hasUpdate && (
              <button className="btn" onClick={onIgnore}>
                {t('update.ignoreThis')}
              </button>
            )}
            {info?.updateAvailable && !info.hasUpdate && (
              <button
                className="btn"
                onClick={() => {
                  void window.api.settingSet('updateIgnoredVersion', '').then(onRecheck)
                }}
              >
                {t('update.unignore')}
              </button>
            )}
            <button className="btn btn-primary" onClick={onRecheck} disabled={checking}>
              {checking ? t('common.checking') : t('update.recheck')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function ThemeToggle(): React.JSX.Element {
  const { theme, toggle } = useTheme()
  const { t } = useTranslation()
  return (
    <button
      className="btn"
      onClick={toggle}
      title={theme === 'dark' ? t('theme.toLight') : t('theme.toDark')}
    >
      {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
      {theme === 'dark' ? t('theme.light') : t('theme.dark')}
    </button>
  )
}
