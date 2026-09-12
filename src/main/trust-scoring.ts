/**
 * 信任度评分系统
 * 基于 Agent 历史表现动态调整信任度评分
 */
import { join } from 'path'
import { HOME, readJson } from './lib/fs'
import { logger } from './lib/logger'
import type { FrictionPoint } from '../shared/task-types'

const TRUST_SCORES_PATH = join(HOME, '.agent-tower', 'trust-scores.json')
const FRICTION_POINTS_PATH = join(HOME, '.agent-tower', 'friction-points.json')

export interface TrustScore {
  agentId: string
  score: number
  totalTasks: number
  successfulTasks: number
  failedTasks: number
  avgDuration: number
  lastUpdated: number
}

/** 获取所有信任度评分 */
export function getTrustScores(): TrustScore[] {
  const scores = readJson<TrustScore[]>(TRUST_SCORES_PATH)
  return scores || []
}

/** 保存信任度评分 */
export function saveTrustScores(scores: TrustScore[]): void {
  try {
    require('fs').writeFileSync(TRUST_SCORES_PATH, JSON.stringify(scores, null, 2))
  } catch (err) {
    logger.error('trust', `保存信任度失败：${err}`)
  }
}

/** 获取指定 Agent 的信任度 */
export function getAgentTrustScore(agentId: string): TrustScore | null {
  const scores = getTrustScores()
  return scores.find((s) => s.agentId === agentId) || null
}

/** 初始化 Agent 信任度 */
export function initAgentTrustScore(agentId: string): TrustScore {
  const scores = getTrustScores()
  const existing = scores.find((s) => s.agentId === agentId)

  if (existing) return existing

  const newScore: TrustScore = {
    agentId,
    score: 0.5, // 默认中等信任度
    totalTasks: 0,
    successfulTasks: 0,
    failedTasks: 0,
    avgDuration: 0,
    lastUpdated: Date.now()
  }

  scores.push(newScore)
  saveTrustScores(scores)
  return newScore
}

/** 更新信任度（任务完成后调用） */
export function updateTrustScore(
  agentId: string,
  success: boolean,
  duration: number
): TrustScore {
  const scores = getTrustScores()
  let score = scores.find((s) => s.agentId === agentId)

  if (!score) {
    score = initAgentTrustScore(agentId)
  }

  // 更新统计数据
  score.totalTasks++
  if (success) {
    score.successfulTasks++
  } else {
    score.failedTasks++
  }

  // 更新平均时长（移动平均）
  const alpha = 0.1
  score.avgDuration = score.avgDuration * (1 - alpha) + duration * alpha

  // 计算新信任度
  const successRate = score.totalTasks > 0 ? score.successfulTasks / score.totalTasks : 0.5
  const timeFactor = Math.max(0, 1 - score.avgDuration / 60000) // 1 分钟内完成为满分

  // 信任度 = 成功率 * 0.7 + 时间因子 * 0.3
  score.score = successRate * 0.7 + timeFactor * 0.3
  score.lastUpdated = Date.now()

  saveTrustScores(scores)
  return score
}

/** 记录摩擦点 */
export function recordFrictionPoint(point: FrictionPoint): void {
  const points = readJson<FrictionPoint[]>(FRICTION_POINTS_PATH) || []
  points.push(point)

  // 只保留最近 1000 条
  const recent = points.slice(-1000)

  try {
    require('fs').writeFileSync(FRICTION_POINTS_PATH, JSON.stringify(recent, null, 2))
  } catch (err) {
    logger.error('trust', `记录摩擦点失败：${err}`)
  }

  // 降低相关 Agent 的信任度
  const score = getAgentTrustScore(point.agentId)
  if (score) {
    score.score = Math.max(0, score.score - 0.05)
    saveTrustScores(getTrustScores())
  }
}

/** 获取摩擦点统计 */
export function getFrictionPointStats(agentId?: string): {
  total: number
  byCategory: Record<string, number>
  byAgent: Record<string, number>
} {
  const points = readJson<FrictionPoint[]>(FRICTION_POINTS_PATH) || []
  const filtered = agentId ? points.filter((p) => p.agentId === agentId) : points

  const byCategory: Record<string, number> = {}
  const byAgent: Record<string, number> = {}

  for (const point of filtered) {
    byCategory[point.category] = (byCategory[point.category] || 0) + 1
    byAgent[point.agentId] = (byAgent[point.agentId] || 0) + 1
  }

  return {
    total: filtered.length,
    byCategory,
    byAgent
  }
}

/** 根据信任度排序 Agent */
export function rankAgentsByTrust(agentIds: string[]): { agentId: string; score: number }[] {
  const scores = getTrustScores()
  const scoreMap = new Map(scores.map((s) => [s.agentId, s.score]))

  return agentIds
    .map((id) => ({
      agentId: id,
      score: scoreMap.get(id) || 0.5
    }))
    .sort((a, b) => b.score - a.score)
}
