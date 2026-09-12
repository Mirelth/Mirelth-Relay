/**
 * Agent 行为约束管理
 * 定义和校验 Agent 执行时的约束条件（Token 限额、模型白名单、成本上限等）
 */
import { join } from 'path'
import { HOME, readJson } from './lib/fs'
import { logger } from './lib/logger'
import type { AgentConstraint, ConstraintType, ConstraintAction } from '../shared/task-types'

const CONSTRAINTS_PATH = join(HOME, '.agent-tower', 'constraints.json')

export interface ConstraintViolation {
  constraintId: string
  agentId: string
  type: ConstraintType
  action: ConstraintAction
  message: string
  timestamp: number
}

/** 获取所有约束 */
export function getConstraints(): AgentConstraint[] {
  const constraints = readJson<AgentConstraint[]>(CONSTRAINTS_PATH)
  return constraints || []
}

/** 保存约束列表 */
export function saveConstraints(constraints: AgentConstraint[]): void {
  try {
    require('fs').writeFileSync(CONSTRAINTS_PATH, JSON.stringify(constraints, null, 2))
    logger.info('constraints', `已保存 ${constraints.length} 条约束`)
  } catch (err) {
    logger.error('constraints', `保存失败：${err}`)
  }
}

/** 添加约束 */
export function addConstraint(constraint: Omit<AgentConstraint, 'id' | 'createdAt'>): AgentConstraint {
  const constraints = getConstraints()
  const newConstraint: AgentConstraint = {
    ...constraint,
    id: `constraint-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    createdAt: Date.now()
  }
  constraints.push(newConstraint)
  saveConstraints(constraints)
  return newConstraint
}

/** 更新约束 */
export function updateConstraint(id: string, updates: Partial<AgentConstraint>): AgentConstraint | null {
  const constraints = getConstraints()
  const index = constraints.findIndex((c) => c.id === id)
  if (index === -1) return null

  constraints[index] = { ...constraints[index], ...updates }
  saveConstraints(constraints)
  return constraints[index]
}

/** 删除约束 */
export function deleteConstraint(id: string): boolean {
  const constraints = getConstraints()
  const filtered = constraints.filter((c) => c.id !== id)
  if (filtered.length === constraints.length) return false

  saveConstraints(filtered)
  return true
}

/** 获取指定 Agent 的约束 */
export function getAgentConstraints(agentId: string): AgentConstraint[] {
  return getConstraints().filter((c) => c.agentId === agentId && c.enabled)
}

/** 校验约束是否满足 */
export function validateConstraints(
  agentId: string,
  context: {
    model?: string
    tokensToday?: number
    costToday?: number
    currentHour?: number
  }
): ConstraintViolation[] {
  const constraints = getAgentConstraints(agentId)
  const violations: ConstraintViolation[] = []

  for (const constraint of constraints) {
    const violation = checkConstraint(constraint, context)
    if (violation) {
      violations.push(violation)
    }
  }

  return violations
}

/** 检查单条约束 */
function checkConstraint(
  constraint: AgentConstraint,
  context: {
    model?: string
    tokensToday?: number
    costToday?: number
    currentHour?: number
  }
): ConstraintViolation | null {
  switch (constraint.type) {
    case 'token-limit': {
      const limit = constraint.config.maxTokensPerDay || 0
      const used = context.tokensToday || 0
      if (used >= limit) {
        return {
          constraintId: constraint.id,
          agentId: constraint.agentId,
          type: constraint.type,
          action: constraint.action,
          message: `Token 用量已达上限：${used} / ${limit}`,
          timestamp: Date.now()
        }
      }
      return null
    }

    case 'model-whitelist': {
      const allowed = constraint.config.allowedModels || []
      const model = context.model || ''
      if (allowed.length > 0 && !allowed.some((m) => model.includes(m))) {
        return {
          constraintId: constraint.id,
          agentId: constraint.agentId,
          type: constraint.type,
          action: constraint.action,
          message: `模型不在白名单：${model}，允许：${allowed.join(', ')}`,
          timestamp: Date.now()
        }
      }
      return null
    }

    case 'cost-cap': {
      const cap = constraint.config.maxCostPerDay || 0
      const spent = context.costToday || 0
      if (spent >= cap) {
        return {
          constraintId: constraint.id,
          agentId: constraint.agentId,
          type: constraint.type,
          action: constraint.action,
          message: `成本已达上限：$${spent.toFixed(2)} / $${cap.toFixed(2)}`,
          timestamp: Date.now()
        }
      }
      return null
    }

    case 'time-window': {
      const hours = constraint.config.allowedHours
      if (hours && hours.length === 2) {
        const current = context.currentHour ?? new Date().getHours()
        if (current < hours[0] || current >= hours[1]) {
          return {
            constraintId: constraint.id,
            agentId: constraint.agentId,
            type: constraint.type,
            action: constraint.action,
            message: `当前时间 ${current}:00 不在允许时段 ${hours[0]}:00-${hours[1]}:00`,
            timestamp: Date.now()
          }
        }
      }
      return null
    }

    default:
      return null
  }
}

/** 处理约束违反 */
export function handleViolation(violation: ConstraintViolation): { allowed: boolean; message: string } {
  switch (violation.action) {
    case 'block':
      return {
        allowed: false,
        message: `操作被阻止：${violation.message}`
      }

    case 'warn':
      return {
        allowed: true,
        message: `警告：${violation.message}`
      }

    case 'log':
      logger.warn('constraints', `约束违反：${violation.message}`)
      return {
        allowed: true,
        message: ''
      }

    default:
      return { allowed: true, message: '' }
  }
}
