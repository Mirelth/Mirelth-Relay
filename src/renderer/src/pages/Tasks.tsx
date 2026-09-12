import { useEffect, useState } from 'react'

interface Task {
  id: string
  title: string
  description: string
  status: string
  mode: string
  subTasks: SubTask[]
  assignedAgents: string[]
  createdAt: number
  completedAt?: number
}

interface SubTask {
  id: string
  description: string
  assignedAgent: string
  status: string
  output?: string
  error?: string
}

export default function Tasks() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [newTask, setNewTask] = useState({ title: '', description: '', mode: 'sequential', agents: [] })

  const loadTasks = async () => {
    setLoading(true)
    try {
      const data = await window.api.tasksList()
      setTasks(data || [])
    } catch (err) {
      console.error('加载任务失败:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadTasks()
  }, [])

  const handleCreate = async () => {
    try {
      await window.api.tasksCreate(newTask)
      setShowCreate(false)
      setNewTask({ title: '', description: '', mode: 'sequential', agents: [] })
      loadTasks()
    } catch (err) {
      console.error('创建任务失败:', err)
    }
  }

  const handleDecompose = async (taskId: string) => {
    try {
      await window.api.tasksDecompose(taskId)
      loadTasks()
    } catch (err) {
      console.error('任务拆解失败:', err)
    }
  }

  const handleCancel = async (taskId: string) => {
    try {
      await window.api.tasksCancel(taskId)
      loadTasks()
    } catch (err) {
      console.error('取消任务失败:', err)
    }
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed': return 'bg-green-100 text-green-800'
      case 'failed': return 'bg-red-100 text-red-800'
      case 'running': return 'bg-blue-100 text-blue-800'
      case 'cancelled': return 'bg-gray-100 text-gray-800'
      default: return 'bg-yellow-100 text-yellow-800'
    }
  }

  const getStatusText = (status: string) => {
    switch (status) {
      case 'completed': return '已完成'
      case 'failed': return '失败'
      case 'running': return '运行中'
      case 'cancelled': return '已取消'
      default: return '待执行'
    }
  }

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">任务管理</h1>
        <button
          onClick={() => setShowCreate(true)}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          创建任务
        </button>
      </div>

      {/* 创建任务对话框 */}
      {showCreate && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-full max-w-lg">
            <h2 className="text-xl font-bold mb-4">创建新任务</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">任务标题</label>
                <input
                  type="text"
                  value={newTask.title}
                  onChange={(e) => setNewTask({ ...newTask, title: e.target.value })}
                  className="w-full px-3 py-2 border rounded"
                  placeholder="输入任务标题"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">任务描述</label>
                <textarea
                  value={newTask.description}
                  onChange={(e) => setNewTask({ ...newTask, description: e.target.value })}
                  className="w-full px-3 py-2 border rounded"
                  rows={4}
                  placeholder="详细描述任务内容"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">协作模式</label>
                <select
                  value={newTask.mode}
                  onChange={(e) => setNewTask({ ...newTask, mode: e.target.value })}
                  className="w-full px-3 py-2 border rounded"
                >
                  <option value="sequential">顺序执行</option>
                  <option value="parallel">并行执行</option>
                  <option value="supervisor">主从协作</option>
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setShowCreate(false)}
                className="px-4 py-2 border rounded hover:bg-gray-50"
              >
                取消
              </button>
              <button
                onClick={handleCreate}
                disabled={!newTask.title || !newTask.description}
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                创建
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 任务列表 */}
      {loading ? (
        <p className="text-gray-500">加载中...</p>
      ) : tasks.length > 0 ? (
        <div className="space-y-4">
          {tasks.map((task) => (
            <div key={task.id} className="border rounded-lg p-4 bg-white">
              <div className="flex justify-between items-start mb-3">
                <div>
                  <h3 className="text-lg font-semibold">{task.title}</h3>
                  <p className="text-sm text-gray-600 mt-1">{task.description}</p>
                </div>
                <span className={`px-3 py-1 rounded text-sm ${getStatusColor(task.status)}`}>
                  {getStatusText(task.status)}
                </span>
              </div>

              <div className="text-sm text-gray-500 mb-3">
                <span className="mr-4">模式：{task.mode}</span>
                <span className="mr-4">Agent：{task.assignedAgents.join(', ') || '未分配'}</span>
                <span>创建时间：{new Date(task.createdAt).toLocaleString()}</span>
              </div>

              {/* 子任务列表 */}
              {task.subTasks.length > 0 && (
                <div className="mt-4 border-t pt-4">
                  <h4 className="font-medium mb-2">子任务 ({task.subTasks.length})</h4>
                  <div className="space-y-2">
                    {task.subTasks.map((subTask) => (
                      <div key={subTask.id} className="flex items-center gap-3 p-2 bg-gray-50 rounded">
                        <span className={`w-2 h-2 rounded-full ${
                          subTask.status === 'completed' ? 'bg-green-500' :
                          subTask.status === 'failed' ? 'bg-red-500' :
                          subTask.status === 'running' ? 'bg-blue-500' : 'bg-gray-300'
                        }`}></span>
                        <span className="flex-1 text-sm">{subTask.description}</span>
                        <span className="text-xs text-gray-500">{subTask.assignedAgent || '未分配'}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 操作按钮 */}
              <div className="flex gap-2 mt-4">
                {task.status === 'pending' && task.subTasks.length === 0 && (
                  <button
                    onClick={() => handleDecompose(task.id)}
                    className="px-3 py-1 text-sm bg-purple-600 text-white rounded hover:bg-purple-700"
                  >
                    拆解任务
                  </button>
                )}
                {task.status !== 'completed' && task.status !== 'cancelled' && (
                  <button
                    onClick={() => handleCancel(task.id)}
                    className="px-3 py-1 text-sm bg-red-600 text-white rounded hover:bg-red-700"
                  >
                    取消任务
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-center py-12 text-gray-500">
          <p>暂无任务</p>
          <p className="text-sm mt-2">点击"创建任务"开始</p>
        </div>
      )}
    </div>
  )
}
