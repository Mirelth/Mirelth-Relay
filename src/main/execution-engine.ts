/**
 * 执行引擎：任务拆解、分配和调度。
 * 拆解与执行的真实实现由「LLM 网关」注入（见 setDefaultTaskExecutor /
 * setDefaultTaskDecomposer，main 启动时接线到 llmgw 模块）；
 * 未注入时给出明确错误，不再提供假的默认实现。
 */
import { join } from 'path'
import { HOME, readJson } from './lib/fs'
import * as fs from 'fs'
import { logger } from './lib/logger'
import type { Task, SubTask, TaskStatus, CollaborationMode } from '../shared/task-types'
import { validateConstraints, handleViolation } from './constraints'
import { updateTrustScore, recordFrictionPoint } from './trust-scoring'

const TASKS_PATH = join(HOME, '.agent-tower', 'tasks.json')

export type TaskExecutorResult = string | { output: string; modelId?: string }
export type TaskExecutor = (agentId: string, description: string) => Promise<TaskExecutorResult>
export type TaskDecomposer = (description: string) => Promise<string[]>

let platformExecutor: TaskExecutor | null = null
let platformDecomposer: TaskDecomposer | null = null

/** main 启动时注入真实实现（LLM 网关） */
export function setDefaultTaskExecutor(fn: TaskExecutor): void {
  platformExecutor = fn
}
export function setDefaultTaskDecomposer(fn: TaskDecomposer): void {
  platformDecomposer = fn
}

export interface ExecutionEngine {
  createTask(task: Omit<Task, 'id' | 'status' | 'createdAt' | 'subTasks'>): Promise<string>
  decomposeTask(taskId: string): Promise<SubTask[]>
  assignSubTask(subTaskId: string, agentId: string): Promise<void>
  executeSubTask(subTaskId: string): Promise<string>
  monitorExecution(taskId: string): Task | null
  cancelTask(taskId: string): Promise<void>
}

/** 获取所有任务 */
export function getTasks(): Task[] {
  const tasks = readJson<Task[]>(TASKS_PATH)
  return tasks || []
}

/** 保存任务列表 */
export function saveTasks(tasks: Task[]): void {
  try {
    fs.mkdirSync(join(TASKS_PATH, '..'), { recursive: true })
    fs.writeFileSync(TASKS_PATH, JSON.stringify(tasks, null, 2))
    logger.info('execution', `已保存 ${tasks.length} 个任务`)
  } catch (err) {
    logger.error('execution', `保存任务失败：${err}`)
  }
}

/** 创建任务 */
export function createTask(
  title: string,
  description: string,
  mode: CollaborationMode = 'sequential',
  assignedAgents: string[] = [],
  dependencies: string[] = []
): Task {
  const tasks = getTasks()
  const newTask: Task = {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    title,
    description,
    status: 'pending',
    mode,
    subTasks: [],
    assignedAgents,
    dependencies,
    createdAt: Date.now()
  }
  tasks.push(newTask)
  saveTasks(tasks)
  return newTask
}

/** 获取任务 */
export function getTask(taskId: string): Task | null {
  const tasks = getTasks()
  return tasks.find((t) => t.id === taskId) || null
}

/** 更新任务状态 */
export function updateTaskStatus(taskId: string, status: TaskStatus): Task | null {
  const tasks = getTasks()
  const task = tasks.find((t) => t.id === taskId)
  if (!task) return null

  task.status = status
  if (status === 'completed' || status === 'failed' || status === 'cancelled') {
    task.completedAt = Date.now()
  }
  saveTasks(tasks)
  return task
}

/** 添加子任务 */
export function addSubTask(taskId: string, subTask: SubTask): Task | null {
  const tasks = getTasks()
  const task = tasks.find((t) => t.id === taskId)
  if (!task) return null

  task.subTasks.push(subTask)
  saveTasks(tasks)
  return task
}

/** 更新子任务状态 */
export function updateSubTaskStatus(
  taskId: string,
  subTaskId: string,
  status: SubTask['status'],
  output?: string,
  error?: string
): Task | null {
  const tasks = getTasks()
  const task = tasks.find((t) => t.id === taskId)
  if (!task) return null

  const subTask = task.subTasks.find((st) => st.id === subTaskId)
  if (!subTask) return null

  subTask.status = status
  if (output) subTask.output = output
  if (error) subTask.error = error
  if (status === 'running' && !subTask.startedAt) {
    subTask.startedAt = Date.now()
  }
  if (status === 'completed' || status === 'failed') {
    subTask.completedAt = Date.now()
  }

  saveTasks(tasks)
  return task
}

/** 任务拆解（LLM 拆解，需已注入 decomposer） */
export async function decomposeTask(
  taskId: string,
  decomposeFn?: TaskDecomposer
): Promise<SubTask[]> {
  const task = getTask(taskId)
  if (!task) return []

  const decompose = decomposeFn ?? platformDecomposer
  if (!decompose) {
    throw new Error('智能拆解不可用：请先在「LLM 网关」页配置并启用模型')
  }
  const descriptions = await decompose(task.description)

  const subTasks: SubTask[] = descriptions.map((desc, index) => ({
    id: `subtask-${taskId}-${index}`,
    description: desc,
    assignedAgent: task.assignedAgents[index % Math.max(task.assignedAgents.length, 1)] || '',
    status: 'pending'
  }))

  // 保存子任务
  const tasks = getTasks()
  const t = tasks.find((x) => x.id === taskId)
  if (t) {
    t.subTasks = subTasks
    saveTasks(tasks)
  }

  return subTasks
}

/** 分配子任务到 Agent */
export function assignSubTask(taskId: string, subTaskId: string, agentId: string): boolean {
  const tasks = getTasks()
  const task = tasks.find((t) => t.id === taskId)
  if (!task) return false

  const subTask = task.subTasks.find((st) => st.id === subTaskId)
  if (!subTask) return false

  subTask.assignedAgent = agentId
  saveTasks(tasks)
  return true
}

/** 执行子任务：约束校验 → 真实执行 → 信任度回写 */
export async function executeSubTask(
  taskId: string,
  subTaskId: string,
  executeFn?: TaskExecutor
): Promise<string> {
  const task = getTask(taskId)
  if (!task) return ''

  const subTask = task.subTasks.find((st) => st.id === subTaskId)
  if (!subTask) return ''

  // 执行前约束校验：block 直接失败；warn 记入输出前缀
  const warnings: string[] = []
  for (const violation of validateConstraints(subTask.assignedAgent, {
    currentHour: new Date().getHours()
  })) {
    const handled = handleViolation(violation)
    if (!handled.allowed) {
      updateSubTaskStatus(taskId, subTaskId, 'failed', undefined, handled.message)
      return ''
    }
    if (handled.message) warnings.push(handled.message)
  }

  updateSubTaskStatus(taskId, subTaskId, 'running')

  const execute = executeFn ?? platformExecutor
  const started = Date.now()
  try {
    if (!execute) {
      throw new Error('任务执行器未初始化：请先在「LLM 网关」页配置并启用模型')
    }
    const result = await execute(subTask.assignedAgent, subTask.description)
    const raw = typeof result === 'string' ? result : result.output
    const output = warnings.length > 0 ? `${warnings.join('；')}\n${raw}` : raw
    // 自动路由时把实际选中的模型回写到子任务，保证 UI 可观测
    if (!subTask.assignedAgent && typeof result === 'object' && result.modelId) {
      subTask.assignedAgent = result.modelId
      const tasks2 = getTasks()
      const t2 = tasks2.find((x) => x.id === taskId)
      const st2 = t2?.subTasks.find((x) => x.id === subTaskId)
      if (t2 && st2) {
        st2.assignedAgent = result.modelId
        saveTasks(tasks2)
      }
    }
    updateSubTaskStatus(taskId, subTaskId, 'completed', output)
    updateTrustScore(subTask.assignedAgent, true, Date.now() - started)
    return output
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    updateSubTaskStatus(taskId, subTaskId, 'failed', undefined, error)
    updateTrustScore(subTask.assignedAgent, false, Date.now() - started)
    recordFrictionPoint({
      id: `fp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      agentId: subTask.assignedAgent,
      taskId,
      description: error,
      category: 'error',
      createdAt: Date.now()
    })
    return ''
  }
}

/** 监控任务执行状态 */
export function monitorExecution(taskId: string): Task | null {
  return getTask(taskId)
}

/** 取消任务 */
export function cancelTask(taskId: string): boolean {
  const task = updateTaskStatus(taskId, 'cancelled')
  if (!task) return false

  // 取消所有未完成的子任务
  for (const subTask of task.subTasks) {
    if (subTask.status === 'pending' || subTask.status === 'running') {
      updateSubTaskStatus(taskId, subTask.id, 'failed', undefined, '任务已取消')
    }
  }

  return true
}

/** 检查任务依赖是否满足 */
export function checkDependencies(taskId: string): boolean {
  const task = getTask(taskId)
  if (!task || task.dependencies.length === 0) return true

  const tasks = getTasks()
  for (const depId of task.dependencies) {
    const dep = tasks.find((t) => t.id === depId)
    if (!dep || dep.status !== 'completed') {
      return false
    }
  }
  return true
}

/** 获取可执行的任务（依赖已满足） */
export function getReadyTasks(): Task[] {
  const tasks = getTasks()
  return tasks.filter((t) => t.status === 'pending' && checkDependencies(t.id))
}
