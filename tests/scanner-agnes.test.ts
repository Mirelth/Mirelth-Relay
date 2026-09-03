import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'

const { home } = vi.hoisted(() => {
  const fs = require('fs') as typeof import('fs')
  const os = require('os') as typeof import('os')
  const path = require('path') as typeof import('path')
  return { home: fs.mkdtempSync(path.join(os.tmpdir(), 'agentmgr-agnes-')) }
})

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => home }
})

const { agnesScanner } = await import('../src/main/scanner/agents/agnes')

/**
 * AgnesCode 扫描器回归：
 * - YAML extensions 技能解析（含 display_name / bundled）
 * - sessions.db usage_ledger ↔ sessions 联表：token 字段、cost、项目目录
 * - 时间单位：< 1e12 视为秒需 ×1000，否则毫秒
 * - 项目目录去重
 */

beforeAll(() => {
  // config/config.yaml
  mkdirSync(join(home, '.agnes/config'), { recursive: true })
  writeFileSync(
    join(home, '.agnes/config/config.yaml'),
    [
      'AGNES_MODE: "default"',
      'extensions:',
      '  ext-a:',
      '    enabled: true',
      '    name: "alpha"',
      '    description: "alpha desc"',
      '    bundled: true',
      '    display_name: "Alpha Display"',
      '  ext-b:',
      '    enabled: false',
      '    name: "beta"',
      '',
      'apiKey: "sk-should-be-redacted"'
    ].join('\n')
  )

  // data/sessions/sessions.db
  const dataDir = join(home, '.agnes/data/sessions')
  mkdirSync(dataDir, { recursive: true })
  const db = new Database(join(dataDir, 'sessions.db'))
  db.exec(`
    create table sessions (
      id text primary key, working_dir text
    );
    create table usage_ledger (
      session_id text, model text, input_tokens integer, output_tokens integer,
      cache_read_tokens integer, cache_write_tokens integer, cost real, created_timestamp integer
    );
    insert into sessions values ('s1', '/repo/proj-x');
    insert into sessions values ('s2', '/repo/proj-x');
    insert into sessions values ('s3', '/repo/proj-y');
    -- 时间戳以秒为单位（< 1e12）
    insert into usage_ledger values
      ('s1', 'glm-4.6', 100, 50, 10, 5, 0.01, 1725000000),
      ('s2', 'glm-4.6', 200, 100, 20, 10, 0.02, 1725000100),
      ('s3', 'unknown', 50, 0, 0, 0, null, 1725000200);
  `)
  db.close()
})
afterAll(() => rmSync(home, { recursive: true, force: true }))

describe('agnesScanner', () => {
  it('探测 + 技能来自 extensions，display_name 优先', () => {
    const s = agnesScanner.scan()
    expect(s.info.detected).toBe(true)
    const byKey = Object.fromEntries(s.skills.map((sk) => [sk.id.split(':').pop(), sk]))
    expect(byKey['ext-a']?.name).toBe('Alpha Display')
    expect(byKey['ext-a']?.builtin).toBe(true)
    expect(byKey['ext-b']?.name).toBe('beta')
    expect(s.info.skillCount).toBe(2)
  })

  it('配置 apiKey 字段脱敏', () => {
    const s = agnesScanner.scan()
    const cfg = s.configs[0]
    expect((cfg.summary as { apiKey?: string }).apiKey).toMatch(/^•+/)
  })

  it('usage_ledger 秒单位时间戳 ×1000、字段映射、cost 容错', () => {
    const s = agnesScanner.scan()
    expect(s.info.hasUsage).toBe(true)
    expect(s.usage).toHaveLength(3)
    expect(s.usage[0]).toMatchObject({
      model: 'glm-4.6',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      costUsd: 0.01,
      requests: 1
    })
    expect(s.usage[0].ts).toBe(1725000000 * 1000) // 秒→毫秒
    expect(s.usage[2].costUsd).toBe(0) // null → 0
    expect(s.usage[2].model).toBe('unknown') // null model
  })

  it('毫秒级时间戳保持原值（不 ×1000）', () => {
    const db = new Database(join(home, '.agnes/data/sessions/sessions.db'))
    db.prepare('insert into usage_ledger values (?,?,?,?,?,?,?,?)').run(
      's5',
      'm-ms',
      7,
      11,
      0,
      0,
      0,
      1900000000000
    )
    db.close()
    const u = agnesScanner.scan().usage.find((x) => x.ts === 1900000000000)
    expect(u).toBeDefined()
    expect(u!.inputTokens).toBe(7)
    expect(u!.outputTokens).toBe(11)
  })

  it('项目目录去重（working_dir 联表）', () => {
    const s = agnesScanner.scan()
    expect(s.projectDirs.sort()).toEqual(['/repo/proj-x', '/repo/proj-y'])
    expect(s.info.projectCount).toBe(2)
  })
})
