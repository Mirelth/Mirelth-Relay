import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const { home } = vi.hoisted(() => {
  const fs = require('fs') as typeof import('fs')
  const os = require('os') as typeof import('os')
  const path = require('path') as typeof import('path')
  return { home: fs.mkdtempSync(path.join(os.tmpdir(), 'agentmgr-qoder-')) }
})

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => home }
})

const { qoderScanner } = await import('../src/main/scanner/agents/qoder')

/**
 * Qoder 扫描器回归：
 * - installed_plugins_v2.json：pluginKey 以 @ 切名，installPath/version/installedAt 提取
 * - plugins/cache 目录树作为补充技能来源（同名与 installed_plugins 去重）
 * - projects/-xxx 目录名反解为绝对路径；非 - 开头目录跳过
 */

beforeAll(() => {
  const base = join(home, '.qoder')
  mkdirSync(base, { recursive: true })

  // 配置
  writeFileSync(
    join(base, 'settings.json'),
    JSON.stringify({ theme: 'light', apiKey: 'sk-redact' })
  )

  // installed_plugins_v2.json
  const pluginsDir = join(base, 'plugins')
  mkdirSync(pluginsDir, { recursive: true })
  writeFileSync(
    join(pluginsDir, 'installed_plugins_v2.json'),
    JSON.stringify({
      plugins: {
        'foo-plugin@1.2.3': [
          {
            scope: 'user',
            installPath: '/path/foo',
            version: '1.2.3',
            installedAt: '2026-08-01T00:00:00Z'
          }
        ],
        'bar-plugin@0.9': [
          { scope: 'user', installPath: '/path/bar', version: '0.9' }
        ]
      }
    })
  )

  // plugins/cache/<mkt>/<plugin>：与 installed_plugins 同名应被去重
  mkdirSync(join(pluginsDir, 'cache', 'market-a', 'foo-plugin'), { recursive: true })
  mkdirSync(join(pluginsDir, 'cache', 'market-a', 'unique-skill'), { recursive: true })

  // projects/-xxx 反解：构造一个真存在的目录让 isDir 命中
  const projectsDir = join(base, 'projects')
  mkdirSync(projectsDir, { recursive: true })
  const projName = '-Users-new-Documents-Qoder-2026-08-27-xxx'
  mkdirSync(join(projectsDir, projName), { recursive: true })
  // 非 - 开头目录应被跳过
  mkdirSync(join(projectsDir, 'unrelated-dir'), { recursive: true })
})
afterAll(() => rmSync(home, { recursive: true, force: true }))

describe('qoderScanner', () => {
  it('探测 + 插件名取 @ 前缀 + version/installedAt', () => {
    const s = qoderScanner.scan()
    expect(s.info.detected).toBe(true)
    const foo = s.skills.find((sk) => sk.name === 'foo-plugin')!
    expect(foo.version).toBe('1.2.3')
    expect(foo.installedAt).toBe('2026-08-01T00:00:00Z')
    expect(foo.source).toBe('/path/foo')
  })

  it('plugins/cache 补充技能且与已注册插件去重', () => {
    const s = qoderScanner.scan()
    const names = s.skills.map((sk) => sk.name)
    const uniq = new Set(names)
    expect(names.length).toBe(uniq.size)
    expect(uniq.has('foo-plugin')).toBe(true)
    expect(uniq.has('unique-skill')).toBe(true)
  })

  it('projects/-xxx 目录名反解为 /Users/... 路径', () => {
    const s = qoderScanner.scan()
    expect(s.projectDirs).toContain('/Users/new/Documents/Qoder/2026/08/27/xxx')
    expect(s.projectDirs).not.toContain('unrelated-dir')
    expect(s.info.projectCount).toBe(1)
  })

  it('无 installedAt 时字段缺失', () => {
    const s = qoderScanner.scan()
    const bar = s.skills.find((sk) => sk.name === 'bar-plugin')!
    expect(bar.version).toBe('0.9')
    expect(bar.installedAt).toBeUndefined()
  })
})
