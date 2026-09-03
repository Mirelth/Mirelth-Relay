import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// vi.hoisted 在 import 前同步求值，用 require() 避免 import 顺序问题
const { home } = vi.hoisted(() => {
  const fs = require('fs') as typeof import('fs')
  const os = require('os') as typeof import('os')
  const path = require('path') as typeof import('path')
  return { home: fs.mkdtempSync(path.join(os.tmpdir(), 'agentmgr-cb-')) }
})

// 改 mock os.homedir 而非 lib/fs —— 因为 HOME 在 lib/fs 模块加载时一次性求值，
// 后续 mock lib/fs 改 export 不会回写到已求值的 HOME
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => home }
})

const { codebuddyScanner, toRawMcp } = await import('../src/main/scanner/agents/codebuddy')

/**
 * CodeBuddy 扫描器回归：
 * - toRawMcp 是纯函数，覆盖所有 transport 判定分支
 * - 集成测试：构造 settings.json + mcp.json + skills/<name>/SKILL.md 验证探测、配置摘要、技能去重
 */

beforeAll(() => {
  mkdirSync(join(home, '.codebuddy'), { recursive: true })
  writeFileSync(
    join(home, '.codebuddy/settings.json'),
    JSON.stringify({ theme: 'dark', apiKey: 'sk-1234567890abcdef' })
  )
  writeFileSync(
    join(home, '.codebuddy/mcp.json'),
    JSON.stringify({
      mcpServers: {
        'stdio-srv': { command: 'node', args: ['s.js'], disabled: false },
        'http-srv': { url: 'https://example.com/mcp' },
        'disabled-srv': { command: 'python', args: ['a.py'], disabled: true },
        'cmd-array': { command: ['uv', 'run', 'srv'] }
      }
    })
  )
  const s1 = join(home, '.codebuddy/skills/foo')
  mkdirSync(s1, { recursive: true })
  writeFileSync(
    join(s1, 'SKILL.md'),
    '---\nname: foo-skill\ndescription: desc\nversion: 1.0.0\n---\nbody'
  )
  const s2 = join(home, '.codebuddy/skills-marketplace/skills/foo')
  mkdirSync(s2, { recursive: true })
  writeFileSync(join(s2, 'SKILL.md'), '---\nname: foo-skill\n---\nmarket')
  const s3 = join(home, '.codebuddy/skills-marketplace/skills/bar')
  mkdirSync(s3, { recursive: true })
  writeFileSync(join(s3, 'SKILL.md'), '---\ndescription: only in market\n---\nb')
})
afterAll(() => rmSync(home, { recursive: true, force: true }))

describe('toRawMcp', () => {
  it('url → http transport', () => {
    expect(toRawMcp('h', { url: 'https://x' })).toMatchObject({
      name: 'h',
      transport: 'http',
      endpoint: 'https://x',
      enabled: true
    })
  })
  it('command string → stdio', () => {
    expect(toRawMcp('s', { command: 'node', args: ['a.js'] })).toMatchObject({
      transport: 'stdio',
      endpoint: 'node'
    })
  })
  it('command 数组 → 空格拼接作 endpoint', () => {
    expect(toRawMcp('m', { command: ['uv', 'run', 'srv'] })).toMatchObject({
      transport: 'stdio',
      endpoint: 'uv run srv'
    })
  })
  it('url+command 缺失 → unknown', () => {
    expect(toRawMcp('u', {}).transport).toBe('unknown')
  })
  it('disabled=true → enabled=false', () => {
    expect(toRawMcp('d', { command: 'x', disabled: true }).enabled).toBe(false)
  })
})

describe('codebuddyScanner 集成', () => {
  it('探测 + 配置摘要（key 字段脱敏）', () => {
    const s = codebuddyScanner.scan()
    expect(s.info.detected).toBe(true)
    const settings = s.configs.find((c) => c.path.endsWith('settings.json'))!
    expect(settings.exists).toBe(true)
    expect((settings.summary as { theme?: string }).theme).toBe('dark')
    expect((settings.summary as { apiKey?: string }).apiKey).toMatch(/^•+/)
  })

  it('mcp.json 4 类条目全部解析', () => {
    const s = codebuddyScanner.scan()
    const byName = Object.fromEntries(s.mcpServers.map((m) => [m.name, m]))
    expect(byName['stdio-srv']).toMatchObject({ transport: 'stdio', enabled: true })
    expect(byName['http-srv']).toMatchObject({ transport: 'http' })
    expect(byName['disabled-srv']).toMatchObject({ enabled: false })
    expect(byName['cmd-array']).toMatchObject({ endpoint: 'uv run srv' })
    expect(s.info.mcpCount).toBe(4)
  })

  it('技能 skills ∪ skills-marketplace 名称去重', () => {
    const s = codebuddyScanner.scan()
    const names = s.skills.map((sk) => sk.name)
    const uniq = new Set(names)
    expect(names.length).toBe(uniq.size)
    expect(uniq.has('foo-skill')).toBe(true)
    expect(uniq.has('bar')).toBe(true)
  })
})
