import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerIpc } from './ipc'
import { refreshAndRecord } from './engine'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
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

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.agenttower.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpc()

  // 首次启动后台执行一次全量扫描，扫描完成后通知渲染进程
  void refreshAndRecord()
    .then(() => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('scan:completed')
      }
    })
    .catch((err) => console.error('initial scan failed:', err))

  createWindow()

  // 调试用：AGENTMGR_SHOT=<目录> 时自动扫描截图各页面后退出（供自动化验证）
  const shotDir = process.env.AGENTMGR_SHOT
  if (shotDir) {
    void (async () => {
      await new Promise((r) => setTimeout(r, 12000))
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) return
      const routes = ['/', '/agents', '/skills', '/mcp', '/git', '/tokens', '/models', '/hooks']
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
      await setThemeAndHome('dark')
      await captureAll('')
      await setThemeAndHome('light')
      await captureAll('-light')
      app.exit(0)
    })()
  }

  // 调试用：AGENTMGR_COPY_TEST=<结果文件> 时真实复制一个技能到 Hub 并清理，验证技能复制链路
  const copyTestOut = process.env.AGENTMGR_COPY_TEST
  if (copyTestOut) {
    void (async () => {
      await new Promise((r) => setTimeout(r, 8000))
      const skillsCopy = await import('./skills-copy')
      const { getStore } = await import('./cache')
      const fsMod = await import('fs')
      const targets = skillsCopy.listSkillCopyTargets()
      const source = getStore()
        .listSkills()
        .find((s) => s.agentId === 'zcode' && s.source && fsMod.existsSync(s.source))
      const results = source ? await skillsCopy.copySkill(source.id, ['hub']) : []
      // 清理：删掉拷贝产物并重扫恢复缓存
      let cleaned = false
      const dest = results[0]?.message.match(/已复制到 (.+)$/)?.[1]
      if (dest && fsMod.existsSync(dest)) {
        fsMod.rmSync(dest, { recursive: true, force: true })
        cleaned = true
        const { refreshAll } = await import('./engine')
        await refreshAll('hub')
      }
      require('fs').writeFileSync(
        copyTestOut,
        JSON.stringify({ source: source?.name, targetCount: targets.length, results, cleaned }, null, 2),
        'utf8'
      )
      app.exit(0)
    })()
  }

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
