import * as fs from 'fs'
import { join } from 'path'
import { HOME, exists, readJson, readJsonc, readYaml } from '../lib/fs'
import type { ApplierInfo, ApplyOptions, ApplyResult, ModelProfile } from '@shared/types'

/**
 * 模型配置写入器：把 Profile 写入各智能体的配置文件。
 * 原则：写入前先做带时间戳的备份；只动自己认识的键；失败不破坏原文件。
 */

function backup(filePath: string): string | null {
  if (!exists(filePath)) return null
  const bak = `${filePath}.agentmgr-bak-${Date.now()}`
  fs.copyFileSync(filePath, bak)
  return bak
}

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(join(filePath, '..'), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n')
}

function writeYaml(filePath: string, data: unknown): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const YAML = require('yaml') as typeof import('yaml')
  fs.mkdirSync(join(filePath, '..'), { recursive: true })
  fs.writeFileSync(filePath, YAML.stringify(data))
}

interface Applier {
  agentId: string
  agentName: string
  support: 'full' | 'partial' | 'none'
  note?: string
  configPath: string
  /** 当前自定义供应商摘要 */
  current(): string
  apply(profile: ModelProfile, opts: ApplyOptions): { message: string; backupPath?: string }
}

// ---------- ZCode：~/.zcode/v2/config.json provider map ----------

const zcodeApplier: Applier = {
  agentId: 'zcode',
  agentName: 'ZCode',
  support: 'full',
  configPath: join(HOME, '.zcode/v2/config.json'),
  current() {
    const cfg = readJson<{ provider?: Record<string, { name?: string; enabled?: boolean }> }>(this.configPath)
    const entries = Object.entries(cfg?.provider || {})
    return entries.length
      ? entries.map(([k, v]) => `${k}${v.enabled ? '' : '（停用）'}`).join('、')
      : '未配置自定义供应商'
  },
  apply(profile, opts) {
    const cfg = readJson<Record<string, unknown>>(this.configPath) || {}
    const providers = (cfg.provider as Record<string, unknown>) || {}
    const key = `agentmgr:${profile.id}`
    providers[key] = {
      name: profile.name,
      kind: profile.kind === 'anthropic' ? 'anthropic' : 'openai',
      options: { baseURL: profile.baseURL, apiKey: profile.apiKey },
      enabled: true,
      source: 'custom',
      models: Object.fromEntries(
        profile.models.map((m) => [
          m.id,
          {
            ...(m.name && m.name !== m.id ? { name: m.name } : {}),
            ...(m.contextWindow ? { limit: { context: m.contextWindow, output: m.maxTokens || 8192 } } : {})
          }
        ])
      )
    }
    cfg.provider = providers
    const bak = backup(this.configPath)
    writeJson(this.configPath, cfg)
    const def = opts.setDefault && profile.defaultModel ? `，默认模型设为 ${profile.defaultModel}（请在 ZCode 设置中选择该供应商）` : ''
    return { message: `已写入供应商 ${key}${def}`, backupPath: bak || undefined }
  }
}

// ---------- OpenCode / Loomy：opencode.json(c) provider ----------

function opencodeCurrent(configPath: string): string {
  const cfg = readJsonc<{ provider?: Record<string, unknown>; model?: string }>(configPath)
  const ids = Object.keys(cfg?.provider || {})
  return ids.length ? `${ids.join('、')}${cfg?.model ? `（默认 ${cfg.model}）` : ''}` : '未配置自定义供应商'
}

function opencodeApply(configPath: string, profile: ModelProfile, opts: ApplyOptions, isJsonc: boolean): { message: string; backupPath?: string } {
  const cfg = (isJsonc ? readJsonc<Record<string, unknown>>(configPath) : readJson<Record<string, unknown>>(configPath)) || {}
  const providers = (cfg.provider as Record<string, unknown>) || {}
  providers[profile.id] = {
    npm: profile.kind === 'anthropic' ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible',
    name: profile.name,
    options: { baseURL: profile.baseURL, apiKey: profile.apiKey },
    models: Object.fromEntries(profile.models.map((m) => [m.id, m.name && m.name !== m.id ? { name: m.name } : {}]))
  }
  cfg.provider = providers
  if (opts.setDefault && profile.defaultModel) {
    cfg.model = `${profile.id}/${profile.defaultModel}`
  }
  const bak = backup(configPath)
  writeJson(configPath, cfg)
  return {
    message: `已写入供应商 ${profile.id}${opts.setDefault && profile.defaultModel ? `，默认模型设为 ${cfg.model}` : ''}`,
    backupPath: bak || undefined
  }
}

const opencodeApplier: Applier = {
  agentId: 'opencode',
  agentName: 'OpenCode',
  support: 'full',
  configPath: join(HOME, '.config/opencode/opencode.jsonc'),
  current() {
    return opencodeCurrent(this.configPath)
  },
  apply(profile, opts) {
    return opencodeApply(this.configPath, profile, opts, true)
  }
}

const loomyApplier: Applier = {
  agentId: 'loomy',
  agentName: 'Loomy OpenCode',
  support: 'full',
  configPath: join(HOME, '.config/loomy-opencode/opencode.json'),
  current() {
    return opencodeCurrent(this.configPath)
  },
  apply(profile, opts) {
    return opencodeApply(this.configPath, profile, opts, false)
  }
}

// ---------- ycli：~/.ycli/config.yaml 单供应商 ----------

const ycliApplier: Applier = {
  agentId: 'ycli',
  agentName: 'ycli',
  support: 'full',
  note: '单供应商配置，写入会替换当前 provider/model/api_key/base_url（已自动备份）',
  configPath: join(HOME, '.ycli/config.yaml'),
  current() {
    const cfg = readYaml<{ provider?: string; model?: string; base_url?: string }>(this.configPath)
    return cfg?.provider ? `${cfg.provider} / ${cfg.model || '?'}（${cfg.base_url || '?'}）` : '未配置'
  },
  apply(profile) {
    const cfg = (readYaml<Record<string, unknown>>(this.configPath) || {}) as Record<string, unknown>
    cfg.provider = 'openai'
    cfg.model = profile.defaultModel || profile.models[0]?.id
    cfg.api_key = profile.apiKey
    cfg.base_url = profile.baseURL
    const bak = backup(this.configPath)
    writeYaml(this.configPath, cfg)
    return { message: `已写入 provider=${cfg.provider}, model=${String(cfg.model)}`, backupPath: bak || undefined }
  }
}

// ---------- DSH：settings.yaml，API key 走环境变量 ----------

const dshApplier: Applier = {
  agentId: 'dsh',
  agentName: 'DSH',
  support: 'partial',
  note: 'DSH 通过环境变量读取 API key：写入后需设置环境变量并在启动 DSH 前导出',
  configPath: join(HOME, '.dsh/settings.yaml'),
  current() {
    const cfg = readYaml<{ 'llm-pi-ai'?: { providers?: Record<string, unknown> }; 'agent-default-model'?: { provider?: string; model?: string } }>(this.configPath)
    const ids = Object.keys(cfg?.['llm-pi-ai']?.providers || {})
    const def = cfg?.['agent-default-model']
    return ids.length ? `${ids.join('、')}${def?.provider ? `（默认 ${def.provider}/${def.model}）` : ''}` : '未配置自定义供应商'
  },
  apply(profile, opts) {
    const envName = `AGENTMGR_${profile.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`
    const cfg = (readYaml<Record<string, unknown>>(this.configPath) || {}) as Record<string, unknown>
    const llm = (cfg['llm-pi-ai'] as Record<string, unknown>) || {}
    const providers = (llm.providers as Record<string, unknown>) || {}
    providers[profile.id] = {
      displayName: profile.name,
      apiKeyEnv: envName,
      api: 'openai-completions',
      baseURL: profile.baseURL,
      models: profile.models.map((m) => ({
        id: m.id,
        ...(m.name ? { name: m.name } : {}),
        ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
        ...(m.maxTokens ? { maxTokens: m.maxTokens } : {})
      }))
    }
    llm.providers = providers
    cfg['llm-pi-ai'] = llm
    if (opts.setDefault && profile.defaultModel) {
      cfg['agent-default-model'] = { provider: profile.id, model: profile.defaultModel }
    }
    const bak = backup(this.configPath)
    writeYaml(this.configPath, cfg)
    return {
      message: `已写入供应商 ${profile.id}；请设置环境变量 ${envName}=${profile.apiKey.slice(0, 4)}… 后重启 DSH 生效`,
      backupPath: bak || undefined
    }
  }
}

// ---------- 不支持的智能体（配置存在应用内部数据库，无法安全写入） ----------

const UNSUPPORTED: { agentId: string; agentName: string; color: string; note: string }[] = [
  { agentId: 'trae-cn', agentName: 'Trae CN', color: '#ef4444', note: '模型配置存在应用内部数据库，无法安全写入' },
  { agentId: 'qoder', agentName: 'Qoder', color: '#f59e0b', note: '模型配置由应用账号体系管理' },
  { agentId: 'codebuddy', agentName: 'CodeBuddy', color: '#3b82f6', note: '模型配置存在应用内部数据库' },
  { agentId: 'workbuddy', agentName: 'WorkBuddy', color: '#10b981', note: '模型配置存在应用内部数据库' },
  { agentId: 'agnes', agentName: 'AgnesCode', color: '#ec4899', note: '使用平台内置 OAuth 供应商体系' }
]

const APPLIERS: Applier[] = [zcodeApplier, opencodeApplier, loomyApplier, ycliApplier, dshApplier]

export function listAppliers(): ApplierInfo[] {
  const out: ApplierInfo[] = []
  for (const a of APPLIERS) {
    const installed = exists(a.configPath)
    let current = '未检测到配置文件'
    if (installed) {
      try {
        current = a.current()
      } catch {
        current = '读取失败'
      }
    }
    out.push({
      agentId: a.agentId,
      agentName: a.agentName,
      color: applierColor(a.agentId),
      support: installed ? a.support : 'none',
      note: installed ? a.note : '未检测到该智能体',
      current
    })
  }
  for (const u of UNSUPPORTED) {
    out.push({ agentId: u.agentId, agentName: u.agentName, color: u.color, support: 'none', note: u.note, current: '—' })
  }
  return out
}

function applierColor(agentId: string): string {
  const colors: Record<string, string> = {
    zcode: '#6366f1',
    opencode: '#f97316',
    loomy: '#06b6d4',
    ycli: '#64748b',
    dsh: '#8b5cf6'
  }
  return colors[agentId] || '#64748b'
}

export function applyProfile(
  profile: ModelProfile,
  agentIds: string[],
  opts: ApplyOptions
): ApplyResult[] {
  const results: ApplyResult[] = []
  for (const agentId of agentIds) {
    const applier = APPLIERS.find((a) => a.agentId === agentId)
    if (!applier) {
      results.push({ agentId, agentName: agentId, ok: false, message: '不支持自动配置' })
      continue
    }
    if (!exists(applier.configPath)) {
      results.push({ agentId, agentName: applier.agentName, ok: false, message: '未检测到配置文件' })
      continue
    }
    try {
      const r = applier.apply(profile, opts)
      // 写后回读校验，确保配置文件仍可解析
      if (applier.configPath.endsWith('.json') || applier.configPath.endsWith('.jsonc')) {
        const check = readJsonc(applier.configPath)
        if (!check) throw new Error('写入后配置文件解析失败（已保留备份）')
      }
      results.push({
        agentId,
        agentName: applier.agentName,
        ok: true,
        message: r.message,
        backupPath: r.backupPath
      })
    } catch (err) {
      results.push({
        agentId,
        agentName: applier.agentName,
        ok: false,
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }
  return results
}
