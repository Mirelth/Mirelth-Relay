/** 任务与子任务类型定义（执行层核心数据模型） */

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
export type SubTaskStatus = 'pending' | 'running' | 'completed' | 'failed'
export type ConstraintType = 'token-limit' | 'model-whitelist' | 'cost-cap' | 'time-window'
export type ConstraintAction = 'block' | 'warn' | 'log'
export type CollaborationMode = 'sequential' | 'parallel' | 'supervisor'

export interface SubTask {
  id: string
  description: string
  assignedAgent: string
  status: SubTaskStatus
  input?: string
  output?: string
  startedAt?: number
  completedAt?: number
  error?: string
}

export interface Task {
  id: string
  title: string
  description: string
  status: TaskStatus
  mode: CollaborationMode
  subTasks: SubTask[]
  assignedAgents: string[]
  dependencies: string[]
  createdAt: number
  completedAt?: number
  output?: string
}

export interface AgentConstraint {
  id: string
  agentId: string
  type: ConstraintType
  config: {
    maxTokensPerDay?: number
    allowedModels?: string[]
    maxCostPerDay?: number
    allowedHours?: [number, number]
  }
  action: ConstraintAction
  enabled: boolean
  createdAt: number
}

export interface TeamSkill {
  id: string
  name: string
  description: string
  version?: string
  category: string
  source: string
  trustScore: number
  usageCount: number
  lastUsedAt?: number
  createdAt: number
  updatedAt: number
}

export interface TeamRule {
  id: string
  name: string
  description: string
  type: 'security' | 'style' | 'compliance' | 'custom'
  pattern: string
  severity: 'error' | 'warning' | 'info'
  enabled: boolean
  trustScore: number
  createdAt: number
  updatedAt: number
}

export interface FrictionPoint {
  id: string
  agentId: string
  taskId?: string
  description: string
  category: 'error' | 'timeout' | 'quality' | 'config'
  resolution?: string
  createdAt: number
}

export interface TaskExecutionMetrics {
  taskId: string
  totalDuration: number
  agentUtilization: Record<string, number>
  successRate: number
  waitTime: number
  executionTime: number
}
