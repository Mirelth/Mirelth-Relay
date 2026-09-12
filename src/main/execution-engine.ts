/**
 * 执行引擎：任务拆解、分配和调度
 */
import { join } from 'path'
import { HOME, readJson } from './lib/fs'
import { logger } from './lib/logger'
import type { Task, SubTask, TaskStatus, CollaborationMode } from '../shared/task-types'

const TASKS_PATH = join(HOME, '.agent-tower', 'tasks.json')

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
    require('fs').writeFileSync(TASKS_PATH, JSON.stringify(tasks, null, 2))
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

/** 任务拆解（基于 LLM） */
export async function decomposeTask(
  taskId: string,
  decomposeFn?: (description: string) => Promise<string[]>
): Promise<SubTask[]> {
  const task = getTask(taskId)
  if (!task) return []

  // 使用提供的拆解函数或默认实现
  const descriptions = decomposeFn
    ? await decomposeFn(task.description)
    : await defaultDecompose(task.description)

  const subTasks: SubTask[] = descriptions.map((desc, index) => ({
    id: `subtask-${taskId}-${index}`,
    description: desc,
    assignedAgent: task.assignedAgents[index % task.assignedAgents.length] || '',
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

/** 默认拆解实现（简单按句子分割） */
async function defaultDecompose(description: string): Promise<string[]> {
  // 实际实现应该调用 LLM API
  // 这里先实现一个简单的基于句号的分割
  const sentences = description
    .split(/[。！？.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10)

  if (sentences.length === 0) {
    return [description]
  }

  return sentences.slice(0, 5) // 最多 5 个子任务
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

/** 执行子任务（通过 CLI 调用 Agent） */
export async function executeSubTask(
  taskId: string,
  subTaskId: string,
  executeFn?: (agentId: string, description: string) => Promise<string>
): Promise<string> {
  const task = getTask(taskId)
  if (!task) return ''

  const subTask = task.subTasks.find((st) => st.id === subTaskId)
  if (!subTask) return ''

  // 更新状态为运行中
  updateSubTaskStatus(taskId, subTaskId, 'running')

  try {
    // 使用提供的执行函数或默认实现
    const output = executeFn
      ? await executeFn(subTask.assignedAgent, subTask.description)
      : await defaultExecute(subTask.assignedAgent, subTask.description)

    updateSubTaskStatus(taskId, subTaskId, 'completed', output)
    return output
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    updateSubTaskStatus(taskId, subTaskId, 'failed', undefined, error)
    return ''
  }
}

/** 默认执行实现（调用 Agent CLI） */
async function defaultExecute(agentId: string, description: string): Promise<string> {
  // 实际实现应该调用对应 Agent 的 CLI
  // 例如：execFileSync('claude', [description])
  logger.info('execution', `执行子任务：${agentId} - ${description.slice(0, 50)}...`)
  return `[${agentId}] 执行完成：${description}`
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
