/**
 * 同步引擎：处理团队仓库的 push/pull 和自动同步
 */
import { join } from 'path'
import { HOME, readJson } from './lib/fs'
import { logger } from './lib/logger'
import {
  initTeamRepo,
  getRepoStatus,
  pushToRemote,
  pullFromRemote,
  listTeamSkills,
  listTeamRules,
  getSkillContent,
  getRuleContent
} from './team-repo'

export interface SyncResult {
  success: boolean
  operation: 'push' | 'pull' | 'init'
  syncedSkills: string[]
  syncedRules: string[]
  error?: string
}

export interface SyncConfig {
  autoSync: boolean
  autoSyncInterval: number // 毫秒
  lastSyncAt?: number
}

const SYNC_CONFIG_PATH = join(HOME, '.agent-tower', 'sync-config.json')

/** 获取同步配置 */
export function getSyncConfig(): SyncConfig {
  const config = readJson<SyncConfig>(SYNC_CONFIG_PATH)
  return config || {
    autoSync: false,
    autoSyncInterval: 30 * 60 * 1000 // 30 分钟
  }
}

/** 保存同步配置 */
export function saveSyncConfig(config: SyncConfig): void {
  try {
    require('fs').writeFileSync(SYNC_CONFIG_PATH, JSON.stringify(config, null, 2))
  } catch (err) {
    logger.error('sync-engine', `保存配置失败：${err}`)
  }
}

/** 初始化团队仓库 */
export function initSync(): SyncResult {
  const result = initTeamRepo()
  if (!result.success) {
    return {
      success: false,
      operation: 'init',
      syncedSkills: [],
      syncedRules: [],
      error: result.error
    }
  }

  const skills = listTeamSkills()
  const rules = listTeamRules()

  return {
    success: true,
    operation: 'init',
    syncedSkills: skills,
    syncedRules: rules
  }
}

/** Push 到远程仓库 */
export function syncPush(): SyncResult {
  const status = getRepoStatus()
  if (!status.initialized) {
    const initResult = initSync()
    if (!initResult.success) return initResult
  }

  const result = pushToRemote()
  if (!result.success) {
    return {
      success: false,
      operation: 'push',
      syncedSkills: [],
      syncedRules: [],
      error: result.error
    }
  }

  const skills = listTeamSkills()
  const rules = listTeamRules()

  const config = getSyncConfig()
  config.lastSyncAt = Date.now()
  saveSyncConfig(config)

  return {
    success: true,
    operation: 'push',
    syncedSkills: skills,
    syncedRules: rules
  }
}

/** Pull 从远程仓库 */
export function syncPull(): SyncResult {
  const status = getRepoStatus()
  if (!status.initialized) {
    const initResult = initSync()
    if (!initResult.success) return initResult
  }

  const result = pullFromRemote()
  if (!result.success) {
    return {
      success: false,
      operation: 'pull',
      syncedSkills: [],
      syncedRules: [],
      error: result.error
    }
  }

  const skills = listTeamSkills()
  const rules = listTeamRules()

  const config = getSyncConfig()
  config.lastSyncAt = Date.now()
  saveSyncConfig(config)

  return {
    success: true,
    operation: 'pull',
    syncedSkills: skills,
    syncedRules: rules
  }
}

/** 获取团队技能列表（含内容摘要） */
export function getTeamSkillsSummary() {
  const skillNames = listTeamSkills()
  return skillNames.map((name) => {
    const content = getSkillContent(name)
    return {
      name,
      hasSkillMd: !!content.skillMd,
      hasPrompt: !!content.prompt,
      hasExamples: !!content.examples
    }
  })
}

/** 获取团队规则列表（含内容摘要） */
export function getTeamRulesSummary() {
  const ruleNames = listTeamRules()
  return ruleNames.map((name) => {
    const content = getRuleContent(name)
    return {
      name,
      size: content?.length || 0,
      preview: content?.slice(0, 100) || ''
    }
  })
}

/** 检查是否需要自动同步 */
export function shouldAutoSync(): boolean {
  const config = getSyncConfig()
  if (!config.autoSync) return false

  const now = Date.now()
  const lastSync = config.lastSyncAt || 0
  return now - lastSync >= config.autoSyncInterval
}

/** 执行自动同步（如果配置启用且超过间隔） */
export function autoSyncIfNeeded(): SyncResult | null {
  if (!shouldAutoSync()) return null

  logger.info('sync-engine', '执行自动同步...')
  return syncPull()
}
