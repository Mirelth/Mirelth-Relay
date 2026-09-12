import { app, dialog, ipcMain, shell, BrowserWindow } from 'electron'
import type {
  AgentDetail,
  AgentInfo,
  CommitInfo,
  CostInfo,
  DashboardSummary,
  ExportSaveOptions,
  ExportSaveResult,
  GitFilter,
  McpServer,
  PriceConfig,
  RefreshOptions,
  RepoSecurityScanResult,
  SecurityScanResult,
  GwGatewayView,
  GwRequestLogEntry,
  GwSimulationResult,
  SkillInfo,
  TokenDimension,
  TokenDetailQuery,
  TokenRecord,
  TokenSeries,
  TokenStatsResult,
  UpdateInfo
} from '@shared/types'
import { getStore } from './cache'
import { refreshAndRecord } from './engine'
import { checkAllMcp, checkMcpHealth } from './mcp-health'
import { getCommitDetail, listCommits } from './gitlog'
import { applyProfile, listAppliers } from './models/appliers'
import { createHook, deleteHook, listHookTargets, listHooks } from './hooks'
import { copySkill, listSkillCopyTargets } from './skills-copy'
import { ModelStore, toView } from './models/store'
import { aggregateCost, DEFAULT_PRICES, PricingStore } from './pricing'
import { checkForUpdate } from './updater'
import { collectAgentFiles, runSecurityScan } from './security'
import { runRepoSecurityScan } from './repo-security'
import {
  gwView,
  gwUpdate,
  gwStart,
  gwStop,
  gwRegenerateKey,
  gwRevealKey,
  gwLogs,
  gwSimulate,
  gwTestModel
} from './llmgw'
import { compareAndNotify, notifyUpdateAvailable } from './alerts'
import { join } from 'path'
import { writeFileSync } from 'fs'
import type { ApplyOptions, ModelProfile } from '@shared/types'
import type { Task, AgentConstraint } from '@shared/task-types'
import {
  getRepoStatus,
  addRemote,
  getSkillContent,
  getRuleContent,
  saveSkill,
  saveRule
} from './team-repo'
import {
  getSyncConfig,
  saveSyncConfig,
  initSync,
  syncPush,
  syncPull,
  getTeamSkillsSummary,
  getTeamRulesSummary
} from './sync-engine'
import {
  getTasks,
  getTask,
  createTask,
  updateTaskStatus,
  decomposeTask,
  assignSubTask,
  executeSubTask,
  monitorExecution,
  cancelTask,
  getReadyTasks
} from './execution-engine'
import {
  getQueueStatus,
  enqueue,
  pauseQueue,
  resumeQueue,
  clearQueue,
  getQueuedTaskIds
} from './task-queue'
import {
  getConstraints,
  addConstraint,
  updateConstraint,
  deleteConstraint,
  getAgentConstraints,
  validateConstraints
} from './constraints'
import {
  getTrustScores,
  getAgentTrustScore,
  updateTrustScore,
  getFrictionPointStats,
  rankAgentsByTrust
} from './trust-scoring'

function timeRangeToEpoch(query?: TokenDetailQuery): { since?: number; until?: number } {
  return {
    since: query?.since ? Date.parse(query.since) : undefined,
    until: query?.until ? Date.parse(query.until) : undefined
  }
}

function toSeries(
  rows: {
    key: string
    input_tokens: number
    output_tokens: number
    cache_read: number
    cache_write: number
    reasoning: number
    total_tokens: number
    requests: number
    cost: number
  }[],
  costByKey?: Map<string, number>
): TokenSeries[] {
  return rows.map((r) => ({
    key: r.key,
    inputTokens: r.input_tokens || 0,
    outputTokens: r.output_tokens || 0,
    cacheReadTokens: r.cache_read || 0,
    cacheWriteTokens: r.cache_write || 0,
    reasoningTokens: r.reasoning || 0,
    totalTokens: r.total_tokens || 0,
    requests: r.requests || 0,
    costUsd: r.cost || 0,
    estCostCny: costByKey?.get(r.key) || 0
  }))
}

let modelStore: ModelStore | null = null
const getModelStore = (): ModelStore => {
  if (!modelStore) modelStore = new ModelStore(join(app.getPath('userData'), 'model-profiles.json'))
  return modelStore
}

let pricingStore: PricingStore | null = null
const getPricingStore = (): PricingStore => {
  if (!pricingStore)
    pricingStore = new PricingStore(join(app.getPath('userData'), 'model-pricing.json'))
  return pricingStore
}

/** 渲染进程可读写的环境设置键（存 meta 表） */
const SETTING_KEYS = new Set(['alertsEnabled', 'updateIgnoredVersion'])

export function registerIpc(): void {
  ipcMain.handle('agents:scan', (): AgentInfo[] => getStore().listAgents())

  ipcMain.handle('agents:detail', (_e, id: string): AgentDetail | null =>
    getStore().getAgentDetail(id)
  )

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

  ipcMain.handle('git:commits', async (_e, filter?: GitFilter): Promise<CommitInfo[]> =>
    listCommits(filter || {})
  )

  ipcMain.handle('git:commitDetail', async (_e, commitId: string): Promise<CommitInfo | null> =>
    getCommitDetail(commitId)
  )

  ipcMain.handle(
    'tokens:stats',
    async (_e, dimension: TokenDimension, query?: TokenDetailQuery): Promise<TokenStatsResult> => {
      const store = getStore()
      const range = timeRangeToEpoch(query)
      const cfg = getPricingStore().config()

      const mainRows = store.tokenAggregate(dimension, range)
      const dailyRows = dimension === 'day' ? mainRows : store.tokenAggregate('day', range)

      // 成本需要模型粒度：维度序列、按天序列各自聚合后按 key 分摊成本
      const dimCostRows = store.tokenAggregateByModel(dimension, range).map((r) => ({
        key: r.key,
        model: r.model,
        input: r.input_tokens || 0,
        output: r.output_tokens || 0,
        cacheRead: r.cache_read || 0,
        cacheWrite: r.cache_write || 0,
        reasoning: r.reasoning || 0,
        total: r.total_tokens || 0,
        reportedUsd: r.cost || 0
      }))
      const dailyCostRows =
        dimension === 'day'
          ? dimCostRows
          : store.tokenAggregateByModel('day', range).map((r) => ({
              key: r.key,
              model: r.model,
              input: r.input_tokens || 0,
              output: r.output_tokens || 0,
              cacheRead: r.cache_read || 0,
              cacheWrite: r.cache_write || 0,
              reasoning: r.reasoning || 0,
              total: r.total_tokens || 0,
              reportedUsd: r.cost || 0
            }))

      const dimCost = aggregateCost(dimCostRows, cfg)
      const dayCost = dimension === 'day' ? dimCost : aggregateCost(dailyCostRows, cfg)
      const modelCost =
        dimension === 'model'
          ? dimCost
          : aggregateCost(
              store.tokenAggregateByModel('model', range).map((r) => ({
                key: r.key,
                model: r.model,
                input: r.input_tokens || 0,
                output: r.output_tokens || 0,
                cacheRead: r.cache_read || 0,
                cacheWrite: r.cache_write || 0,
                reasoning: r.reasoning || 0,
                total: r.total_tokens || 0,
                reportedUsd: r.cost || 0
              })),
              cfg
            )

      const series = toSeries(mainRows, dimCost.byKey)
      const daily = toSeries(dimension === 'day' ? mainRows : dailyRows, dayCost.byKey)
      const zero = {
        key: 'total',
        input_tokens: 0,
        output_tokens: 0,
        cache_read: 0,
        cache_write: 0,
        reasoning: 0,
        total_tokens: 0,
        requests: 0,
        cost: 0
      }
      const total = toSeries([zero])[0]
      for (const s of series) {
        total.inputTokens += s.inputTokens
        total.outputTokens += s.outputTokens
        total.cacheReadTokens += s.cacheReadTokens
        total.cacheWriteTokens += s.cacheWriteTokens
        total.reasoningTokens += s.reasoningTokens
        total.totalTokens += s.totalTokens
        total.requests += s.requests
        total.costUsd += s.costUsd
        total.estCostCny += s.estCostCny
      }
      const costInfo: CostInfo = {
        totalCostCny: modelCost.totalCostCny,
        pricedTokens: modelCost.pricedTokens,
        totalTokens: modelCost.totalTokens,
        unpricedModels: modelCost.unpricedModels.slice(0, 20),
        rateUsdCny: cfg.rateUsdCny
      }
      return {
        dimension,
        series,
        daily,
        total,
        models: store.tokenAggregate('model', range).map((r) => r.key),
        costInfo
      }
    }
  )

  ipcMain.handle('tokens:records', (_e, query?: TokenDetailQuery): TokenRecord[] =>
    getStore().tokenRecords({
      ...timeRangeToEpoch(query),
      model: query?.model,
      agentId: query?.agentId,
      limit: 2000
    })
  )

  ipcMain.handle('dashboard', (): DashboardSummary => {
    const store = getStore()
    const counts = store.counts()
    const nums = store.dashboardNumbers()
    const agentNames = new Map(store.listAgents().map((a) => [a.id, a.name]))
    return {
      agentCount: counts.agents,
      installedAgents: counts.installedAgents,
      residualAgents: counts.residualAgents,
      skillCount: counts.skills,
      mcpTotal: counts.mcp,
      mcpOnline: counts.mcpOnline,
      mcpOffline: counts.mcpOffline,
      todayTokens: nums.todayTokens,
      yesterdayTokens: nums.yesterdayTokens,
      last7dTokens: nums.last7dTokens,
      lastScanAt: store.metaGet('lastScanAt')
        ? new Date(Number(store.metaGet('lastScanAt'))).toISOString()
        : undefined,
      repoCount: counts.repos,
      commitCount7d: 0, // 列表页实时计算，仪表盘不额外拉 git
      topAgents: nums.topAgents.map((a) => ({
        agentId: a.agentId,
        name: agentNames.get(a.agentId) || a.agentId,
        totalTokens: a.totalTokens
      })),
      topModels: nums.topModels
    }
  })

  ipcMain.handle('app:refresh', async (_e, options?: RefreshOptions) => {
    const result = await refreshAndRecord(options?.agentId)
    // 扫描后自动做一轮 MCP 健康检查，并做事件对比通知
    await checkAllMcp()
    compareAndNotify(getStore())
    return result
  })

  ipcMain.handle('models:list', () => getModelStore().list().map(toView))

  ipcMain.handle('models:save', (_e, profile: ModelProfile) => {
    // apiKey 留空表示沿用已有 key
    const existing = getModelStore().get(profile.id)
    if (!profile.apiKey && existing) profile.apiKey = existing.apiKey
    getModelStore().upsert(profile)
  })

  ipcMain.handle('models:delete', (_e, id: string) => getModelStore().remove(id))

  ipcMain.handle('models:appliers', () => listAppliers())

  // 拉取提供方可用模型目录：openai 兼容走 {base}/models，anthropic 兼容补 /v1 前缀
  ipcMain.handle(
    'models:catalog',
    async (_e, baseURL: string, apiKey: string, kind: ModelProfile['kind']) => {
      try {
        const base = baseURL.trim().replace(/\/+$/, '')
        const url =
          kind === 'anthropic' && !/\/v\d+$/.test(base) ? `${base}/v1/models` : `${base}/models`
        const headers: Record<string, string> =
          kind === 'anthropic'
            ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
            : apiKey
              ? { Authorization: `Bearer ${apiKey}` }
              : {}
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) })
        if (!res.ok) {
          return { models: [], error: `HTTP ${res.status} ${res.statusText}` }
        }
        const json: unknown = await res.json()
        const rows = Array.isArray(json) ? json : (json as { data?: unknown[] }).data
        const models = Array.isArray(rows)
          ? rows
              .map((m) => {
                const id = typeof m === 'string' ? m : (m as { id?: unknown })?.id
                return typeof id === 'string' ? id : ''
              })
              .filter(Boolean)
          : []
        return { models }
      } catch (err) {
        return { models: [], error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    'models:apply',
    (_e, profileId: string, agentIds: string[], options?: ApplyOptions) => {
      const profile = getModelStore().get(profileId)
      if (!profile) throw new Error('模型 Profile 不存在')
      return applyProfile(profile, agentIds, options || {})
    }
  )

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
      agents: (store.metaGet('scannedAgents')
        ? JSON.parse(store.metaGet('scannedAgents') as string)
        : []) as string[]
    }
  })

  // ---------- 检查更新 ----------

  ipcMain.handle('update:check', async (): Promise<UpdateInfo> => {
    const info = await checkForUpdate({
      current: app.getVersion(),
      ignored: getStore().metaGet('updateIgnoredVersion')
    })
    // 有新版本且该版本尚未通知过 → 弹一次系统通知
    const notified = getStore().metaGet('updateNotifiedVersion')
    if (info.hasUpdate && info.latest && notified !== info.latest) {
      notifyUpdateAvailable(info)
      getStore().setMeta('updateNotifiedVersion', info.latest)
    }
    return info
  })

  // ---------- 成本单价 ----------

  ipcMain.handle('pricing:get', (): PriceConfig => getPricingStore().config())

  ipcMain.handle('pricing:reset', () => {
    getPricingStore().save({ rateUsdCny: 7.2, prices: DEFAULT_PRICES })
  })

  ipcMain.handle('pricing:save', (_e, cfg: PriceConfig) => {
    if (!cfg || !Array.isArray(cfg.prices)) throw new Error('单价数据格式错误')
    const prices = cfg.prices
      .filter((p) => p && typeof p.model === 'string' && p.model.trim())
      .map((p) => ({
        model: p.model.trim().toLowerCase(),
        currency: p.currency === 'USD' ? ('USD' as const) : ('CNY' as const),
        inputPerM: Number(p.inputPerM) || 0,
        outputPerM: Number(p.outputPerM) || 0,
        ...(p.cacheReadPerM != null && Number(p.cacheReadPerM) > 0
          ? { cacheReadPerM: Number(p.cacheReadPerM) }
          : {}),
        ...(p.cacheWritePerM != null && Number(p.cacheWritePerM) > 0
          ? { cacheWritePerM: Number(p.cacheWritePerM) }
          : {})
      }))
    getPricingStore().save({
      rateUsdCny: Number(cfg.rateUsdCny) > 0 ? Number(cfg.rateUsdCny) : 7.2,
      prices
    })
  })

  // ---------- 安全体检 ----------

  ipcMain.handle('security:scan', (): SecurityScanResult => {
    const store = getStore()
    const files = collectAgentFiles(
      () => store.listAgents().filter((a) => a.detected),
      (id) => store.getAgentDetail(id)?.configs.map((c) => ({ path: c.path })) ?? []
    )
    return runSecurityScan(files)
  })

  ipcMain.handle('security:pickRepo', async (): Promise<string | null> => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
    const r = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
  })

  ipcMain.handle('security:repoScan', (_e, repoDir: string): Promise<RepoSecurityScanResult> => {
    if (typeof repoDir !== 'string' || repoDir.trim() === '') throw new Error('缺少仓库路径')
    return runRepoSecurityScan(repoDir)
  })

  // ---------- LLM 聚合网关 ----------

  ipcMain.handle('gw:get', (): GwGatewayView => gwView())
  ipcMain.handle(
    'gw:update',
    async (_e, patch): Promise<GwGatewayView> => await gwUpdate(patch ?? {})
  )
  ipcMain.handle('gw:start', async (): Promise<GwGatewayView> => await gwStart())
  ipcMain.handle('gw:stop', async (): Promise<GwGatewayView> => await gwStop())
  ipcMain.handle('gw:regenKey', (): GwGatewayView => gwRegenerateKey())
  ipcMain.handle('gw:revealKey', (): string => gwRevealKey())
  ipcMain.handle('gw:logs', (): GwRequestLogEntry[] => gwLogs())
  ipcMain.handle('gw:simulate', (_e, text: string, maxTokens?: number): GwSimulationResult =>
    gwSimulate(typeof text === 'string' ? text : '', Number(maxTokens) || 0)
  )
  ipcMain.handle('gw:testModel', async (_e, id: string) => await gwTestModel(String(id)))

  // ---------- 导出 ----------

  ipcMain.handle('io:export', async (_e, options: ExportSaveOptions): Promise<ExportSaveResult> => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
    const ext = options.kind === 'csv' ? 'csv' : 'json'
    const saveOptions = {
      title: '导出',
      defaultPath: options.defaultName.replace(/\.(csv|json)$/i, '') + '.' + ext,
      filters:
        ext === 'csv'
          ? [{ name: 'CSV', extensions: ['csv'] }]
          : [{ name: 'JSON', extensions: ['json'] }]
    }
    const { canceled, filePath } = win
      ? await dialog.showSaveDialog(win, saveOptions)
      : await dialog.showSaveDialog(saveOptions)
    if (canceled || !filePath) return { canceled: true }
    try {
      // CSV 加 BOM，Excel 打开中文不乱码
      writeFileSync(filePath, (ext === 'csv' ? '\ufeff' : '') + options.content, 'utf8')
      return { canceled: false, savedPath: filePath }
    } catch (err) {
      return { canceled: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ---------- 通用设置 ----------

  ipcMain.handle('settings:get', (_e, key: string): string | null =>
    SETTING_KEYS.has(key) ? getStore().metaGet(key) : null
  )

  ipcMain.handle('settings:set', (_e, key: string, value: string) => {
    if (!SETTING_KEYS.has(key)) throw new Error(`不允许的设置键：${key}`)
    getStore().setMeta(key, String(value))
  })

  // ---------- 外部链接 ----------

  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('仅允许打开 http/https 链接')
    void shell.openExternal(url)
  })

  // ---------- 团队仓库（配置层） ----------

  ipcMain.handle('teamRepo:init', () => initSync())

  ipcMain.handle('teamRepo:status', () => getRepoStatus())

  ipcMain.handle('teamRepo:addRemote', (_e, url: string) => addRemote(url))

  ipcMain.handle('teamRepo:push', () => syncPush())

  ipcMain.handle('teamRepo:pull', () => syncPull())

  ipcMain.handle('teamRepo:skills', () => getTeamSkillsSummary())

  ipcMain.handle('teamRepo:rules', () => getTeamRulesSummary())

  ipcMain.handle('teamRepo:getSkill', (_e, name: string) => getSkillContent(name))

  ipcMain.handle('teamRepo:getRule', (_e, name: string) => getRuleContent(name))

  ipcMain.handle(
    'teamRepo:saveSkill',
    (_e, name: string, content: { skillMd: string; prompt?: string; examples?: string }) =>
      saveSkill(name, content)
  )

  ipcMain.handle('teamRepo:saveRule', (_e, name: string, content: string) =>
    saveRule(name, content)
  )

  ipcMain.handle('teamRepo:syncConfig', () => getSyncConfig())

  ipcMain.handle('teamRepo:saveSyncConfig', (_e, config) => {
    saveSyncConfig(config)
    return { success: true }
  })

  // ---------- 任务管理（执行层） ----------

  ipcMain.handle('tasks:list', (): Task[] => getTasks())

  ipcMain.handle('tasks:get', (_e, taskId: string): Task | null => getTask(taskId))

  ipcMain.handle(
    'tasks:create',
    (
      _e,
      input: {
        title: string
        description: string
        mode: string
        agents: string[]
        dependencies: string[]
      }
    ) =>
      createTask(
        input.title,
        input.description,
        input.mode as any,
        input.agents ?? [],
        input.dependencies ?? []
      )
  )

  ipcMain.handle('tasks:updateStatus', (_e, taskId: string, status: string) =>
    updateTaskStatus(taskId, status as any)
  )

  ipcMain.handle('tasks:decompose', async (_e, taskId: string) => await decomposeTask(taskId))

  ipcMain.handle('tasks:assignSubTask', (_e, taskId: string, subTaskId: string, agentId: string) =>
    assignSubTask(taskId, subTaskId, agentId)
  )

  ipcMain.handle(
    'tasks:executeSubTask',
    async (_e, taskId: string, subTaskId: string) => await executeSubTask(taskId, subTaskId)
  )

  ipcMain.handle('tasks:monitor', (_e, taskId: string): Task | null => monitorExecution(taskId))

  ipcMain.handle('tasks:cancel', (_e, taskId: string) => cancelTask(taskId))

  ipcMain.handle('tasks:ready', (): Task[] => getReadyTasks())

  // ---------- 任务队列 ----------

  ipcMain.handle('queue:status', () => getQueueStatus())

  ipcMain.handle('queue:enqueue', (_e, taskId: string, priority: number) =>
    enqueue(taskId, priority)
  )

  ipcMain.handle('queue:pause', () => {
    pauseQueue()
    return { success: true }
  })

  ipcMain.handle('queue:resume', () => {
    resumeQueue()
    return { success: true }
  })

  ipcMain.handle('queue:clear', () => {
    clearQueue()
    return { success: true }
  })

  ipcMain.handle('queue:taskIds', (): string[] => getQueuedTaskIds())

  // ---------- 约束管理 ----------

  ipcMain.handle('constraints:list', (): AgentConstraint[] => getConstraints())

  ipcMain.handle('constraints:add', (_e, constraint: Omit<AgentConstraint, 'id' | 'createdAt'>) =>
    addConstraint(constraint)
  )

  ipcMain.handle('constraints:update', (_e, id: string, updates: Partial<AgentConstraint>) =>
    updateConstraint(id, updates)
  )

  ipcMain.handle('constraints:delete', (_e, id: string) => deleteConstraint(id))

  ipcMain.handle('constraints:agent', (_e, agentId: string): AgentConstraint[] =>
    getAgentConstraints(agentId)
  )

  ipcMain.handle('constraints:validate', (_e, agentId: string, context: any) =>
    validateConstraints(agentId, context)
  )

  // ---------- 信任度评分 ----------

  ipcMain.handle('trust:scores', () => getTrustScores())

  ipcMain.handle('trust:agent', (_e, agentId: string) => getAgentTrustScore(agentId))

  ipcMain.handle('trust:update', (_e, agentId: string, success: boolean, duration: number) =>
    updateTrustScore(agentId, success, duration)
  )

  ipcMain.handle('trust:frictionStats', (_e, agentId?: string) => getFrictionPointStats(agentId))

  ipcMain.handle('trust:rank', (_e, agentIds: string[]) => rankAgentsByTrust(agentIds))
}
