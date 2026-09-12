import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { ApiClient } from '@shared/types'

const api: ApiClient = {
  scanAgents: () => ipcRenderer.invoke('agents:scan'),
  getAgentDetail: (id) => ipcRenderer.invoke('agents:detail', id),
  listSkills: (filter) => ipcRenderer.invoke('skills:list', filter),
  listMcp: (agentId) => ipcRenderer.invoke('mcp:list', agentId),
  checkMcpHealth: (serverId) => ipcRenderer.invoke('mcp:check', serverId),
  checkAllMcp: (agentId) => ipcRenderer.invoke('mcp:checkAll', agentId),
  listCommits: (filter) => ipcRenderer.invoke('git:commits', filter),
  getCommitDetail: (commitId) => ipcRenderer.invoke('git:commitDetail', commitId),
  tokenStats: (dimension, query) => ipcRenderer.invoke('tokens:stats', dimension, query),
  tokenRecords: (query) => ipcRenderer.invoke('tokens:records', query),
  dashboard: () => ipcRenderer.invoke('dashboard'),
  refresh: (options) => ipcRenderer.invoke('app:refresh', options),
  lastScan: () => ipcRenderer.invoke('app:lastScan'),
  listModelProfiles: () => ipcRenderer.invoke('models:list'),
  saveModelProfile: (profile) => ipcRenderer.invoke('models:save', profile),
  deleteModelProfile: (id) => ipcRenderer.invoke('models:delete', id),
  listAppliers: () => ipcRenderer.invoke('models:appliers'),
  applyModelProfile: (profileId, agentIds, options) =>
    ipcRenderer.invoke('models:apply', profileId, agentIds, options),
  fetchModelCatalog: (baseURL, apiKey, kind) =>
    ipcRenderer.invoke('models:catalog', baseURL, apiKey, kind),
  listHooks: () => ipcRenderer.invoke('hooks:list'),
  listHookTargets: () => ipcRenderer.invoke('hooks:targets'),
  createHook: (input) => ipcRenderer.invoke('hooks:create', input),
  deleteHook: (hookId) => ipcRenderer.invoke('hooks:delete', hookId),
  listSkillCopyTargets: () => ipcRenderer.invoke('skills:copyTargets'),
  copySkill: (skillId, agentIds, overwrite) =>
    ipcRenderer.invoke('skills:copy', skillId, agentIds, overwrite),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  getPricing: () => ipcRenderer.invoke('pricing:get'),
  savePricing: (config) => ipcRenderer.invoke('pricing:save', config),
  resetPricing: () => ipcRenderer.invoke('pricing:reset'),
  securityScan: () => ipcRenderer.invoke('security:scan'),
  pickRepoDir: () => ipcRenderer.invoke('security:pickRepo'),
  repoSecurityScan: (repoDir) => ipcRenderer.invoke('security:repoScan', repoDir),
  // LLM 聚合网关
  gwGet: () => ipcRenderer.invoke('gw:get'),
  gwUpdate: (patch) => ipcRenderer.invoke('gw:update', patch),
  gwStart: () => ipcRenderer.invoke('gw:start'),
  gwStop: () => ipcRenderer.invoke('gw:stop'),
  gwRegenerateKey: () => ipcRenderer.invoke('gw:regenKey'),
  gwRevealKey: () => ipcRenderer.invoke('gw:revealKey'),
  gwLogs: () => ipcRenderer.invoke('gw:logs'),
  gwSimulate: (text, maxTokens) => ipcRenderer.invoke('gw:simulate', text, maxTokens),
  gwTestModel: (id) => ipcRenderer.invoke('gw:testModel', id),
  exportSave: (options) => ipcRenderer.invoke('io:export', options),
  settingGet: (key) => ipcRenderer.invoke('settings:get', key),
  settingSet: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  // 团队仓库（配置层）
  teamRepoInit: () => ipcRenderer.invoke('teamRepo:init'),
  teamRepoStatus: () => ipcRenderer.invoke('teamRepo:status'),
  teamRepoAddRemote: (url) => ipcRenderer.invoke('teamRepo:addRemote', url),
  teamRepoPush: () => ipcRenderer.invoke('teamRepo:push'),
  teamRepoPull: () => ipcRenderer.invoke('teamRepo:pull'),
  teamRepoSkills: () => ipcRenderer.invoke('teamRepo:skills'),
  teamRepoRules: () => ipcRenderer.invoke('teamRepo:rules'),
  teamRepoGetSkill: (name) => ipcRenderer.invoke('teamRepo:getSkill', name),
  teamRepoGetRule: (name) => ipcRenderer.invoke('teamRepo:getRule', name),
  teamRepoSaveSkill: (name, content) => ipcRenderer.invoke('teamRepo:saveSkill', name, content),
  teamRepoSaveRule: (name, content) => ipcRenderer.invoke('teamRepo:saveRule', name, content),
  teamRepoSyncConfig: () => ipcRenderer.invoke('teamRepo:syncConfig'),
  teamRepoSaveSyncConfig: (config) => ipcRenderer.invoke('teamRepo:saveSyncConfig', config),
  // 任务管理（执行层）
  tasksList: () => ipcRenderer.invoke('tasks:list'),
  tasksGet: (taskId) => ipcRenderer.invoke('tasks:get', taskId),
  tasksCreate: (input) => ipcRenderer.invoke('tasks:create', input),
  tasksUpdateStatus: (taskId, status) => ipcRenderer.invoke('tasks:updateStatus', taskId, status),
  tasksDecompose: (taskId) => ipcRenderer.invoke('tasks:decompose', taskId),
  tasksAssignSubTask: (taskId, subTaskId, agentId) =>
    ipcRenderer.invoke('tasks:assignSubTask', taskId, subTaskId, agentId),
  tasksExecuteSubTask: (taskId, subTaskId) =>
    ipcRenderer.invoke('tasks:executeSubTask', taskId, subTaskId),
  tasksMonitor: (taskId) => ipcRenderer.invoke('tasks:monitor', taskId),
  tasksCancel: (taskId) => ipcRenderer.invoke('tasks:cancel', taskId),
  tasksReady: () => ipcRenderer.invoke('tasks:ready'),
  // 任务队列
  queueStatus: () => ipcRenderer.invoke('queue:status'),
  queueEnqueue: (taskId, priority) => ipcRenderer.invoke('queue:enqueue', taskId, priority),
  queuePause: () => ipcRenderer.invoke('queue:pause'),
  queueResume: () => ipcRenderer.invoke('queue:resume'),
  queueClear: () => ipcRenderer.invoke('queue:clear'),
  queueTaskIds: () => ipcRenderer.invoke('queue:taskIds'),
  // 约束管理
  constraintsList: () => ipcRenderer.invoke('constraints:list'),
  constraintsAdd: (constraint) => ipcRenderer.invoke('constraints:add', constraint),
  constraintsUpdate: (id, updates) => ipcRenderer.invoke('constraints:update', id, updates),
  constraintsDelete: (id) => ipcRenderer.invoke('constraints:delete', id),
  constraintsAgent: (agentId) => ipcRenderer.invoke('constraints:agent', agentId),
  constraintsValidate: (agentId, context) =>
    ipcRenderer.invoke('constraints:validate', agentId, context),
  // 信任度评分
  trustScores: () => ipcRenderer.invoke('trust:scores'),
  trustAgent: (agentId) => ipcRenderer.invoke('trust:agent', agentId),
  trustUpdate: (agentId, success, duration) =>
    ipcRenderer.invoke('trust:update', agentId, success, duration),
  trustFrictionStats: (agentId) => ipcRenderer.invoke('trust:frictionStats', agentId),
  trustRank: (agentIds) => ipcRenderer.invoke('trust:rank', agentIds)
}

/** 扫描完成事件订阅 */
export function onScanCompleted(cb: () => void): () => void {
  const listener = (): void => cb()
  ipcRenderer.on('scan:completed', listener)
  return () => ipcRenderer.removeListener('scan:completed', listener)
}

/** 托盘"检查更新"事件订阅 */
export function onUpdaterOpen(cb: () => void): () => void {
  const listener = (): void => cb()
  ipcRenderer.on('updater:open', listener)
  return () => ipcRenderer.removeListener('updater:open', listener)
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
    contextBridge.exposeInMainWorld('onScanCompleted', onScanCompleted)
    contextBridge.exposeInMainWorld('onUpdaterOpen', onUpdaterOpen)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
  // @ts-ignore (define in dts)
  window.onUpdaterOpen = onUpdaterOpen
}
