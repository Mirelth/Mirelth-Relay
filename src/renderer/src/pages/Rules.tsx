import { useEffect, useState } from 'react'

interface Constraint {
  id: string
  agentId: string
  type: string
  config: {
    maxTokensPerDay?: number
    allowedModels?: string[]
    maxCostPerDay?: number
    allowedHours?: [number, number]
  }
  action: string
  enabled: boolean
  createdAt: number
}

export default function Rules() {
  const [constraints, setConstraints] = useState<Constraint[]>([])
  const [loading, setLoading] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [newConstraint, setNewConstraint] = useState({
    agentId: '',
    type: 'token-limit',
    config: {},
    action: 'warn',
    enabled: true
  })

  const loadConstraints = async () => {
    setLoading(true)
    try {
      const data = await window.api.constraintsList()
      setConstraints(data || [])
    } catch (err) {
      console.error('加载约束失败:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadConstraints()
  }, [])

  const handleCreate = async () => {
    try {
      await window.api.constraintsAdd(newConstraint)
      setShowCreate(false)
      setNewConstraint({ agentId: '', type: 'token-limit', config: {}, action: 'warn', enabled: true })
      loadConstraints()
    } catch (err) {
      console.error('创建约束失败:', err)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('确定要删除这个约束吗？')) return
    try {
      await window.api.constraintsDelete(id)
      loadConstraints()
    } catch (err) {
      console.error('删除约束失败:', err)
    }
  }

  const handleToggle = async (constraint: Constraint) => {
    try {
      await window.api.constraintsUpdate(constraint.id, { enabled: !constraint.enabled })
      loadConstraints()
    } catch (err) {
      console.error('更新约束失败:', err)
    }
  }

  const getTypeText = (type: string) => {
    switch (type) {
      case 'token-limit': return 'Token 限额'
      case 'model-whitelist': return '模型白名单'
      case 'cost-cap': return '成本上限'
      case 'time-window': return '时间窗口'
      default: return type
    }
  }

  const getActionText = (action: string) => {
    switch (action) {
      case 'block': return '阻止'
      case 'warn': return '警告'
      case 'log': return '仅记录'
      default: return action
    }
  }

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Agent 约束规则</h1>
        <button
          onClick={() => setShowCreate(true)}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          添加约束
        </button>
      </div>

      {/* 创建约束对话框 */}
      {showCreate && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-full max-w-lg">
            <h2 className="text-xl font-bold mb-4">添加约束</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Agent ID</label>
                <input
                  type="text"
                  value={newConstraint.agentId}
                  onChange={(e) => setNewConstraint({ ...newConstraint, agentId: e.target.value })}
                  className="w-full px-3 py-2 border rounded"
                  placeholder="例如：claude-code"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">约束类型</label>
                <select
                  value={newConstraint.type}
                  onChange={(e) => setNewConstraint({ ...newConstraint, type: e.target.value })}
                  className="w-full px-3 py-2 border rounded"
                >
                  <option value="token-limit">Token 限额</option>
                  <option value="model-whitelist">模型白名单</option>
                  <option value="cost-cap">成本上限</option>
                  <option value="time-window">时间窗口</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">违反时动作</label>
                <select
                  value={newConstraint.action}
                  onChange={(e) => setNewConstraint({ ...newConstraint, action: e.target.value })}
                  className="w-full px-3 py-2 border rounded"
                >
                  <option value="block">阻止执行</option>
                  <option value="warn">警告但继续</option>
                  <option value="log">仅记录日志</option>
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
                disabled={!newConstraint.agentId}
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                创建
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 约束列表 */}
      {loading ? (
        <p className="text-gray-500">加载中...</p>
      ) : constraints.length > 0 ? (
        <div className="space-y-3">
          {constraints.map((constraint) => (
            <div key={constraint.id} className="border rounded-lg p-4 bg-white">
              <div className="flex justify-between items-start">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <h3 className="font-semibold">{getTypeText(constraint.type)}</h3>
                    <span className={`px-2 py-1 rounded text-xs ${
                      constraint.enabled ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'
                    }`}>
                      {constraint.enabled ? '已启用' : '已禁用'}
                    </span>
                    <span className="px-2 py-1 rounded text-xs bg-blue-100 text-blue-800">
                      {getActionText(constraint.action)}
                    </span>
                  </div>
                  <div className="text-sm text-gray-600">
                    <span className="mr-4">Agent：{constraint.agentId}</span>
                    <span>创建时间：{new Date(constraint.createdAt).toLocaleString()}</span>
                  </div>
                  {constraint.config.maxTokensPerDay && (
                    <div className="text-sm text-gray-500 mt-2">
                      每日 Token 限额：{constraint.config.maxTokensPerDay.toLocaleString()}
                    </div>
                  )}
                  {constraint.config.maxCostPerDay && (
                    <div className="text-sm text-gray-500 mt-2">
                      每日成本上限：${constraint.config.maxCostPerDay.toFixed(2)}
                    </div>
                  )}
                  {constraint.config.allowedModels && constraint.config.allowedModels.length > 0 && (
                    <div className="text-sm text-gray-500 mt-2">
                      允许模型：{constraint.config.allowedModels.join(', ')}
                    </div>
                  )}
                  {constraint.config.allowedHours && (
                    <div className="text-sm text-gray-500 mt-2">
                      允许时段：{constraint.config.allowedHours[0]}:00 - {constraint.config.allowedHours[1]}:00
                    </div>
                  )}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleToggle(constraint)}
                    className="px-3 py-1 text-sm border rounded hover:bg-gray-50"
                  >
                    {constraint.enabled ? '禁用' : '启用'}
                  </button>
                  <button
                    onClick={() => handleDelete(constraint.id)}
                    className="px-3 py-1 text-sm bg-red-600 text-white rounded hover:bg-red-700"
                  >
                    删除
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-center py-12 text-gray-500">
          <p>暂无约束规则</p>
          <p className="text-sm mt-2">点击"添加约束"开始配置</p>
        </div>
      )}
    </div>
  )
}
