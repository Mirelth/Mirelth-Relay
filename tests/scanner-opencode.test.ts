import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { createOpencodeFamilyScanner } from '../src/main/scanner/agents/opencode'

/**
 * OpenCode 家族扫描器回归：用合成的配置 + sqlite 数据验证
 * 探测、配置摘要、session 表 token 解析与项目目录聚合。
 * 工厂函数接收路径参数，无需 HOME 操纵。
 */

let dir = ''
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmgr-oc-'))
  const configPath = join(dir, 'opencode.jsonc')
  writeFileSync(configPath, JSON.stringify({ model: 'demo/x', provider: { demo: {} } }))

  const dataDir = join(dir, 'share')
  mkdirSync(dataDir, { recursive: true })
  const db = new Database(join(dataDir, 'opencode.db'))
  db.exec(`
    create table project_directory (directory text);
    create table session (
      id text primary key, directory text, model text, time_created integer, cost real,
      tokens_input integer, tokens_output integer, tokens_reasoning integer,
      tokens_cache_read integer, tokens_cache_write integer
    );
    insert into project_directory values ('/repo/alpha');
    insert into session values
      ('s1','/repo/alpha','{"id":"glm-4.7"}',1725000000000,0.42,1000,200,0,50,10),
      ('s2','/repo/beta','not-json-model',1725000100000,0.10,500,100,20,0,5),
      ('s3',null,'{"id":"glm-4.7"}',1725000200000,null,7,3,0,0,0);
  `)
  db.close()
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('createOpencodeFamilyScanner', () => {
  it('未安装 → 空快照', () => {
    const s = createOpencodeFamilyScanner({
      id: 'ghost', name: 'Ghost', vendor: 'none', color: '#000',
      configPath: join(dir, 'nope.jsonc'), dataDir: join(dir, 'nope-dir')
    }).scan()
    expect(s.info.detected).toBe(false)
    expect(s.usage).toHaveLength(0)
  })

  it('探测、用量解析与模型字段容错', () => {
    const s = createOpencodeFamilyScanner({
      id: 'opencode-fx', name: 'OpenCode Fixture', vendor: 'test', color: '#fff',
      configPath: join(dir, 'opencode.jsonc'), dataDir: join(dir, 'share')
    }).scan()
    expect(s.info.detected).toBe(true)
    expect(s.info.hasUsage).toBe(true)
    expect(s.usage).toHaveLength(3)

    const byModel = Object.groupBy(s.usage, (u) => u.model)
    expect(byModel['glm-4.7']).toHaveLength(2)
    expect(byModel['not-json-model']).toHaveLength(1)

    const totalIn = s.usage.reduce((n, u) => n + u.inputTokens, 0)
    expect(totalIn).toBe(1507)
    const withCost = s.usage.find((u) => u.ts === 1725000000000)!
    expect(withCost.costUsd).toBe(0.42)
    expect(withCost.cacheReadTokens).toBe(50)

    // 项目目录 = project_directory 表 ∪ session.directory（去重，忽略 null）
    expect(s.projectDirs.sort()).toEqual(['/repo/alpha', '/repo/beta'])
    expect(s.info.projectCount).toBe(2)

    // 配置摘要原样回读
    expect((s.configs[0].summary as { model?: string }).model).toBe('demo/x')
  })

  it('Loomy 形态：session 无 token 列时从 part 表聚合', () => {
    const loomyDir = join(dir, 'loomy')
    mkdirSync(loomyDir, { recursive: true })
    const db = new Database(join(loomyDir, 'opencode.db'))
    db.exec(`
      create table session (id text primary key, directory text);
      create table message (id text primary key, session_id text, data text);
      create table part (id text primary key, message_id text, session_id text, data text);
      insert into session values ('s1','/repo/x');
      insert into message values ('m1','s1','{"modelID":"spark-v","time":{"created":1725000500000}}');
      insert into part values ('p1','m1','s1','{"type":"step-finish","tokens":{"input":111,"output":22,"cache":{"read":5,"write":1},"reasoning":3},"cost":0.5,"time":{"created":1725000500001}}');
    `)
    db.close()
    const s = createOpencodeFamilyScanner({
      id: 'loomy-fx', name: 'Loomy Fixture', vendor: 'test', color: '#fff',
      configPath: join(dir, 'loomy-none.jsonc'), dataDir: loomyDir
    }).scan()
    expect(s.info.detected).toBe(true)
    expect(s.usage).toHaveLength(1)
    const u = s.usage[0]
    expect(u).toMatchObject({
      model: 'spark-v',
      inputTokens: 111,
      outputTokens: 22,
      cacheReadTokens: 5,
      cacheWriteTokens: 1,
      reasoningTokens: 3,
      costUsd: 0.5
    })
    expect(s.projectDirs).toEqual(['/repo/x'])
  })
})
