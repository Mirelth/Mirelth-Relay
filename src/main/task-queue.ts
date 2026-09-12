/**
 * 任务队列管理
 */
import { logger } from './lib/logger'
import { executeSubTask, updateTaskStatus, getTask } from './execution-engine'

export type QueueStatus = 'idle' | 'running' | 'paused'

interface QueueItem {
  taskId: string
  subTaskIndex: number
  priority: number
  addedAt: number
}

let queue: QueueItem[] = []
let queueStatus: QueueStatus = 'idle'
let pumping = false

/** 获取队列状态 */
export function getQueueStatus(): { status: QueueStatus; size: number } {
  return {
    status: queueStatus,
    size: queue.length
  }
}

/** 添加任务到队列 */
export function enqueue(taskId: string, priority = 0): void {
  const task = getTask(taskId)
  if (!task) return

  // 为每个未完成的子任务创建队列项
  task.subTasks.forEach((st, index) => {
    if (st.status === 'pending') {
      queue.push({ taskId, subTaskIndex: index, priority, addedAt: Date.now() })
    }
  })

  // 按优先级排序
  queue.sort((a, b) => b.priority - a.priority)

  logger.info('queue', `任务已入队：${taskId}，队列大小：${queue.length}`)

  if (queueStatus === 'idle' || queueStatus === 'paused') startProcessing()
}

/** 开始处理队列 */
function startProcessing(): void {
  queueStatus = 'running'
  logger.info('queue', '开始处理任务队列')
  void pump()
}

/** 串行消费队列：同一时刻只有一个子任务在执行（防重入） */
async function pump(): Promise<void> {
  if (pumping) return
  pumping = true
  try {
    while (queue.length > 0 && queueStatus === 'running') {
      const item = queue.shift()
      if (!item) break

      const task = getTask(item.taskId)
      const subTask = task?.subTasks[item.subTaskIndex]
      if (!task || !subTask || subTask.status !== 'pending') continue

      try {
        logger.info('queue', `执行子任务：${subTask.id}`)
        await executeSubTask(item.taskId, subTask.id)

        const updated = getTask(item.taskId)
        if (updated && updated.subTasks.length > 0) {
          const allCompleted = updated.subTasks.every((st) => st.status === 'completed')
          const anyFailed = updated.subTasks.some((st) => st.status === 'failed')
          if (allCompleted) {
            updateTaskStatus(item.taskId, 'completed')
            logger.info('queue', `任务已完成：${item.taskId}`)
          } else if (anyFailed) {
            updateTaskStatus(item.taskId, 'failed')
            logger.warn('queue', `任务失败：${item.taskId}`)
          }
        }
      } catch (err) {
        logger.error('queue', `子任务执行失败：${err}`)
      }
    }
  } finally {
    pumping = false
  }
  if (queue.length === 0) stopProcessing()
}

/** 停止处理 */
function stopProcessing(): void {
  if (queueStatus !== 'paused') queueStatus = 'idle'
  logger.info('queue', `任务队列${queueStatus === 'paused' ? '已暂停' : '已空闲'}`)
}

/** 暂停队列：当前正在执行的子任务会跑完，之后不再取新任务 */
export function pauseQueue(): void {
  queueStatus = 'paused'
  logger.info('queue', '任务队列已暂停')
}

/** 恢复队列 */
export function resumeQueue(): void {
  if (queueStatus === 'paused') {
    if (queue.length > 0) startProcessing()
    else queueStatus = 'idle'
  }
}

/** 清空队列 */
export function clearQueue(): void {
  queue = []
  stopProcessing()
  logger.info('queue', '任务队列已清空')
}

/** 获取队列中的所有任务 ID */
export function getQueuedTaskIds(): string[] {
  return [...new Set(queue.map((item) => item.taskId))]
}
