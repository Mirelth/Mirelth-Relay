import { ipcMain } from 'electron'
import type {
  AgentDetail,
  AgentInfo,
  CommitInfo,
  DashboardSummary,
  GitFilter,
  McpServer,
  RefreshOptions,
  SkillInfo,
  TokenDimension,
  TokenDetailQuery,
  TokenRecord,
  TokenSeries,
  TokenStatsResult
} from '@shared/types'
import { getStore } from './cache'
import { refreshAndRecord } from './engine'
import { checkAllMcp, checkMcpHealth } from './mcp-health'
import { getCommitDetail, listCommits } from './gitlog'
import { applyProfile, listAppliers } from './models/appliers'
import { createHook, deleteHook, listHookTargets, listHooks } from './hooks'
import { copySkill, listSkillCopyTargets } from './skills-copy'
import { ModelStore, toView } from './models/store'
import { join } from 'path'
import type { ApplyOptions, ModelProfile } from '@shared/types'

function timeRangeToEpoch(query?: TokenDetailQuery): { since?: number; until?: number } {
  return {
    since: query?.since ? Date.parse(query.since) : undefined,
    until: query?.until ? Date.parse(query.until) : undefined
  }
}

function toSeries(rows: { key: string; input_tokens: number; output_tokens: number; cache_read: number; cache_write: number; reasoning: number; total_tokens: number; requests: number; cost: number }[]): TokenSeries[] {
  return rows.map((r) => ({
    key: r.key,
    inputTokens: r.input_tokens || 0,
    outputTokens: r.output_tokens || 0,
    cacheReadTokens: r.cache_read || 0,
    cacheWriteTokens: r.cache_write || 0,
    reasoningTokens: r.reasoning || 0,
    totalTokens: r.total_tokens || 0,
    requests: r.requests || 0,
    costUsd: r.cost || 0
  }))
}

export function registerIpc(): void {
  ipcMain.handle('agents:scan', (): AgentInfo[] => getStore().listAgents())

  ipcMain.handle('agents:detail', (_e, id: string): AgentDetail | null => getStore().getAgentDetail(id))

  ipcMain.handle('skills:list', (_e, filter): SkillInfo[] => getStore().listSkills(filter || {}))

  ipcMain.handle('mcp:list', (_e, agentId?: string): McpServer[] => getStore().listMcp(agentId))

  ipcMain.handle('mcp:check', async (_e, serverId: string): Promise<McpServer[]> => {
    await checkMcpHealth(serverId)
    return getStore().listMcp()
  })

  ipcMain.handle('mcp:checkAll', async (_e, agentId?: string): Promise<McpServer[]> => {
    await checkAllMcp(agentId)
    return getStore().listMcp(agentId)
  })

  ipcMain.handle('git:commits', async (_e, filter?: GitFilter): Promise<CommitInfo[]> => listCommits(filter || {}))

  ipcMain.handle('git:commitDetail', async (_e, commitId: string): Promise<CommitInfo | null> => getCommitDetail(commitId))

  ipcMain.handle(
    'tokens:stats',
    async (_e, dimension: TokenDimension, query?: TokenDetailQuery): Promise<TokenStatsResult> => {
      const store = getStore()
      const range = timeRangeToEpoch(query)
      const main = toSeries(store.tokenAggregate(dimension, range))
      const daily = toSeries(store.tokenAggregate('day', range))
      const totalRows = toSeries([{ key: 'total', input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, reasoning: 0, total_tokens: 0, requests: 0, cost: 0 }])
      const total = main.reduce(
        (acc, s) => {
          acc.inputTokens += s.inputTokens
          acc.outputTokens += s.outputTokens
          acc.cacheReadTokens += s.cacheReadTokens
          acc.cacheWriteTokens += s.cacheWriteTokens
          acc.reasoningTokens += s.reasoningTokens
          acc.totalTokens += s.totalTokens
          acc.requests += s.requests
          acc.costUsd += s.costUsd
          return acc
        },
        totalRows[0]
      )
      const modelList = store.tokenAggregate('model', range).map((r) => r.key)
      return { dimension, series: main, daily, total, models: modelList }
    }
  )

  ipcMain.handle('tokens:records', (_e, query?: TokenDetailQuery): TokenRecord[] =>
    getStore().tokenRecords({ ...timeRangeToEpoch(query), model: query?.model, agentId: query?.agentId, limit: 2000 })
  )

  ipcMain.handle('dashboard', (): DashboardSummary => {
    const store = getStore()
    const counts = store.counts()
    const nums = store.dashboardNumbers()
    const agentNames = new Map(store.listAgents().map((a) => [a.id, a.name]))
    return {
      agentCount: counts.agents,
      skillCount: counts.skills,
      mcpTotal: counts.mcp,
      mcpOnline: counts.mcpOnline,
      mcpOffline: counts.mcpOffline,
      todayTokens: nums.todayTokens,
      yesterdayTokens: nums.yesterdayTokens,
      last7dTokens: nums.last7dTokens,
      lastScanAt: store.metaGet('lastScanAt') ? new Date(Number(store.metaGet('lastScanAt'))).toISOString() : undefined,
      repoCount: counts.repos,
      commitCount7d: 0, // 列表页实时计算，仪表盘不额外拉 git
      topAgents: nums.topAgents.map((a) => ({ agentId: a.agentId, name: agentNames.get(a.agentId) || a.agentId, totalTokens: a.totalTokens })),
      topModels: nums.topModels
    }
  })

  ipcMain.handle('app:refresh', async (_e, options?: RefreshOptions) => {
    const result = await refreshAndRecord(options?.agentId)
    // 扫描后自动做一轮 MCP 健康检查
    await checkAllMcp()
    return result
  })

  let modelStore: ModelStore | null = null
  const getModelStore = (): ModelStore => {
    if (!modelStore) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { app } = require('electron') as typeof import('electron')
      modelStore = new ModelStore(join(app.getPath('userData'), 'model-profiles.json'))
    }
    return modelStore
  }

  ipcMain.handle('models:list', () => getModelStore().list().map(toView))

  ipcMain.handle('models:save', (_e, profile: ModelProfile) => {
    // apiKey 留空表示沿用已有 key
    const existing = getModelStore().get(profile.id)
    if (!profile.apiKey && existing) profile.apiKey = existing.apiKey
    getModelStore().upsert(profile)
  })

  ipcMain.handle('models:delete', (_e, id: string) => getModelStore().remove(id))

  ipcMain.handle('models:appliers', () => listAppliers())

  ipcMain.handle('models:apply', (_e, profileId: string, agentIds: string[], options?: ApplyOptions) => {
    const profile = getModelStore().get(profileId)
    if (!profile) throw new Error('模型 Profile 不存在')
    return applyProfile(profile, agentIds, options || {})
  })

  ipcMain.handle('hooks:list', () => listHooks())

  ipcMain.handle('hooks:targets', () => listHookTargets())

  ipcMain.handle('hooks:create', (_e, input) => createHook(input))

  ipcMain.handle('hooks:delete', (_e, hookId: string) => deleteHook(hookId))

  ipcMain.handle('skills:copyTargets', () => listSkillCopyTargets())

  ipcMain.handle('skills:copy', (_e, skillId: string, agentIds: string[], overwrite?: boolean) =>
    copySkill(skillId, agentIds, overwrite)
  )

  ipcMain.handle('app:lastScan', () => {
    const store = getStore()
    const at = store.metaGet('lastScanAt')
    return {
      at: at ? new Date(Number(at)).toISOString() : undefined,
      agents: (store.metaGet('scannedAgents') ? JSON.parse(store.metaGet('scannedAgents') as string) : []) as string[]
    }
  })
}
