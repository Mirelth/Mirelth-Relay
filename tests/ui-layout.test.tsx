// @vitest-environment happy-dom
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// 先 import i18n 让 react-i18next 拿到实例
import '../src/renderer/src/i18n'
import Layout, { RefreshContext } from '../src/renderer/src/components/Layout'

/**
 * Layout 快照 + 交互回归：
 * - 9 个 nav 项固定（顺序与文案变更会失败）
 * - 头部 chrome 按钮存在（更新 / 主题 / 刷新 / 自动刷新）
 * - 切主题：ThemeToggle 点击后 localStorage 写入新值
 *
 * window.api / onScanCompleted / onUpdaterOpen 全部 mock（preload 注入的运行时对象）。
 */

const noopAsync = async (): Promise<void> => {}
const noop = (): void => {}

beforeEach(() => {
  localStorage.clear()
  ;(window as unknown as { api: unknown }).api = {
    refresh: vi.fn(noopAsync),
    lastScan: vi.fn(async () => ({ at: undefined })),
    checkUpdate: vi.fn(async () => ({
      current: '1.1.0',
      hasUpdate: false,
      updateAvailable: false,
      checkedAt: Date.now()
    })),
    openExternal: vi.fn(noopAsync)
  }
  // onScanCompleted / onUpdaterOpen 在 preload 里是顶层 window 属性（contextBridge.exposeInMainWorld）
  ;(window as unknown as { onScanCompleted: () => () => void }).onScanCompleted = vi.fn(
    () => noop
  )
  ;(window as unknown as { onUpdaterOpen: () => () => void }).onUpdaterOpen = vi.fn(() => noop)
})

afterEach(() => {
  vi.restoreAllMocks()
})

function renderLayout(initialPath = '/'): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <RefreshContext.Provider
        value={{ refreshTick: 0, refreshing: false, triggerRefresh: noopAsync, lastScanAt: undefined }}
      >
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<div>dashboard-body</div>} />
            <Route path="/security" element={<div>security-body</div>} />
          </Route>
        </Routes>
      </RefreshContext.Provider>
    </MemoryRouter>
  )
}

describe('Layout 快照回归', () => {
  it('侧边栏 9 个 nav 项 + 品牌名固定（snapshot）', () => {
    const { container } = renderLayout('/')
    expect(container).toMatchSnapshot()
  })

  it('security nav 文案稳定', () => {
    renderLayout('/security')
    const navs = screen.getAllByText('安全体检')
    expect(navs.length).toBeGreaterThanOrEqual(1) // nav + 可能 header
  })

  it('主题切换写 localStorage', () => {
    renderLayout('/')
    // ThemeToggle 标题用 i18n，单一按钮（dark 默认 → 亮色标题）
    const buttons = screen.getAllByTitle(/切换到(亮|暗)色主题/)
    expect(buttons.length).toBeGreaterThanOrEqual(1)
    fireEvent.click(buttons[0] as HTMLButtonElement)
    expect(localStorage.getItem('agentmgr-theme')).toBe('light')
  })

  it('自动刷新下拉 4 个选项', () => {
    const { container } = renderLayout('/')
    expect(container.querySelectorAll('select option')).toHaveLength(4)
  })
})
