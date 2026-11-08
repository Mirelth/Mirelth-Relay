// @ts-nocheck
// 由 scripts/gen-api.mjs 从 src/preload/index.ts 生成，请勿手动修改。
// 旧页面的 window.api 调用统一走 Wails 绑定 App.Invoke。

async function invoke(channel, ...args) {
  const app = window.go?.main?.App
  if (!app?.Invoke) return null
  try {
    if (channel === 'io:export') {
      const options = args[0]
      if (options?.content) download(options)
      return { ok: true, canceled: false }
    }
    const raw = await app.Invoke(channel, JSON.stringify(args))
    return raw == null ? null : JSON.parse(raw)
  } catch (err) {
    console.error('invoke', channel, err)
    return null
  }
}

function download(options) {
  const blob = new Blob([options.content || ''], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = options.defaultName || 'relay-export.csv'
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const api = {
  scanAgents: () => invoke('agents:scan'),
  getAgentDetail: (id) => invoke('agents:detail', id),
  listSkills: (filter) => invoke('skills:list', filter),
  listMcp: (agentId) => invoke('mcp:list', agentId),
  checkMcpHealth: (serverId) => invoke('mcp:check', serverId),
  checkAllMcp: (agentId) => invoke('mcp:checkAll', agentId),
  listCommits: (filter) => invoke('git:commits', filter),
  getCommitDetail: (commitId) => invoke('git:commitDetail', commitId),
  tokenStats: (dimension, query) => invoke('tokens:stats', dimension, query),
  tokenRecords: (query) => invoke('tokens:records', query),
  dashboard: () => invoke('dashboard'),
  refresh: (options) => invoke('app:refresh', options),
  lastScan: () => invoke('app:lastScan'),
  listModelProfiles: () => invoke('models:list'),
  saveModelProfile: (profile) => invoke('models:save', profile),
  deleteModelProfile: (id) => invoke('models:delete', id),
  listAppliers: () => invoke('models:appliers'),
  applyModelProfile: (profileId, agentIds, options) =>
    invoke('models:apply', profileId, agentIds, options),
  fetchModelCatalog: (baseURL, apiKey, kind) =>
    invoke('models:catalog', baseURL, apiKey, kind),
  listHooks: () => invoke('hooks:list'),
  listHookTargets: () => invoke('hooks:targets'),
  createHook: (input) => invoke('hooks:create', input),
  deleteHook: (hookId) => invoke('hooks:delete', hookId),
  listSkillCopyTargets: () => invoke('skills:copyTargets'),
  copySkill: (skillId, agentIds, overwrite) =>
    invoke('skills:copy', skillId, agentIds, overwrite),
  checkUpdate: () => invoke('update:check'),
  getPricing: () => invoke('pricing:get'),
  savePricing: (config) => invoke('pricing:save', config),
  resetPricing: () => invoke('pricing:reset'),
  securityScan: () => invoke('security:scan'),
  pickRepoDir: () => invoke('security:pickRepo'),
  repoSecurityScan: (repoDir) => invoke('security:repoScan', repoDir),
  // LLM 聚合网关
  gwGet: () => invoke('gw:get'),
  gwUpdate: (patch) => invoke('gw:update', patch),
  gwStart: () => invoke('gw:start'),
  gwStop: () => invoke('gw:stop'),
  gwRegenerateKey: () => invoke('gw:regenKey'),
  gwRevealKey: () => invoke('gw:revealKey'),
  gwLogs: () => invoke('gw:logs'),
  gwSimulate: (text, maxTokens) => invoke('gw:simulate', text, maxTokens),
  gwTestModel: (id) => invoke('gw:testModel', id),
  exportSave: (options) => invoke('io:export', options),
  settingGet: (key) => invoke('settings:get', key),
  settingSet: (key, value) => invoke('settings:set', key, value),
  openExternal: (url) => invoke('shell:openExternal', url),
  // 团队仓库（配置层）
  teamRepoInit: () => invoke('teamRepo:init'),
  teamRepoStatus: () => invoke('teamRepo:status'),
  teamRepoAddRemote: (url) => invoke('teamRepo:addRemote', url),
  teamRepoPush: () => invoke('teamRepo:push'),
  teamRepoPull: () => invoke('teamRepo:pull'),
  teamRepoSkills: () => invoke('teamRepo:skills'),
  teamRepoRules: () => invoke('teamRepo:rules'),
  teamRepoGetSkill: (name) => invoke('teamRepo:getSkill', name),
  teamRepoGetRule: (name) => invoke('teamRepo:getRule', name),
  teamRepoSaveSkill: (name, content) => invoke('teamRepo:saveSkill', name, content),
  teamRepoSaveRule: (name, content) => invoke('teamRepo:saveRule', name, content),
  teamRepoSyncConfig: () => invoke('teamRepo:syncConfig'),
  teamRepoSaveSyncConfig: (config) => invoke('teamRepo:saveSyncConfig', config),
  // 任务管理（执行层）
  tasksList: () => invoke('tasks:list'),
  tasksGet: (taskId) => invoke('tasks:get', taskId),
  tasksCreate: (input) => invoke('tasks:create', input),
  tasksUpdateStatus: (taskId, status) => invoke('tasks:updateStatus', taskId, status),
  tasksDecompose: (taskId) => invoke('tasks:decompose', taskId),
  tasksAssignSubTask: (taskId, subTaskId, agentId) =>
    invoke('tasks:assignSubTask', taskId, subTaskId, agentId),
  tasksExecuteSubTask: (taskId, subTaskId) =>
    invoke('tasks:executeSubTask', taskId, subTaskId),
  tasksMonitor: (taskId) => invoke('tasks:monitor', taskId),
  tasksCancel: (taskId) => invoke('tasks:cancel', taskId),
  tasksReady: () => invoke('tasks:ready'),
  // 任务队列
  queueStatus: () => invoke('queue:status'),
  queueEnqueue: (taskId, priority) => invoke('queue:enqueue', taskId, priority),
  queuePause: () => invoke('queue:pause'),
  queueResume: () => invoke('queue:resume'),
  queueClear: () => invoke('queue:clear'),
  queueTaskIds: () => invoke('queue:taskIds'),
  // 约束管理
  constraintsList: () => invoke('constraints:list'),
  constraintsAdd: (constraint) => invoke('constraints:add', constraint),
  constraintsUpdate: (id, updates) => invoke('constraints:update', id, updates),
  constraintsDelete: (id) => invoke('constraints:delete', id),
  constraintsAgent: (agentId) => invoke('constraints:agent', agentId),
  constraintsValidate: (agentId, context) =>
    invoke('constraints:validate', agentId, context),
  // 信任度评分
  trustScores: () => invoke('trust:scores'),
  trustAgent: (agentId) => invoke('trust:agent', agentId),
  trustUpdate: (agentId, success, duration) =>
    invoke('trust:update', agentId, success, duration),
  trustFrictionStats: (agentId) => invoke('trust:frictionStats', agentId),
  trustRank: (agentIds) => invoke('trust:rank', agentIds)
}

export function installApi() {
  window.api = api
  window.onScanCompleted = (cb) => {
    window.runtime?.EventsOn?.('scan:completed', cb)
    return () => {}
  }
  window.onUpdaterOpen = (cb) => {
    window.runtime?.EventsOn?.('update:available', cb)
    return () => {}
  }
}
