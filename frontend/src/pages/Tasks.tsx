import { useCallback, useEffect, useState } from 'react'
import { ListTodo, Play, Plus, RefreshCw, Scissors, Square } from 'lucide-react'
import type { Task, SubTask, TaskStatus, CollaborationMode } from '@shared/task-types'
import type { GwGatewayView } from '@shared/types'
import { relativeTime } from '../lib/format'

const STATUS_BADGE: Record<TaskStatus, { label: string; color: string }> = {
  pending: { label: '待执行', color: 'var(--warn)' },
  running: { label: '运行中', color: 'var(--accent)' },
  completed: { label: '已完成', color: 'var(--ok)' },
  failed: { label: '失败', color: 'var(--bad)' },
  cancelled: { label: '已取消', color: 'var(--muted)' }
}

const SUB_DOT: Record<SubTask['status'], string> = {
  pending: 'var(--muted)',
  running: 'var(--accent)',
  completed: 'var(--ok)',
  failed: 'var(--bad)'
}

const MODE_LABEL: Record<CollaborationMode, string> = {
  sequential: '顺序执行',
  parallel: '并行执行',
  supervisor: '主从协作'
}

function TaskForm({
  models,
  onCancel,
  onCreate
}: {
  models: { id: string; name: string }[]
  onCancel: () => void
  onCreate: (input: {
    title: string
    description: string
    mode: CollaborationMode
    agents: string[]
  }) => void
}): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [mode, setMode] = useState<CollaborationMode>('sequential')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  return (
    <div className="card space-y-3 p-4">
      <label className="grid gap-1">
        <span className="text-xs" style={{ color: 'var(--muted)' }}>
          任务标题
        </span>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="grid gap-1">
        <span className="text-xs" style={{ color: 'var(--muted)' }}>
          任务描述（拆解与执行都以这段描述为依据）
        </span>
        <textarea
          className="input min-h-24 text-sm"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="grid gap-1">
          <span className="text-xs" style={{ color: 'var(--muted)' }}>
            协作模式
          </span>
          <select
            className="input"
            value={mode}
            onChange={(e) => setMode(e.target.value as CollaborationMode)}
          >
            <option value="sequential">顺序执行</option>
            <option value="parallel">并行执行</option>
            <option value="supervisor">主从协作</option>
          </select>
        </label>
        <div className="grid gap-1">
          <span className="text-xs" style={{ color: 'var(--muted)' }}>
            指定执行模型（不选 = 按复杂度自动路由）
          </span>
          <div className="flex flex-wrap gap-1.5">
            {models.length === 0 && (
              <span className="text-xs" style={{ color: 'var(--bad)' }}>
                网关还没有已启用模型，请先到「LLM 网关」页添加
              </span>
            )}
            {models.map((m) => (
              <button
                key={m.id}
                className="badge"
                style={{
                  background: picked.has(m.id)
                    ? 'color-mix(in srgb, var(--accent) 20%, transparent)'
                    : 'color-mix(in srgb, var(--muted) 12%, transparent)',
                  color: picked.has(m.id) ? 'var(--accent)' : 'var(--muted)'
                }}
                onClick={() =>
                  setPicked((prev) => {
                    const next = new Set(prev)
                    if (next.has(m.id)) next.delete(m.id)
                    else next.add(m.id)
                    return next
                  })
                }
              >
                {m.name}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <button className="btn" onClick={onCancel}>
          取消
        </button>
        <button
          className="btn btn-primary"
          disabled={!title.trim() || !description.trim()}
          onClick={() =>
            onCreate({
              title: title.trim(),
              description: description.trim(),
              mode,
              agents: [...picked]
            })
          }
        >
          创建任务
        </button>
      </div>
    </div>
  )
}

export default function Tasks(): React.JSX.Element {
  const [tasks, setTasks] = useState<Task[]>([])
  const [gw, setGw] = useState<GwGatewayView | null>(null)
  const [queue, setQueue] = useState<{ status: string; size: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const reload = useCallback(async (): Promise<void> => {
    try {
      const [t, g, q] = await Promise.all([
        window.api.tasksList(),
        window.api.gwGet(),
        window.api.queueStatus()
      ])
      setTasks(t || [])
      setGw(g)
      setQueue(q)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
    const timer = setInterval(() => void reload(), 4000)
    return () => clearInterval(timer)
  }, [reload])

  const act = async (fn: () => Promise<unknown>, okMsg?: string): Promise<void> => {
    setError('')
    try {
      await fn()
      if (okMsg) setError(okMsg)
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      await reload()
    }
  }

  const modelName = (id: string): string =>
    gw?.models.find((m) => m.id === id)?.name ?? (id || '自动路由')

  const toggleExpand = (subId: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(subId)) next.delete(subId)
      else next.add(subId)
      return next
    })

  const models = (gw?.models ?? []).filter((m) => m.enabled)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm" style={{ color: 'var(--muted)' }}>
          任务由「LLM 网关」的模型真实执行：智能拆解 → 按复杂度路由 →
          逐个执行。约束规则页可对执行模型设限。
        </div>
        <div className="flex items-center gap-2">
          {queue && queue.status !== 'idle' && (
            <span
              className="badge"
              style={{
                background: 'color-mix(in srgb, var(--accent) 14%, transparent)',
                color: 'var(--accent)'
              }}
            >
              队列{queue.status === 'running' ? '执行中' : '已暂停'} · {queue.size}
            </span>
          )}
          {queue?.status === 'running' ? (
            <button className="btn" onClick={() => void act(() => window.api.queuePause())}>
              <Square size={13} />
              暂停队列
            </button>
          ) : (
            <button className="btn" onClick={() => void act(() => window.api.queueResume())}>
              <Play size={13} />
              恢复队列
            </button>
          )}
          <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
            <Plus size={14} />
            创建任务
          </button>
        </div>
      </div>

      {error && (
        <div className="card p-3 text-sm" style={{ color: 'var(--bad)' }}>
          {error}
        </div>
      )}

      {models.length === 0 && !loading && (
        <div className="card p-4 text-sm" style={{ color: 'var(--warn)' }}>
          LLM 网关还没有已启用的模型，创建任务前请先到「LLM 网关」页添加并启用至少一个模型。
        </div>
      )}

      {showCreate && gw && (
        <TaskForm
          models={models}
          onCancel={() => setShowCreate(false)}
          onCreate={(input) => {
            setShowCreate(false)
            void act(() => window.api.tasksCreate({ ...input, dependencies: [] }))
          }}
        />
      )}

      {loading ? (
        <div className="text-sm" style={{ color: 'var(--muted)' }}>
          加载中…
        </div>
      ) : tasks.length === 0 ? (
        <div className="card flex flex-col items-center gap-2 p-12 text-center">
          <ListTodo size={28} style={{ color: 'var(--muted)' }} />
          <div className="text-sm font-medium">暂无任务</div>
          <div className="text-xs" style={{ color: 'var(--muted)' }}>
            点击「创建任务」，描述要做的事，系统会用网关模型拆解并执行
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {tasks.map((task) => {
            const sv = STATUS_BADGE[task.status] ?? STATUS_BADGE.pending
            const runningCount = task.subTasks.filter((s) => s.status === 'running').length
            return (
              <div key={task.id} className="card space-y-3 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{task.title}</span>
                  <span
                    className="badge"
                    style={{
                      background: `color-mix(in srgb, ${sv.color} 16%, transparent)`,
                      color: sv.color
                    }}
                  >
                    {sv.label}
                  </span>
                  <span
                    className="badge"
                    style={{
                      background: 'color-mix(in srgb, var(--muted) 12%, transparent)',
                      color: 'var(--muted)'
                    }}
                  >
                    {MODE_LABEL[task.mode] ?? task.mode}
                  </span>
                  <span className="ml-auto text-xs" style={{ color: 'var(--muted)' }}>
                    {relativeTime(new Date(task.createdAt).toISOString())}
                  </span>
                </div>
                <div className="text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>
                  {task.description}
                </div>

                {task.subTasks.length > 0 && (
                  <div
                    className="space-y-1.5 rounded-lg border p-3"
                    style={{ borderColor: 'var(--border)' }}
                  >
                    {task.subTasks.map((st) => (
                      <div key={st.id} className="flex flex-wrap items-center gap-2 text-xs">
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ background: SUB_DOT[st.status] ?? 'var(--muted)' }}
                        />
                        <span className="min-w-0 flex-1 truncate" title={st.description}>
                          {st.description}
                        </span>
                        <span
                          className="badge shrink-0"
                          style={{
                            background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
                            color: 'var(--accent)'
                          }}
                        >
                          {modelName(st.assignedAgent)}
                        </span>
                        {(st.output || st.error) && (
                          <button
                            className="btn shrink-0"
                            onClick={() => toggleExpand(st.id)}
                            style={{ color: st.error ? 'var(--bad)' : undefined }}
                          >
                            {st.error ? '错误' : '输出'}
                          </button>
                        )}
                      </div>
                    ))}
                    {task.subTasks.map((st) =>
                      expanded.has(st.id) && (st.output || st.error) ? (
                        <pre
                          key={`${st.id}-out`}
                          className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border p-3 font-mono text-xs"
                          style={{
                            borderColor: 'var(--border)',
                            color: st.error ? 'var(--bad)' : 'var(--text)'
                          }}
                        >
                          {st.error ?? st.output}
                        </pre>
                      ) : null
                    )}
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  {task.status === 'pending' && task.subTasks.length === 0 && (
                    <button
                      className="btn btn-primary"
                      onClick={() =>
                        void act(() => window.api.tasksDecompose(task.id), '已生成子任务')
                      }
                      disabled={models.length === 0}
                    >
                      <Scissors size={13} />
                      智能拆解
                    </button>
                  )}
                  {task.status === 'pending' && task.subTasks.length > 0 && (
                    <button
                      className="btn btn-primary"
                      onClick={() =>
                        void act(() => window.api.queueEnqueue(task.id, 0), '已加入执行队列')
                      }
                      disabled={models.length === 0}
                    >
                      <Play size={13} />
                      执行任务
                    </button>
                  )}
                  {task.status !== 'completed' && task.status !== 'cancelled' && (
                    <button
                      className="btn"
                      onClick={() => void act(() => window.api.tasksCancel(task.id))}
                    >
                      取消任务
                    </button>
                  )}
                  {runningCount > 0 && (
                    <span className="text-xs" style={{ color: 'var(--accent)' }}>
                      <RefreshCw size={11} className="mr-1 inline animate-spin" />
                      {runningCount} 个子任务执行中
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
