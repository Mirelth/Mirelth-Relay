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
let processingInterval: NodeJS.Timeout | null = null

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

  // 为每个子任务创建队列项
  task.subTasks.forEach((_, index) => {
    queue.push({
      taskId,
      subTaskIndex: index,
      priority,
      addedAt: Date.now()
    })
  })

  // 按优先级排序
  queue.sort((a, b) => b.priority - a.priority)

  logger.info('queue', `任务已入队：${taskId}，队列大小：${queue.length}`)

  // 如果队列空闲，开始处理
  if (queueStatus === 'idle') {
    startProcessing()
  }
}

/** 开始处理队列 */
function startProcessing(): void {
  if (processingInterval) return

  queueStatus = 'running'
  logger.info('queue', '开始处理任务队列')

  processingInterval = setInterval(() => {
    processNext()
  }, 1000) // 每秒检查一次
}

/** 处理下一个任务 */
async function processNext(): Promise<void> {
  if (queue.length === 0) {
    stopProcessing()
    return
  }

  const item = queue.shift()
  if (!item) return

  const task = getTask(item.taskId)
  if (!task || task.subTasks.length <= item.subTaskIndex) {
    processNext()
    return
  }

  const subTask = task.subTasks[item.subTaskIndex]
  if (subTask.status !== 'pending') {
    processNext()
    return
  }

  try {
    logger.info('queue', `执行子任务：${subTask.id}`)
    await executeSubTask(item.taskId, subTask.id)

    // 检查任务是否完成
    const updatedTask = getTask(item.taskId)
    if (updatedTask) {
      const allCompleted = updatedTask.subTasks.every((st) => st.status === 'completed')
      const anyFailed = updatedTask.subTasks.some((st) => st.status === 'failed')

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

  // 继续处理下一个
  processNext()
}

/** 停止处理 */
function stopProcessing(): void {
  if (processingInterval) {
    clearInterval(processingInterval)
    processingInterval = null
  }
  queueStatus = 'idle'
  logger.info('queue', '任务队列已停止')
}

/** 暂停队列 */
export function pauseQueue(): void {
  stopProcessing()
  queueStatus = 'paused'
  logger.info('queue', '任务队列已暂停')
}

/** 恢复队列 */
export function resumeQueue(): void {
  if (queueStatus === 'paused' && queue.length > 0) {
    startProcessing()
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
