import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ModelProfile } from '../src/shared/types'

/**
 * 模型配置写入器行为测试。
 * appliers 在模块加载时用 HOME 计算各配置文件路径，
 * 因此测试把 HOME 指向临时目录后再 dynamic import；
 * 所有路径在测试运行时才求值（describe 收集阶段 home 还是空的）。
 */

let home = ''
let mod: typeof import('../src/main/models/appliers')

function seed(rel: string, content: string): string {
  const p = join(home, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
  return p
}
const rel = (r: string): string => join(home, r)

const profile: ModelProfile = {
  id: 'demo',
  name: 'Demo Provider',
  kind: 'anthropic',
  baseURL: 'https://demo.local/v1',
  apiKey: 'sk-demo-1234567890',
  models: [{ id: 'demo-1', name: 'Demo One', contextWindow: 200000, maxTokens: 8192 }],
  defaultModel: 'demo-1',
  updatedAt: new Date().toISOString()
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'agentmgr-appliers-'))
  process.env.HOME = home
  process.env.USERPROFILE = home
  vi.resetModules()
  mod = await import('../src/main/models/appliers')
})
afterAll(() => rmSync(home, { recursive: true, force: true }))

const opts = { setDefault: false }

describe('zcode applier', () => {
  it('正常写入：合并 provider 且保留其它键，留下备份', () => {
    const cfgPath = seed('.zcode/v2/config.json', JSON.stringify({ theme: 'dark', nested: { keep: true } }, null, 2))
    const res = mod.applyProfile(profile, ['zcode'], opts)
    expect(res[0].ok).toBe(true)
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(cfg.theme).toBe('dark')
    expect(cfg.nested.keep).toBe(true)
    expect(cfg.provider['agentmgr:demo'].options.baseURL).toBe('https://demo.local/v1')
    expect(res[0].backupPath && existsSync(res[0].backupPath)).toBe(true)
  })

  it('文件解析失败（上游格式变更）→ 拒写、原文件一字未动、不产生备份', () => {
    const garbage = '{"broken": [1,2'
    const cfgPath = seed('.zcode/v2/config.json', garbage)
    const dir = dirname(cfgPath)
    const before = readdirSync(dir)
    const res = mod.applyProfile(profile, ['zcode'], opts)
    expect(res[0].ok).toBe(false)
    expect(res[0].message).toMatch(/已中止写入/)
    expect(readFileSync(cfgPath, 'utf8')).toBe(garbage)
    expect(readdirSync(dir)).toEqual(before)
  })

  it('配置文件不存在 → 拒绝写入（不凭空新建别人家的配置）', () => {
    rmSync(rel('.zcode/v2/config.json'), { force: true })
    const res = mod.applyProfile(profile, ['zcode'], opts)
    expect(res[0].ok).toBe(false)
    expect(res[0].message).toMatch(/未检测到配置文件/)
    expect(existsSync(rel('.zcode/v2/config.json'))).toBe(false)
  })
})

describe('opencode / loomy applier', () => {
  it('jsonc（含注释）可解析并成功写入 provider', () => {
    const jsoncPath = seed(
      '.config/opencode/opencode.jsonc',
      `{\n  // 用户的注释\n  "theme": "opencode"\n}\n`
    )
    const res = mod.applyProfile(profile, ['opencode'], { setDefault: true })
    expect(res[0].ok).toBe(true)
    const cfg = JSON.parse(readFileSync(jsoncPath, 'utf8'))
    expect(cfg.theme).toBe('opencode')
    expect(cfg.provider.demo.options.apiKey).toBe('sk-demo-1234567890')
    expect(cfg.model).toBe('demo/demo-1')
  })

  it('listAppliers 中 OpenCode 带注释移除提示', () => {
    const info = mod.listAppliers().find((a) => a.agentId === 'opencode')
    expect(info?.support).toBe('full')
    expect(info?.note).toMatch(/注释/)
  })
})

describe('ycli yaml applier', () => {
  it('yaml 合并写入且保留原有键，写后回读为对象', async () => {
    seed('.ycli/config.yaml', 'foo: bar\nlist:\n  - 1\n')
    const res = mod.applyProfile(profile, ['ycli'], opts)
    expect(res[0].ok).toBe(true)
    const YAML = await import('yaml')
    const cfg = YAML.parse(readFileSync(rel('.ycli/config.yaml'), 'utf8'))
    expect(cfg.foo).toBe('bar')
    expect(cfg.list).toEqual([1])
    expect(cfg.provider).toBe('openai')
    expect(cfg.api_key).toBe('sk-demo-1234567890')
  })

  it('yaml 内容为标量 → 拒写', () => {
    const p = seed('.ycli/config.yaml', 'just a plain string\n')
    const res = mod.applyProfile(profile, ['ycli'], opts)
    expect(res[0].ok).toBe(false)
    expect(res[0].message).toMatch(/中止/)
    expect(readFileSync(p, 'utf8')).toBe('just a plain string\n')
  })
})

describe('dsh-web / dsh-desktop appliers', () => {
  it('两实体各写各的 settings.yaml，互不影响', async () => {
    seed('.dsh/settings.yaml', 'ui-onboarding:\n  welcomeNoticeVersion: 1\n')
    seed('.dsh-desktop/settings.yaml', 'ui-onboarding:\n  welcomeNoticeVersion: 2\n')
    const res = mod.applyProfile(profile, ['dsh-web', 'dsh-desktop'], opts)
    expect(res[0].ok && res[1].ok).toBe(true)
    const YAML = await import('yaml')
    const web = YAML.parse(readFileSync(rel('.dsh/settings.yaml'), 'utf8'))
    const desk = YAML.parse(readFileSync(rel('.dsh-desktop/settings.yaml'), 'utf8'))
    expect(web['llm-pi-ai'].providers.demo.baseURL).toBe('https://demo.local/v1')
    expect(web.uiOnboarding ?? web['ui-onboarding']).toBeTruthy()
    expect(desk['llm-pi-ai'].providers.demo.baseURL).toBe('https://demo.local/v1')
    // web 写入不应污染 desktop 的原有值，反之亦然
    expect(desk['ui-onboarding'].welcomeNoticeVersion).toBe(2)
    expect(res[0].message).toMatch(/AGENTMGR_DEMO_API_KEY/)
  })

  it('setDefault 只写目标实体', async () => {
    seed('.dsh/settings.yaml', 'keep: true\n')
    seed('.dsh-desktop/settings.yaml', 'keep: true\n')
    const withDefault = { ...profile, defaultModel: 'demo-1' }
    mod.applyProfile(withDefault, ['dsh-desktop'], { setDefault: true })
    const YAML = await import('yaml')
    const desk = YAML.parse(readFileSync(rel('.dsh-desktop/settings.yaml'), 'utf8'))
    const web = YAML.parse(readFileSync(rel('.dsh/settings.yaml'), 'utf8'))
    expect(desk['agent-default-model']).toEqual({ provider: 'demo', model: 'demo-1' })
    expect(web['agent-default-model']).toBeUndefined()
  })

  it('配置不存在 → 不凭空新建', () => {
    rmSync(rel('.dsh/settings.yaml'), { force: true })
    const res = mod.applyProfile(profile, ['dsh-web'], opts)
    expect(res[0].ok).toBe(false)
    expect(res[0].message).toMatch(/未检测到配置文件/)
  })
})

describe('listAppliers 探测', () => {
  it('未安装的智能体 support=none 并给出提示', () => {
    // DSH 已拆为 dsh-web / dsh-desktop 两实体；清掉前序用例留下的配置再探测
    rmSync(rel('.dsh/settings.yaml'), { force: true })
    rmSync(rel('.dsh-desktop/settings.yaml'), { force: true })
    for (const id of ['dsh-web', 'dsh-desktop']) {
      const a = mod.listAppliers().find((x) => x.agentId === id)
      expect(a?.support, id).toBe('none')
      expect(a?.note, id).toMatch(/未检测到/)
    }
  })
})
