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
  applyModelProfile: (profileId, agentIds, options) => ipcRenderer.invoke('models:apply', profileId, agentIds, options),
  listHooks: () => ipcRenderer.invoke('hooks:list'),
  listHookTargets: () => ipcRenderer.invoke('hooks:targets'),
  createHook: (input) => ipcRenderer.invoke('hooks:create', input),
  deleteHook: (hookId) => ipcRenderer.invoke('hooks:delete', hookId),
  listSkillCopyTargets: () => ipcRenderer.invoke('skills:copyTargets'),
  copySkill: (skillId, agentIds, overwrite) => ipcRenderer.invoke('skills:copy', skillId, agentIds, overwrite)
}

/** 扫描完成事件订阅 */
export function onScanCompleted(cb: () => void): () => void {
  const listener = (): void => cb()
  ipcRenderer.on('scan:completed', listener)
  return () => ipcRenderer.removeListener('scan:completed', listener)
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
    contextBridge.exposeInMainWorld('onScanCompleted', onScanCompleted)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
