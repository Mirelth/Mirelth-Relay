import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Hooks 读写回归：创建/删除往返、保留无关键、坏文件拒写。
 * hooks.ts 路径同样来自模块加载时的 HOME → 先设 env 再 import；
 * 路径表达式必须在测试运行时求值（describe 收集阶段 home 还是空的）。
 */

let home = ''
let mod: typeof import('../src/main/hooks')

function seed(relPath: string, content: string): string {
  const p = join(home, relPath)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
  return p
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'agentmgr-hooks-'))
  process.env.HOME = home
  process.env.USERPROFILE = home
  vi.resetModules()
  mod = await import('../src/main/hooks')
})
afterAll(() => rmSync(home, { recursive: true, force: true }))

describe('claude-code（已验证目标）hooks 往返', () => {
  it('createHook 写入结构、保留无关键、生成备份', () => {
    const settingsPath = seed('.claude/settings.json', JSON.stringify({ model: 'opus', env: { A: '1' } }, null, 2))
    const { backupPath } = mod.createHook({
      agentId: 'claude-code',
      event: 'PreToolUse',
      matcher: 'Bash',
      command: '/usr/local/bin/notify.sh',
      timeout: 60
    })
    const cfg = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(cfg.model).toBe('opus')
    expect(cfg.env).toEqual({ A: '1' })
    expect(cfg.hooks.PreToolUse[0]).toEqual({
      matcher: 'Bash',
      hooks: [{ type: 'command', command: '/usr/local/bin/notify.sh', timeout: 60 }]
    })
    expect(backupPath && readFileSync(backupPath, 'utf8')).toContain('opus')
  })

  it('listHooks 能读回刚写入的 hook', () => {
    const h = mod.listHooks().find((x) => x.agentId === 'claude-code')
    expect(h).toBeTruthy()
    expect(h!.command).toBe('/usr/local/bin/notify.sh')
    expect(h!.event).toBe('PreToolUse')
  })

  it('deleteHook 精确删除且清掉空结构', () => {
    const h = mod.listHooks().find((x) => x.agentId === 'claude-code')!
    mod.deleteHook(h.id)
    const cfg = JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8'))
    expect(cfg.hooks).toBeUndefined()
    expect(cfg.model).toBe('opus')
  })
})

describe('坏文件拒写', () => {
  it('settings 无法解析 → 抛错且文件保持原样', () => {
    const garbage = '{ not-json-v2 {'
    const cbPath = seed('.codebuddy/settings.json', garbage)
    expect(() =>
      mod.createHook({ agentId: 'codebuddy', event: 'Stop', command: 'echo hi' })
    ).toThrow(/已中止写入/)
    expect(readFileSync(cbPath, 'utf8')).toBe(garbage)
  })
})

describe('listHookTargets', () => {
  it('暴露 verified 标志：claude=true，其余=false', () => {
    const targets = mod.listHookTargets()
    const claude = targets.find((t) => t.agentId === 'claude-code')
    expect(claude?.exists).toBe(true)
    expect(claude?.verified).toBe(true)
    const zcode = targets.find((t) => t.agentId === 'zcode')
    expect(zcode?.verified).toBe(false)
  })
})
