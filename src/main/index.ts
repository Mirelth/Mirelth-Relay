import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerIpc } from './ipc'
import { refreshAndRecord, refreshAll } from './engine'
import { checkAllMcp } from './mcp-health'
import { getStore } from './cache'
import { copySkill, listSkillCopyTargets } from './skills-copy'
import * as alerts from './alerts'
import { logger, installProcessHandlers } from './lib/logger'

installProcessHandlers()

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: 'AgentTower · 智能体塔台',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  mainWindow = win

  win.on('ready-to-show', () => {
    win.show()
  })

  // 关闭按钮 = 隐藏到托盘（托盘菜单里可真正退出）
  win.on('close', (e) => {
    if (!alerts.isQuitting()) {
      e.preventDefault()
      win.hide()
    }
  })

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function focusWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (!mainWindow.isVisible()) mainWindow.show()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
}

/** 全量扫描 → MCP 健康检查 → 事件通知 → 通知渲染进程刷新 */
async function runFullRefresh(): Promise<void> {
  await refreshAndRecord()
  await checkAllMcp()
  alerts.compareAndNotify(getStore())
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('scan:completed')
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.agenttower.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpc()
  alerts.setWindowFocusHandler(focusWindow)

  createWindow()

  // 托盘常驻
  alerts.setupTray({
    iconPath: icon,
    getStore,
    onRefresh: async (): Promise<void> => {
      await runFullRefresh()
    },
    onCheckUpdate: () => {
      focusWindow()
      mainWindow?.webContents.send('updater:open')
    }
  })

  // 首次启动后台执行一次全量扫描，扫描完成后通知渲染进程
  void runFullRefresh().catch((err) => logger.error('startup', 'initial scan failed', err))

  // 调试用：AGENTMGR_SHOT=<目录> 时自动扫描截图各页面后退出（供自动化验证）
  const shotDir = process.env.AGENTMGR_SHOT
  if (shotDir) {
    void (async () => {
      await new Promise((r) => setTimeout(r, 12000))
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) return
      const routes = [
        '/',
        '/agents',
        '/skills',
        '/mcp',
        '/git',
        '/tokens',
        '/models',
        '/hooks',
        '/security'
      ]
      const wc = win.webContents
      const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
      const waitLoad = async (): Promise<void> => {
        await sleep(800)
        if (wc.isLoading()) await new Promise<void>((r) => wc.once('did-finish-load', () => r()))
        await sleep(2500)
      }
      const setThemeAndHome = async (theme: string): Promise<void> => {
        await wc.executeJavaScript(`localStorage.setItem('agentmgr-theme', '${theme}'); 'ok'`)
        await wc.executeJavaScript(`location.hash = '#/'; 'ok'`)
        wc.reload()
        await waitLoad()
      }
      const navigate = async (route: string): Promise<void> => {
        const hash = `#${route === '/' ? '/' : route}`
        for (let i = 0; i < 10; i++) {
          const cur = await wc.executeJavaScript('location.hash')
          if (cur === hash) break
          await wc.executeJavaScript(`location.hash = '${hash}'; 'ok'`)
          await sleep(800)
        }
      }
      const captureAll = async (suffix: string): Promise<void> => {
        for (const route of routes) {
          await navigate(route)
          // /git 需要跨多个仓库聚合 git log，给更长渲染等待
          await sleep(route === '/git' ? 15000 : 4000)
          const image = await wc.capturePage()
          const name = (route === '/' ? 'dashboard' : route.slice(1)) + suffix
          require('fs').writeFileSync(join(shotDir, `${name}.png`), image.toPNG())
        }
      }
      const captureShot = async (name: string): Promise<void> => {
        const image = await wc.capturePage()
        require('fs').writeFileSync(join(shotDir, `${name}.png`), image.toPNG())
      }
      // 点击包含指定文本的按钮（用于触发弹窗交互态）
      const clickByText = async (text: string): Promise<boolean> =>
        await wc.executeJavaScript(`(() => {
          const els = [...document.querySelectorAll('button')];
          const el = els.find(e => e.textContent && e.textContent.includes(${JSON.stringify(text)}));
          if (el) { el.click(); return true; } return false;
        })()`)

      await setThemeAndHome('dark')
      await captureAll('')
      // 交互态：模型单价弹窗
      await navigate('/tokens')
      await sleep(4000)
      if (await clickByText('模型单价')) {
        await sleep(2500)
        await captureShot('tokens-pricing-modal')
        // 点遮罩关闭弹窗，避免与更新弹窗叠加
        await wc.executeJavaScript(`document.querySelector('div.fixed.inset-0')?.click(); 'ok'`)
        await sleep(800)
      }
      // 交互态：更新弹窗
      if (await clickByText('v1.0.0')) {
        await sleep(1500)
        await captureShot('update-modal')
      }
      await setThemeAndHome('light')
      await captureAll('-light')
      alerts.markQuitting()
      app.exit(0)
    })()
  }

  // 调试用：AGENTMGR_DOM_TEST=<结果文件> 时对关键页面做 DOM 内容断言（视觉验收的无头替代）
  const domTestOut = process.env.AGENTMGR_DOM_TEST
  if (domTestOut) {
    void (async () => {
      await new Promise((r) => setTimeout(r, 12000))
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) return
      const wc = win.webContents
      const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
      const goto = async (route: string): Promise<void> => {
        const hash = `#${route === '/' ? '/' : route}`
        await wc.executeJavaScript(`location.hash = '${hash}'; 'ok'`)
        await sleep(2500)
      }
      const bodyText = async (): Promise<string> => (await wc.executeJavaScript('document.body.innerText')) as string
      const btnText = async (): Promise<string> =>
        (await wc.executeJavaScript('[...document.querySelectorAll("button")].map(b=>b.textContent).join("|")')) as string
      const SECRET_ANY = /(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|LTAI[A-Za-z0-9]{12,22})/
      const out: { page: string; checks: { name: string; pass: boolean; detail?: string }[] }[] = []
      const run = async (page: string, fn: () => Promise<{ name: string; pass: boolean; detail?: string }[]>): Promise<void> => {
        console.log(`[domtest] ${page} start`)
        await goto(page)
        out.push({ page, checks: await fn() })
        console.log(`[domtest] ${page} done`)
      }

      await run('/', async () => {
        const t = await bodyText()
        const b = await btnText()
        return [
          { name: '侧栏含安全体检入口', pass: t.includes('安全体检') },
          { name: '顶栏版本按钮存在', pass: /\bv\d+\.\d+\.\d+/.test(b), detail: b.slice(0, 120) },
          { name: '仪表盘卡片渲染', pass: t.includes('检测到智能体') && t.includes('今日 Token 消耗') },
          { name: '无崩溃文案', pass: !t.includes('TypeError') && !t.includes('Something went wrong') }
        ]
      })
      await run('/tokens', async () => {
        const t = await bodyText()
        const b = await btnText()
        return [
          { name: '估算成本卡存在', pass: t.includes('估算成本') },
          { name: '覆盖率/定价状态文案', pass: t.includes('覆盖') || t.includes('全部模型已定价') || t.includes('暂无用量') },
          { name: '模型单价按钮', pass: b.includes('模型单价') },
          { name: '导出CSV按钮', pass: b.includes('导出 CSV') }
        ]
      })
      await run('/security', async () => {
        const t = await bodyText()
        return [
          { name: '三张汇总卡标题', pass: t.includes('检查文件') && t.includes('高危') && t.includes('需关注') },
          { name: '有风险清单或干净结论', pass: t.includes('风险清单') || t.includes('未发现明文密钥') },
          { name: '无完整明文密钥泄露', pass: !SECRET_ANY.test(t) }
        ]
      })
      await run('/git', async () => {
        const b = await btnText()
        return [{ name: '导出CSV按钮', pass: b.includes('导出 CSV') }]
      })
      await run('/agents', async () => {
        const t = await bodyText()
        const b = await btnText()
        return [
          { name: '页面有内容', pass: t.length > 80, detail: `len=${t.length}` },
          { name: '安装状态筛选器', pass: b.includes('已安装') && b.includes('配置残留') && b.includes('状态未知') },
          { name: '卡片显示已安装徽标', pass: t.includes('已安装') },
          { name: '本机确有残留智能体被识别（opencode/codebuddy 卸载后剩配置）', pass: t.includes('个智能体已检测到配置'), detail: t.match(/(\d+) 配置残留/)?.[1] ? `残留数=${t.match(/(\d+) 配置残留/)![1]}` : '未见残留提示' },
          { name: 'DSH 已拆分为 Web 与 Desktop 两实体', pass: t.includes('DSH Web') && t.includes('DSH Desktop') }
        ]
      })
      for (const page of ['/skills', '/mcp', '/models', '/hooks']) {
        await run(page, async () => {
          const t = await bodyText()
          return [
            { name: '页面有内容', pass: t.length > 80, detail: `len=${t.length}` },
            { name: '无报错文案', pass: !t.includes('TypeError') && !t.includes('出错') }
          ]
        })
      }
      const failed = out.flatMap((p) => p.checks.filter((c) => !c.pass).map((c) => `${p.page} ${c.name}`))
      require('fs').writeFileSync(domTestOut, JSON.stringify({ ok: failed.length === 0, failed, pages: out }, null, 2), 'utf8')
      alerts.markQuitting()
      app.exit(0)
    })()
  }

  // 调试用：AGENTMGR_COPY_TEST=<结果文件> 时真实复制一个技能到 Hub 并清理，验证技能复制链路
  const copyTestOut = process.env.AGENTMGR_COPY_TEST
  if (copyTestOut) {
    void (async () => {
      await new Promise((r) => setTimeout(r, 8000))
      const fsMod = require('fs') as typeof import('fs')
      const targets = listSkillCopyTargets()
      const source = getStore()
        .listSkills()
        .find((s) => s.agentId === 'zcode' && s.source && fsMod.existsSync(s.source))
      const results = source ? await copySkill(source.id, ['hub']) : []
      // 清理：删掉拷贝产物并重扫恢复缓存
      let cleaned = false
      const dest = results[0]?.message.match(/已复制到 (.+)$/)?.[1]
      if (dest && fsMod.existsSync(dest)) {
        fsMod.rmSync(dest, { recursive: true, force: true })
        cleaned = true
        await refreshAll('hub')
      }
      require('fs').writeFileSync(
        copyTestOut,
        JSON.stringify(
          { source: source?.name, targetCount: targets.length, results, cleaned },
          null,
          2
        ),
        'utf8'
      )
      alerts.markQuitting()
      app.exit(0)
    })()
  }

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  alerts.markQuitting()
})

// 托盘常驻后不再因窗口全部关闭而退出（macOS 本就不退出；Windows/Linux 由托盘菜单退出）
