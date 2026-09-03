import { app, Menu, Notification, Tray, nativeImage } from 'electron'
import type { CacheStore } from './cache'
import type { UpdateInfo } from '@shared/types'
import { logger } from './lib/logger'

/**
 * 托盘常驻 + 事件通知：
 * - 扫描完成后对比基线，MCP 由在线转离线、或发现新安装的智能体时弹系统通知；
 * - 托盘菜单：显示窗口 / 重新扫描 / 检查更新 / 通知开关 / 退出。
 */

export function alertsEnabled(store: CacheStore): boolean {
  return store.metaGet('alertsEnabled') !== '0'
}

let tray: Tray | null = null
let quitting = false
let focusHandler: () => void = () => {}
let refreshHandler: (() => Promise<void>) | null = null
let updateHandler: (() => void) | null = null

export function markQuitting(): void {
  quitting = true
}
export function isQuitting(): boolean {
  return quitting
}

export function setWindowFocusHandler(fn: () => void): void {
  focusHandler = fn
}

interface Baseline {
  /** mcpId -> { status, label } */
  mcp: Record<string, { status: string; label: string }>
  /** agentId -> name（仅 detected） */
  agents: Record<string, string>
}

let prev: Baseline | null = null

function snapshot(store: CacheStore): Baseline {
  const names = new Map(store.listAgents().map((a) => [a.id, a.name]))
  return {
    mcp: Object.fromEntries(
      store
        .listMcp()
        .map((m) => [
          m.id,
          { status: m.status, label: `${names.get(m.agentId) || m.agentId}/${m.name}` }
        ])
    ),
    agents: Object.fromEntries(
      store
        .listAgents()
        .filter((a) => a.detected)
        .map((a) => [a.id, a.name])
    )
  }
}

export function resetBaseline(store: CacheStore): void {
  prev = snapshot(store)
}

function notify(title: string, body: string): void {
  try {
    if (!Notification.isSupported()) return
    const n = new Notification({ title, body: body.length > 200 ? body.slice(0, 200) + '…' : body })
    n.on('click', () => focusHandler())
    n.show()
  } catch (err) {
    logger.warn('alerts', 'notification failed', err)
  }
}

/** 扫描+健康检查完成后调用：与上一基线对比并通知，随后更新基线 */
export function compareAndNotify(store: CacheStore): void {
  const cur = snapshot(store)
  if (prev && alertsEnabled(store)) {
    const offline = Object.entries(cur.mcp).filter(
      ([id, v]) => prev!.mcp[id]?.status === 'online' && v.status === 'offline'
    )
    if (offline.length > 0)
      notify(`${offline.length} 个 MCP 服务已离线`, offline.map(([, v]) => v.label).join('、'))
    const added = Object.entries(cur.agents).filter(([id]) => !prev!.agents[id])
    if (added.length > 0) notify('发现新安装的智能体', added.map(([, n]) => n).join('、'))
  }
  prev = cur
}

export function notifyUpdateAvailable(info: UpdateInfo): void {
  if (info.hasUpdate)
    notify(`AgentTower 新版本 ${info.latest} 可用`, '点击打开应用查看更新内容与下载地址')
}

function buildMenu(store: CacheStore): Menu {
  return Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => focusHandler() },
    {
      label: '重新扫描',
      click: () => {
        void refreshHandler?.()
      }
    },
    {
      label: '检查更新',
      click: () => updateHandler?.()
    },
    { type: 'separator' },
    {
      label: '新事件通知',
      type: 'checkbox',
      checked: alertsEnabled(store),
      click: (mi) => {
        store.setMeta('alertsEnabled', mi.checked ? '1' : '0')
        tray?.setContextMenu(buildMenu(store))
      }
    },
    { type: 'separator' },
    {
      label: '退出 AgentTower',
      click: () => {
        quitting = true
        app.quit()
      }
    }
  ])
}

export function setupTray(opts: {
  iconPath: string
  getStore: () => CacheStore
  onRefresh: () => Promise<void>
  onCheckUpdate: () => void
}): void {
  refreshHandler = opts.onRefresh
  updateHandler = opts.onCheckUpdate
  const image = nativeImage.createFromPath(opts.iconPath)
  const sized = image.isEmpty() ? image : image.resize({ width: 18, height: 18 })
  tray = new Tray(sized)
  tray.setToolTip('AgentTower · 智能体塔台')
  tray.setContextMenu(buildMenu(opts.getStore()))
  tray.on('click', () => focusHandler())
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
