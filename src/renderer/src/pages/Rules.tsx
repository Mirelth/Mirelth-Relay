import { useCallback, useEffect, useState } from 'react'
import { Plus, Scale, Trash2 } from 'lucide-react'
import type { AgentConstraint, ConstraintAction, ConstraintType } from '@shared/task-types'
import type { GwGatewayView } from '@shared/types'
import { relativeTime } from '../lib/format'

const TYPE_META: Record<ConstraintType, { label: string }> = {
  'token-limit': { label: 'Token 限额' },
  'model-whitelist': { label: '模型白名单' },
  'cost-cap': { label: '成本上限' },
  'time-window': { label: '时间窗口' }
}

const ACTION_META: Record<ConstraintAction, { label: string; color: string }> = {
  block: { label: '阻止', color: 'var(--bad)' },
  warn: { label: '警告', color: 'var(--warn)' },
  log: { label: '仅记录', color: 'var(--muted)' }
}

type Draft = {
  agentId: string
  type: ConstraintType
  action: ConstraintAction
  maxTokensPerDay: string
  allowedModels: string
  maxCostPerDay: string
  hourStart: string
  hourEnd: string
}

const emptyDraft = (): Draft => ({
  agentId: '',
  type: 'token-limit',
  action: 'block',
  maxTokensPerDay: '',
  allowedModels: '',
  maxCostPerDay: '',
  hourStart: '',
  hourEnd: ''
})

function draftToConstraint(d: Draft): {
  agentId: string
  type: ConstraintType
  action: ConstraintAction
  enabled: boolean
  config: AgentConstraint['config']
} {
  const num = (s: string): number | undefined => (Number(s) > 0 ? Number(s) : undefined)
  const hours: [number, number] | undefined =
    Number(d.hourStart) >= 0 && Number(d.hourEnd) > Number(d.hourStart)
      ? [Number(d.hourStart), Number(d.hourEnd)]
      : undefined
  return {
    agentId: d.agentId,
    type: d.type,
    action: d.action,
    enabled: true,
    config: {
      maxTokensPerDay: num(d.maxTokensPerDay),
      maxCostPerDay: num(d.maxCostPerDay),
      allowedModels: d.allowedModels
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean),
      allowedHours: hours
    }
  }
}

function ConstraintForm({
  models,
  onCancel,
  onSave
}: {
  models: { id: string; name: string }[]
  onCancel: () => void
  onSave: (c: ReturnType<typeof draftToConstraint>) => void
}): React.JSX.Element {
  const [d, setD] = useState<Draft>(emptyDraft)
  const set = (patch: Partial<Draft>): void => setD((prev) => ({ ...prev, ...patch }))
  const num = (s: string): boolean => s === '' || (Number(s) > 0 && Number.isFinite(Number(s)))
  const valid =
    d.agentId !== '' &&
    num(d.maxTokensPerDay) &&
    num(d.maxCostPerDay) &&
    num(d.hourStart) &&
    num(d.hourEnd) &&
    (d.type !== 'time-window' ||
      (Number(d.hourStart) >= 0 && Number(d.hourEnd) > Number(d.hourStart)))

  return (
    <div className="card space-y-3 p-4">
      <div className="grid grid-cols-2 gap-3">
        <label className="grid gap-1">
          <span className="text-xs" style={{ color: 'var(--muted)' }}>
            作用对象（执行模型）
          </span>
          <select
            className="input"
            value={d.agentId}
            onChange={(e) => set({ agentId: e.target.value })}
          >
            <option value="">选择模型…</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className="text-xs" style={{ color: 'var(--muted)' }}>
            规则类型
          </span>
          <select
            className="input"
            value={d.type}
            onChange={(e) => set({ type: e.target.value as ConstraintType })}
          >
            {(Object.keys(TYPE_META) as ConstraintType[]).map((t) => (
              <option key={t} value={t}>
                {TYPE_META[t].label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {d.type === 'token-limit' && (
        <label className="grid gap-1">
          <span className="text-xs" style={{ color: 'var(--muted)' }}>
            每日 Token 上限
          </span>
          <input
            className="input"
            placeholder="100000"
            value={d.maxTokensPerDay}
            onChange={(e) => set({ maxTokensPerDay: e.target.value.replace(/\D/g, '') })}
          />
        </label>
      )}
      {d.type === 'cost-cap' && (
        <label className="grid gap-1">
          <span className="text-xs" style={{ color: 'var(--muted)' }}>
            每日成本上限（美元）
          </span>
          <input
            className="input"
            placeholder="5"
            value={d.maxCostPerDay}
            onChange={(e) => set({ maxCostPerDay: e.target.value })}
          />
        </label>
      )}
      {d.type === 'model-whitelist' && (
        <label className="grid gap-1">
          <span className="text-xs" style={{ color: 'var(--muted)' }}>
            允许的模型 ID（逗号分隔，子串匹配）
          </span>
          <input
            className="input font-mono text-xs"
            placeholder="deepseek-chat, gpt-4o-mini"
            value={d.allowedModels}
            onChange={(e) => set({ allowedModels: e.target.value })}
          />
        </label>
      )}
      {d.type === 'time-window' && (
        <div className="grid grid-cols-2 gap-3">
          <label className="grid gap-1">
            <span className="text-xs" style={{ color: 'var(--muted)' }}>
              允许开始（小时）
            </span>
            <input
              className="input"
              placeholder="9"
              value={d.hourStart}
              onChange={(e) => set({ hourStart: e.target.value.replace(/\D/g, '') })}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-xs" style={{ color: 'var(--muted)' }}>
              允许结束（小时，不含）
            </span>
            <input
              className="input"
              placeholder="18"
              value={d.hourEnd}
              onChange={(e) => set({ hourEnd: e.target.value.replace(/\D/g, '') })}
            />
          </label>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <label className="grid gap-1">
          <span className="text-xs" style={{ color: 'var(--muted)' }}>
            触发后动作
          </span>
          <select
            className="input"
            value={d.action}
            onChange={(e) => set({ action: e.target.value as ConstraintAction })}
          >
            <option value="block">阻止执行</option>
            <option value="warn">警告但继续</option>
            <option value="log">仅记录</option>
          </select>
        </label>
      </div>

      <div className="flex justify-end gap-2">
        <button className="btn" onClick={onCancel}>
          取消
        </button>
        <button
          className="btn btn-primary"
          disabled={!valid}
          onClick={() => onSave(draftToConstraint(d))}
        >
          保存规则
        </button>
      </div>
    </div>
  )
}

function describeConfig(c: AgentConstraint): string {
  const cfg = c.config
  switch (c.type) {
    case 'token-limit':
      return `每日 Token ≤ ${cfg.maxTokensPerDay?.toLocaleString() ?? '—'}`
    case 'cost-cap':
      return `每日成本 ≤ $${(cfg.maxCostPerDay ?? 0).toFixed(2)}`
    case 'model-whitelist':
      return `白名单：${cfg.allowedModels?.join(', ') || '—'}`
    case 'time-window':
      return `允许时段 ${cfg.allowedHours?.[0] ?? 0}:00 – ${cfg.allowedHours?.[1] ?? 24}:00`
    default:
      return ''
  }
}

export default function Rules(): React.JSX.Element {
  const [constraints, setConstraints] = useState<AgentConstraint[]>([])
  const [gw, setGw] = useState<GwGatewayView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)

  const reload = useCallback(async (): Promise<void> => {
    try {
      const [list, g] = await Promise.all([window.api.constraintsList(), window.api.gwGet()])
      setConstraints(list || [])
      setGw(g)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setError('')
    try {
      await fn()
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const modelName = (id: string): string =>
    gw?.models.find((m) => m.id === id)?.name ?? id ?? '(未知)'
  const models = (gw?.models ?? []).filter((m) => m.enabled)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm" style={{ color: 'var(--muted)' }}>
          对执行模型的约束：任务执行前会校验，<b>阻止</b>级别不满足时子任务直接失败，<b>警告</b>
          级别提示后继续。
        </div>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
          <Plus size={14} />
          新增规则
        </button>
      </div>

      {error && (
        <div className="card p-3 text-sm" style={{ color: 'var(--bad)' }}>
          {error}
        </div>
      )}

      {showCreate && (
        <ConstraintForm
          models={models}
          onCancel={() => setShowCreate(false)}
          onSave={(c) => {
            setShowCreate(false)
            void act(() => window.api.constraintsAdd(c))
          }}
        />
      )}

      {loading ? (
        <div className="text-sm" style={{ color: 'var(--muted)' }}>
          加载中…
        </div>
      ) : constraints.length === 0 ? (
        <div className="card flex flex-col items-center gap-2 p-12 text-center">
          <Scale size={28} style={{ color: 'var(--muted)' }} />
          <div className="text-sm font-medium">暂无约束规则</div>
          <div className="text-xs" style={{ color: 'var(--muted)' }}>
            例如：给某个模型设每日成本上限，超出后自动阻止其执行任务
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {constraints.map((c) => {
            const am = ACTION_META[c.action] ?? ACTION_META.log
            return (
              <div key={c.id} className="card flex flex-wrap items-center gap-2 p-4">
                <span className="font-medium">{modelName(c.agentId)}</span>
                <span
                  className="badge"
                  style={{
                    background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
                    color: 'var(--accent)'
                  }}
                >
                  {TYPE_META[c.type]?.label ?? c.type}
                </span>
                <span className="text-xs" style={{ color: 'var(--text)' }}>
                  {describeConfig(c)}
                </span>
                <span
                  className="badge"
                  style={{
                    background: `color-mix(in srgb, ${am.color} 14%, transparent)`,
                    color: am.color
                  }}
                >
                  {am.label}
                </span>
                {!c.enabled && (
                  <span
                    className="badge"
                    style={{
                      background: 'color-mix(in srgb, var(--muted) 12%, transparent)',
                      color: 'var(--muted)'
                    }}
                  >
                    已停用
                  </span>
                )}
                <span className="ml-auto text-xs" style={{ color: 'var(--muted)' }}>
                  {relativeTime(new Date(c.createdAt).toISOString())}
                </span>
                <button
                  className="btn"
                  onClick={() =>
                    void act(() => window.api.constraintsUpdate(c.id, { enabled: !c.enabled }))
                  }
                >
                  {c.enabled ? '停用' : '启用'}
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    if (window.confirm('确定删除这条规则？'))
                      void act(() => window.api.constraintsDelete(c.id))
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
