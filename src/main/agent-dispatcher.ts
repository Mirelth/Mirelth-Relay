/**
 * Agent 分配器：根据任务需求和 Agent 能力选择最优 Agent
 */
import { logger } from './lib/logger'
import { validateConstraints } from './constraints'

export interface AgentCapability {
  id: string
  name: string
  skills: string[]
  avgResponseTime: number
  successRate: number
  trustScore: number
  currentLoad: number
}

// 模拟 Agent 能力数据（实际应该从 Scanner 和监控数据获取）
const agentCapabilities: Map<string, AgentCapability> = new Map()

/** 注册 Agent 能力 */
export function registerAgentCapability(capability: AgentCapability): void {
  agentCapabilities.set(capability.id, capability)
}

/** 获取 Agent 能力 */
export function getAgentCapability(agentId: string): AgentCapability | null {
  return agentCapabilities.get(agentId) || null
}

/** 获取所有 Agent 能力 */
export function getAllAgentCapabilities(): AgentCapability[] {
  return Array.from(agentCapabilities.values())
}

/** 根据任务需求选择最优 Agent */
export function selectBestAgent(
  _taskDescription: string,
  requiredSkills?: string[],
  excludeAgents?: string[]
): string | null {
  const agents = getAllAgentCapabilities()
  const exclude = new Set(excludeAgents || [])

  // 过滤掉被排除的 Agent
  const candidates = agents.filter((a) => !exclude.has(a.id))

  if (candidates.length === 0) {
    logger.warn('dispatcher', '没有可用的 Agent')
    return null
  }

  // 计算每个 Agent 的得分
  const scored = candidates.map((agent) => {
    let score = 0

    // 1. 技能匹配度（40%）
    if (requiredSkills && requiredSkills.length > 0) {
      const matchedSkills = agent.skills.filter((s) =>
        requiredSkills.some((rs) => s.toLowerCase().includes(rs.toLowerCase()))
      )
      score += (matchedSkills.length / requiredSkills.length) * 40
    } else {
      score += 20 // 默认分
    }

    // 2. 成功率（30%）
    score += agent.successRate * 30

    // 3. 信任度（20%）
    score += agent.trustScore * 20

    // 4. 当前负载（10%，负载越低越好）
    score += (1 - agent.currentLoad) * 10

    return { agent, score }
  })

  // 按得分排序
  scored.sort((a, b) => b.score - a.score)

  const best = scored[0]
  logger.info('dispatcher', `选择 Agent：${best.agent.name}（得分：${best.score.toFixed(2)}）`)

  return best.agent.id
}

/** 批量分配子任务 */
export function assignSubTasks(
  _taskId: string,
  subTaskDescriptions: string[]
): Record<string, string> {
  const assignments: Record<string, string> = {}
  const usedAgents = new Set<string>()

  for (const desc of subTaskDescriptions) {
    const agentId = selectBestAgent(desc, undefined, Array.from(usedAgents))
    if (agentId) {
      assignments[desc] = agentId
      usedAgents.add(agentId)
    }
  }

  return assignments
}

/** 检查 Agent 是否满足约束 */
export function checkAgentConstraints(agentId: string): { allowed: boolean; violations: string[] } {
  const violations = validateConstraints(agentId, {
    currentHour: new Date().getHours()
  })

  if (violations.length === 0) {
    return { allowed: true, violations: [] }
  }

  const messages = violations.map((v) => v.message)
  return { allowed: false, violations: messages }
}

/** 更新 Agent 负载 */
export function updateAgentLoad(agentId: string, load: number): void {
  const capability = getAgentCapability(agentId)
  if (capability) {
    capability.currentLoad = Math.max(0, Math.min(1, load))
    registerAgentCapability(capability)
  }
}

/** 更新 Agent 信任度 */
export function updateAgentTrustScore(agentId: string, score: number): void {
  const capability = getAgentCapability(agentId)
  if (capability) {
    capability.trustScore = Math.max(0, Math.min(1, score))
    registerAgentCapability(capability)
  }
}

/** 根据任务历史更新 Agent 能力 */
export function updateAgentFromTaskHistory(agentId: string, success: boolean, duration: number): void {
  const capability = getAgentCapability(agentId)
  if (!capability) return

  // 更新成功率（移动平均）
  const alpha = 0.1
  capability.successRate = capability.successRate * (1 - alpha) + (success ? 1 : 0) * alpha

  // 更新响应时间（移动平均）
  capability.avgResponseTime = capability.avgResponseTime * (1 - alpha) + duration * alpha

  registerAgentCapability(capability)
}
