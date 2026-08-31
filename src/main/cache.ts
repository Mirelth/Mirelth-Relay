import Database from 'better-sqlite3'
import { join } from 'path'
import type { AgentDetail, AgentInfo, McpServer, SkillInfo, TokenRecord } from '@shared/types'
import type { AgentSnapshot } from './scanner/types'

/**
 * 扫描结果缓存库。每次全量扫描后整体重建各表，
 * IPC 查询一律走这里，保证界面读取快速且稳定。
 */
export class CacheStore {
  private db: Database.Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists meta (key text primary key, value text);
      create table if not exists agents (
        id text primary key,
        name text, vendor text, version text, kind text,
        detected integer, skill_count integer, mcp_count integer,
        has_usage integer, project_count integer, color text,
        detail_json text, install_state text not null default 'unknown'
      );
      create table if not exists skills (
        id text primary key, agent_id text, name text, version text,
        description text, installed_at text, source text, builtin integer
      );
      create index if not exists skills_agent on skills(agent_id);
      create table if not exists mcp (
        id text primary key, agent_id text, name text, transport text,
        endpoint text, enabled integer, tools_json text,
        status text, status_detail text, last_checked text
      );
      create table if not exists usage (
        agent_id text, ts integer, model text,
        input_tokens integer, output_tokens integer,
        cache_read integer, cache_write integer, reasoning integer,
        requests integer, cost real
      );
      create index if not exists usage_ts on usage(ts);
      create index if not exists usage_model on usage(model);
      create table if not exists projects (agent_id text, path text);
      create table if not exists scan_log (agent_id text, at integer, ok integer, error text);
    `)
    // 旧库升级：agents 表补 install_state 列（重复执行报 duplicate column，忽略）
    try {
      this.db.exec(`alter table agents add column install_state text not null default 'unknown'`)
    } catch {
      /* 列已存在 */
    }
  }

  /** 用一次扫描的快照替换对应 agent 的全部缓存 */
  saveSnapshot(snap: AgentSnapshot): void {
    const tx = this.db.transaction(() => {
      const info = snap.info
      this.db.prepare('delete from agents where id = ?').run(info.id)
      this.db.prepare('delete from skills where agent_id = ?').run(info.id)
      this.db.prepare('delete from mcp where agent_id = ?').run(info.id)
      this.db.prepare('delete from usage where agent_id = ?').run(info.id)
      this.db.prepare('delete from projects where agent_id = ?').run(info.id)

      this.db
        .prepare(
          `insert into agents (id, name, vendor, version, kind, detected, skill_count, mcp_count, has_usage, project_count, color, detail_json, install_state)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          info.id,
          info.name,
          info.vendor || null,
          info.version || null,
          info.kind,
          info.detected ? 1 : 0,
          snap.skills.length,
          snap.mcpServers.length,
          snap.usage.length > 0 ? 1 : 0,
          snap.projectDirs.length,
          info.color,
          JSON.stringify({
            configs: snap.configs,
            dataDirs: snap.dataDirs,
            projectDirs: snap.projectDirs
          }),
          info.installState || 'unknown'
        )

      const insSkill = this.db.prepare(
        `insert or replace into skills (id, agent_id, name, version, description, installed_at, source, builtin)
         values (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      for (const s of snap.skills) {
        insSkill.run(
          s.id,
          s.agentId,
          s.name,
          s.version || null,
          s.description || null,
          s.installedAt || null,
          s.source,
          s.builtin ? 1 : 0
        )
      }

      const insMcp = this.db.prepare(
        `insert or replace into mcp (id, agent_id, name, transport, endpoint, enabled, tools_json, status, status_detail, last_checked)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      for (const m of snap.mcpServers) {
        insMcp.run(
          `${snap.info.id}:${m.name}`,
          snap.info.id,
          m.name,
          m.transport,
          m.endpoint || null,
          m.enabled ? 1 : 0,
          JSON.stringify(m.tools || []),
          m.status || 'unverified',
          m.statusDetail || null,
          null
        )
      }

      const insUsage = this.db.prepare(
        `insert into usage (agent_id, ts, model, input_tokens, output_tokens, cache_read, cache_write, reasoning, requests, cost)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      for (const u of snap.usage) {
        insUsage.run(
          snap.info.id,
          Math.floor(u.ts),
          u.model,
          u.inputTokens,
          u.outputTokens,
          u.cacheReadTokens,
          u.cacheWriteTokens,
          u.reasoningTokens,
          u.requests,
          u.costUsd ?? null
        )
      }

      const insProj = this.db.prepare('insert into projects (agent_id, path) values (?, ?)')
      for (const p of snap.projectDirs) insProj.run(snap.info.id, p)

      this.db
        .prepare('insert or replace into scan_log (agent_id, at, ok, error) values (?, ?, 1, null)')
        .run(snap.info.id, Date.now())

      this.db
        .prepare('insert or replace into meta (key, value) values (?, ?)')
        .run('lastScanAt', String(Date.now()))
    })
    tx()
  }

  /** MCP 健康检查结果回写 */
  updateMcpStatus(
    id: string,
    status: string,
    statusDetail: string | null,
    tools: { name: string; description?: string }[]
  ): void {
    this.db
      .prepare(
        'update mcp set status = ?, status_detail = ?, tools_json = ?, last_checked = ? where id = ?'
      )
      .run(status, statusDetail, JSON.stringify(tools), new Date().toISOString(), id)
  }

  listAgents(): AgentInfo[] {
    const rows = this.db
      .prepare(
        `select id, name, vendor, version, kind, detected, skill_count, mcp_count, has_usage, project_count, color, install_state
         from agents order by detected desc, skill_count + mcp_count desc, name`
      )
      .all() as Record<string, unknown>[]
    return rows.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      vendor: (r.vendor as string) || undefined,
      version: (r.version as string) || undefined,
      kind: r.kind as AgentInfo['kind'],
      detected: r.detected === 1,
      installState: (r.install_state as AgentInfo['installState']) || 'unknown',
      skillCount: r.skill_count as number,
      mcpCount: r.mcp_count as number,
      hasUsage: r.has_usage === 1,
      projectCount: r.project_count as number,
      color: r.color as string
    }))
  }

  getAgentDetail(id: string): AgentDetail | null {
    const row = this.db.prepare('select detail_json from agents where id = ?').get(id) as
      { detail_json: string } | undefined
    if (!row) return null
    const parsed = JSON.parse(row.detail_json) as {
      configs: AgentDetail['configs']
      dataDirs: AgentDetail['dataDirs']
      projectDirs: string[]
    }
    const info = this.listAgents().find((a) => a.id === id)
    if (!info) return null
    return {
      info,
      configs: parsed.configs || [],
      dataDirs: parsed.dataDirs || [],
      skills: this.listSkills({ agentId: id }),
      mcpServers: this.listMcp(id),
      projectDirs: parsed.projectDirs || []
    }
  }

  listSkills(filter: { search?: string; agentId?: string } = {}): SkillInfo[] {
    const conds: string[] = []
    const params: unknown[] = []
    if (filter.agentId) {
      conds.push('agent_id = ?')
      params.push(filter.agentId)
    }
    if (filter.search) {
      conds.push('(name like ? or ifnull(description,"") like ?)')
      const like = `%${filter.search}%`
      params.push(like, like)
    }
    const where = conds.length ? `where ${conds.join(' and ')}` : ''
    const rows = this.db
      .prepare(
        `select id, agent_id, name, version, description, installed_at, source, builtin
         from skills ${where} order by agent_id, name`
      )
      .all(...params) as Record<string, unknown>[]
    return rows.map((r) => ({
      id: r.id as string,
      agentId: r.agent_id as string,
      name: r.name as string,
      version: (r.version as string) || undefined,
      description: (r.description as string) || undefined,
      installedAt: (r.installed_at as string) || undefined,
      source: r.source as string,
      builtin: r.builtin === 1
    }))
  }

  listMcp(agentId?: string): McpServer[] {
    const where = agentId ? 'where agent_id = ?' : ''
    const params = agentId ? [agentId] : []
    const rows = this.db
      .prepare(
        `select id, agent_id, name, transport, endpoint, enabled, tools_json,
                status, status_detail, last_checked
         from mcp ${where} order by agent_id, name`
      )
      .all(...params) as Record<string, unknown>[]
    return rows.map((r) => ({
      id: r.id as string,
      agentId: r.agent_id as string,
      name: r.name as string,
      transport: r.transport as McpServer['transport'],
      endpoint: (r.endpoint as string) || undefined,
      enabled: r.enabled === 1,
      tools: JSON.parse((r.tools_json as string) || '[]'),
      status: r.status as McpServer['status'],
      statusDetail: (r.status_detail as string) || undefined,
      lastChecked: (r.last_checked as string) || undefined
    }))
  }

  /** token 用量原始记录（明细表用） */
  tokenRecords(filter: {
    model?: string
    agentId?: string
    since?: number
    until?: number
    limit?: number
  }): TokenRecord[] {
    const conds: string[] = []
    const params: unknown[] = []
    if (filter.model) {
      conds.push('model = ?')
      params.push(filter.model)
    }
    if (filter.agentId) {
      conds.push('agent_id = ?')
      params.push(filter.agentId)
    }
    if (filter.since != null) {
      conds.push('ts >= ?')
      params.push(filter.since)
    }
    if (filter.until != null) {
      conds.push('ts <= ?')
      params.push(filter.until)
    }
    const where = conds.length ? `where ${conds.join(' and ')}` : ''
    const rows = this.db
      .prepare(
        `select agent_id, ts, model, input_tokens, output_tokens, cache_read, cache_write, reasoning, requests, cost
         from usage ${where} order by ts desc limit ?`
      )
      .all(...params, filter.limit ?? 2000) as Record<string, unknown>[]
    return rows.map((r) => ({
      agentId: r.agent_id as string,
      ts: new Date(r.ts as number).toISOString(),
      model: r.model as string,
      inputTokens: r.input_tokens as number,
      outputTokens: r.output_tokens as number,
      cacheReadTokens: r.cache_read as number,
      cacheWriteTokens: r.cache_write as number,
      reasoningTokens: r.reasoning as number,
      requests: r.requests as number,
      costUsd: (r.cost as number) ?? undefined
    }))
  }

  /** 按维度聚合 token 用量（返回数据库原始字段名） */
  tokenAggregate(
    dimension: 'agent' | 'model' | 'day',
    filter: { model?: string; agentId?: string; since?: number; until?: number }
  ): {
    key: string
    input_tokens: number
    output_tokens: number
    cache_read: number
    cache_write: number
    reasoning: number
    total_tokens: number
    requests: number
    cost: number
  }[] {
    const groupExpr =
      dimension === 'agent'
        ? 'agent_id'
        : dimension === 'model'
          ? 'model'
          : "date(ts/1000, 'unixepoch', 'localtime')"
    const conds: string[] = []
    const params: unknown[] = []
    if (filter.model) {
      conds.push('model = ?')
      params.push(filter.model)
    }
    if (filter.agentId) {
      conds.push('agent_id = ?')
      params.push(filter.agentId)
    }
    if (filter.since != null) {
      conds.push('ts >= ?')
      params.push(filter.since)
    }
    if (filter.until != null) {
      conds.push('ts <= ?')
      params.push(filter.until)
    }
    const where = conds.length ? `where ${conds.join(' and ')}` : ''
    return this.db
      .prepare(
        `select ${groupExpr} as key,
                sum(input_tokens) input_tokens, sum(output_tokens) output_tokens,
                sum(cache_read) cache_read, sum(cache_write) cache_write,
                sum(reasoning) reasoning,
                sum(input_tokens + output_tokens + cache_read + cache_write + reasoning) total_tokens,
                sum(requests) requests, sum(ifnull(cost,0)) cost
         from usage ${where}
         group by ${groupExpr}
         order by ${dimension === 'day' ? 'key' : 'total_tokens desc'}`
      )
      .all(...params) as {
      key: string
      input_tokens: number
      output_tokens: number
      cache_read: number
      cache_write: number
      reasoning: number
      total_tokens: number
      requests: number
      cost: number
    }[]
  }

  /** 按维度 × 模型双键聚合（成本估算用：同一天/同一智能体下不同模型单价不同） */
  tokenAggregateByModel(
    dimension: 'agent' | 'model' | 'day',
    filter: { model?: string; agentId?: string; since?: number; until?: number }
  ): {
    key: string
    model: string
    input_tokens: number
    output_tokens: number
    cache_read: number
    cache_write: number
    reasoning: number
    total_tokens: number
    requests: number
    cost: number
  }[] {
    const groupExpr =
      dimension === 'agent'
        ? 'agent_id'
        : dimension === 'model'
          ? 'model'
          : "date(ts/1000, 'unixepoch', 'localtime')"
    const conds: string[] = []
    const params: unknown[] = []
    if (filter.model) {
      conds.push('model = ?')
      params.push(filter.model)
    }
    if (filter.agentId) {
      conds.push('agent_id = ?')
      params.push(filter.agentId)
    }
    if (filter.since != null) {
      conds.push('ts >= ?')
      params.push(filter.since)
    }
    if (filter.until != null) {
      conds.push('ts <= ?')
      params.push(filter.until)
    }
    const where = conds.length ? `where ${conds.join(' and ')}` : ''
    return this.db
      .prepare(
        `select ${groupExpr} as key, model,
                sum(input_tokens) input_tokens, sum(output_tokens) output_tokens,
                sum(cache_read) cache_read, sum(cache_write) cache_write,
                sum(reasoning) reasoning,
                sum(input_tokens + output_tokens + cache_read + cache_write + reasoning) total_tokens,
                sum(requests) requests, sum(ifnull(cost,0)) cost
         from usage ${where}
         group by ${groupExpr}, model`
      )
      .all(...params) as ReturnType<CacheStore['tokenAggregateByModel']>
  }

  /** 删除不在给定 id 列表内的智能体及其派生数据（适配器拆分/改名后清理陈旧行） */
  deleteAgentsExcept(ids: string[]): number {
    if (ids.length === 0) return 0
    const placeholders = ids.map(() => '?').join(',')
    const info = this.db.prepare(`delete from agents where id not in (${placeholders})`).run(...ids)
    this.db.prepare(`delete from skills where agent_id not in (${placeholders})`).run(...ids)
    this.db.prepare(`delete from mcp where agent_id not in (${placeholders})`).run(...ids)
    this.db.prepare(`delete from usage where agent_id not in (${placeholders})`).run(...ids)
    this.db.prepare(`delete from projects where agent_id not in (${placeholders})`).run(...ids)
    this.db.prepare(`delete from scan_log where agent_id not in (${placeholders})`).run(...ids)
    return info.changes
  }

  /** 全部项目目录及其来源智能体 */
  projectRepos(): { path: string; agentIds: string[] }[] {
    const rows = this.db.prepare('select agent_id, path from projects').all() as {
      agent_id: string
      path: string
    }[]
    const map = new Map<string, Set<string>>()
    for (const r of rows) {
      if (!map.has(r.path)) map.set(r.path, new Set())
      map.get(r.path)!.add(r.agent_id)
    }
    return [...map.entries()].map(([path, agents]) => ({ path, agentIds: [...agents] }))
  }

  dashboardNumbers(): {
    todayTokens: number
    yesterdayTokens: number
    last7dTokens: number
    topAgents: { agentId: string; totalTokens: number }[]
    topModels: { model: string; totalTokens: number }[]
  } {
    const now = new Date()
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const startOfYesterday = startOfToday - 86400_000
    const start7d = startOfToday - 6 * 86400_000
    const sum = (sql: string, ...params: unknown[]): number =>
      (this.db.prepare(sql).get(...params) as { t: number | null } | undefined)?.t ?? 0
    const todayTokens = sum(
      `select sum(input_tokens + output_tokens + cache_read + cache_write + reasoning) t from usage where ts >= ?`,
      startOfToday
    )
    const yesterdayTokens = sum(
      `select sum(input_tokens + output_tokens + cache_read + cache_write + reasoning) t from usage where ts >= ? and ts < ?`,
      startOfYesterday,
      startOfToday
    )
    const last7dTokens = sum(
      `select sum(input_tokens + output_tokens + cache_read + cache_write + reasoning) t from usage where ts >= ?`,
      start7d
    )
    const topAgents = (
      this.db
        .prepare(
          `select agent_id, sum(input_tokens + output_tokens + cache_read + cache_write + reasoning) t
           from usage group by agent_id order by t desc limit 6`
        )
        .all() as { agent_id: string; t: number }[]
    ).map((r) => ({ agentId: r.agent_id, totalTokens: r.t }))
    const topModels = (
      this.db
        .prepare(
          `select model, sum(input_tokens + output_tokens + cache_read + cache_write + reasoning) t
           from usage group by model order by t desc limit 8`
        )
        .all() as { model: string; t: number }[]
    ).map((r) => ({ model: r.model, totalTokens: r.t }))
    return { todayTokens, yesterdayTokens, last7dTokens, topAgents, topModels }
  }

  counts(): {
    agents: number
    installedAgents: number
    residualAgents: number
    skills: number
    mcp: number
    mcpOnline: number
    mcpOffline: number
    repos: number
  } {
    const one = (sql: string): number => (this.db.prepare(sql).get() as { c: number }).c
    return {
      agents: one(`select count(*) c from agents where detected = 1`),
      installedAgents: one(`select count(*) c from agents where detected = 1 and install_state = 'installed'`),
      residualAgents: one(`select count(*) c from agents where detected = 1 and install_state = 'residual'`),
      skills: one(`select count(*) c from skills`),
      mcp: one(`select count(*) c from mcp`),
      mcpOnline: one(`select count(*) c from mcp where status = 'online'`),
      mcpOffline: one(`select count(*) c from mcp where status = 'offline'`),
      repos: one(`select count(distinct path) c from projects`)
    }
  }

  metaGet(key: string): string | null {
    const row = this.db.prepare('select value from meta where key = ?').get(key) as
      { value: string } | undefined
    return row?.value ?? null
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('insert or replace into meta (key, value) values (?, ?)').run(key, value)
  }
}

let store: CacheStore | null = null

export function getStore(): CacheStore {
  if (!store) {
    // 延迟 import 避免 app 未就绪

    const { app } = require('electron') as typeof import('electron')
    store = new CacheStore(join(app.getPath('userData'), 'cache.sqlite'))
  }
  return store
}
