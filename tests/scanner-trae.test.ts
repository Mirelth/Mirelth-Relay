import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const { home } = vi.hoisted(() => {
  const fs = require('fs') as typeof import('fs')
  const os = require('os') as typeof import('os')
  const path = require('path') as typeof import('path')
  return { home: fs.mkdtempSync(path.join(os.tmpdir(), 'agentmgr-trae-')) }
})

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => home }
})

const { traeScanner } = await import('../src/main/scanner/agents/trae')

/**
 * Trae CN 扫描器回归：
 * - builtin_skills/<name>/skill.json 解析（下划线开头跳过）
 * - mcps/<id>/integrated_code_mode/SERVER_METADATA.json + tools/<tool>.json
 * - 配置 argv.json / skill-config.json summary 脱敏
 */

beforeAll(() => {
  const base = join(home, '.trae-cn')
  mkdirSync(base, { recursive: true })

  // 配置
  writeFileSync(
    join(base, 'skill-config.json'),
    JSON.stringify({ enabled: true, apiKey: 'sk-redact-me' })
  )
  writeFileSync(join(base, 'argv.json'), JSON.stringify({ argv: ['--foo'] }))

  // builtin_skills：两个有效 + 一个 _internal 跳过
  const sk1 = join(base, 'builtin_skills/code-review')
  mkdirSync(join(sk1, 'sub'), { recursive: true })
  writeFileSync(join(sk1, 'skill.json'), JSON.stringify({ name: 'code-review', description: 'CR' }))
  const sk2 = join(base, 'builtin_skills/refactor')
  mkdirSync(sk2, { recursive: true })
  writeFileSync(join(sk2, 'skill.json'), JSON.stringify({ name: 'refactor', description: 'ref' }))
  const sk3 = join(base, 'builtin_skills/_internal')
  mkdirSync(sk3, { recursive: true })
  writeFileSync(join(sk3, 'skill.json'), JSON.stringify({ name: '_internal' }))

  // MCP：嵌套在 integrated_code_mode 子目录
  const mcpRoot = join(base, 'mcps')
  const mcpDir = join(mcpRoot, 'my-server/integrated_code_mode')
  mkdirSync(join(mcpDir, 'tools'), { recursive: true })
  writeFileSync(
    join(mcpDir, 'SERVER_METADATA.json'),
    JSON.stringify({ server_name: 'my-server-name' })
  )
  writeFileSync(join(mcpDir, 'tools', 'lookup.json'), JSON.stringify({ name: 'lookup', description: 'lookup something' }))
  writeFileSync(join(mcpDir, 'tools', 'search.json'), JSON.stringify({ name: 'search', description: 'long description '.repeat(20) }))

  // 第二个 server（仅用来验证多 server 都解析到）
  const mcp2 = join(mcpRoot, 'aux/integrated_code_mode')
  mkdirSync(join(mcp2, 'tools'), { recursive: true })
  writeFileSync(join(mcp2, 'SERVER_METADATA.json'), JSON.stringify({ server_name: 'aux' }))
  writeFileSync(join(mcp2, 'tools', 'ping.json'), JSON.stringify({}))
})
afterAll(() => rmSync(home, { recursive: true, force: true }))

describe('traeScanner', () => {
  it('探测 + 配置脱敏', () => {
    const s = traeScanner.scan()
    expect(s.info.detected).toBe(true)
    const sc = s.configs.find((c) => c.path.endsWith('skill-config.json'))!
    expect(sc.exists).toBe(true)
    expect((sc.summary as { apiKey?: string }).apiKey).toMatch(/^•+/)
  })

  it('builtin_skills：_internal 跳过，frontmatter 名称生效', () => {
    const s = traeScanner.scan()
    const names = s.skills.map((sk) => sk.name).sort()
    expect(names).toEqual(['code-review', 'refactor'])
    s.skills.forEach((sk) => expect(sk.builtin).toBe(true))
  })

  it('MCP 元数据 + tools 列表，描述超长截断', () => {
    const s = traeScanner.scan()
    const myServer = s.mcpServers.find((m) => m.name === 'my-server-name')!
    expect(myServer.transport).toBe('stdio')
    expect(myServer.tools.map((t) => t.name).sort()).toEqual(['lookup', 'search'])
    const search = myServer.tools.find((t) => t.name === 'search')!
    expect(search.description!.length).toBeLessThanOrEqual(120)
  })

  it('多 server 都能找到', () => {
    const s = traeScanner.scan()
    expect(s.mcpServers).toHaveLength(2)
    expect(s.mcpServers.find((m) => m.name === 'aux')?.tools).toEqual([{ name: 'ping' }])
    expect(s.info.mcpCount).toBe(2)
  })
})
