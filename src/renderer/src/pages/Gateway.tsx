import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CircleStop,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Play,
  Plus,
  RefreshCw,
  Route,
  Trash2
} from 'lucide-react'
import type {
  GwGatewayView,
  GwModelConfig,
  GwModelTier,
  GwModelView,
  GwRequestLogEntry,
  GwSimulationResult
} from '@shared/types'
import { formatDate, relativeTime } from '../lib/format'

/** 视图模型 → 保存载荷：apiKey 恒为空串，store 侧按 id 沿用旧值 */
const toConfig = (v: GwModelView): GwModelConfig => ({ ...v, apiKey: '' })

const TIER_BADGE: Record<GwModelTier, { cls: string; key: string }> = {
  light: { cls: 'var(--ok)', key: 'gateway.tierLight' },
  standard: { cls: 'var(--warn)', key: 'gateway.tierStandard' },
  heavy: { cls: 'var(--bad)', key: 'gateway.tierHeavy' }
}

function CopyBtn({ text, label }: { text: string; label: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [done, setDone] = useState(false)
  return (
    <button
      className="btn shrink-0"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        })
      }}
      title={t('gateway.copy')}
    >
      <Copy size={13} />
      {done ? t('gateway.copied') : label}
    </button>
  )
}

function ModelForm({
  initial,
  onSave,
  onCancel
}: {
  initial?: GwModelConfig
  onSave: (m: GwModelConfig) => void
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [form, setForm] = useState<GwModelConfig>(
    initial ?? {
      id: '',
      name: '',
      kind: 'openai-compatible',
      baseURL: '',
      apiKey: '',
      model: '',
      tier: 'standard',
      enabled: true,
      updatedAt: ''
    }
  )
  const set = (patch: Partial<GwModelConfig>): void => setForm((f) => ({ ...f, ...patch }))
  const field = 'text-xs'
  const inputRow = (label: string, node: React.ReactNode): React.JSX.Element => (
    <label className="grid gap-1">
      <span className={field} style={{ color: 'var(--muted)' }}>
        {label}
      </span>
      {node}
    </label>
  )
  return (
    <div className="card space-y-3 p-4">
      <div className="grid grid-cols-2 gap-3">
        {inputRow(
          t('gateway.modelName'),
          <input
            className="input"
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
          />
        )}
        {inputRow(
          t('gateway.kind'),
          <select
            className="input"
            value={form.kind}
            onChange={(e) => set({ kind: e.target.value as GwModelConfig['kind'] })}
          >
            <option value="openai-compatible">{t('gateway.kindOpenAI')}</option>
            <option value="anthropic">{t('gateway.kindAnthropic')}</option>
          </select>
        )}
      </div>
      {inputRow(
        t('gateway.baseURL'),
        <input
          className="input font-mono text-xs"
          placeholder="https://api.example.com/v1"
          value={form.baseURL}
          onChange={(e) => set({ baseURL: e.target.value })}
        />
      )}
      <div className="grid grid-cols-2 gap-3">
        {inputRow(
          t('gateway.upstreamKey'),
          <input
            className="input font-mono text-xs"
            type="password"
            value={form.apiKey}
            onChange={(e) => set({ apiKey: e.target.value })}
          />
        )}
        {inputRow(
          t('gateway.upstreamModel'),
          <input
            className="input font-mono text-xs"
            placeholder="gpt-4o-mini / deepseek-chat / …"
            value={form.model}
            onChange={(e) => set({ model: e.target.value })}
          />
        )}
      </div>
      <div className="grid grid-cols-2 items-end gap-3">
        {inputRow(
          t('gateway.tier'),
          <select
            className="input"
            value={form.tier}
            onChange={(e) => set({ tier: e.target.value as GwModelTier })}
          >
            <option value="light">{t('gateway.tierLight')}</option>
            <option value="standard">{t('gateway.tierStandard')}</option>
            <option value="heavy">{t('gateway.tierHeavy')}</option>
          </select>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => set({ enabled: e.target.checked })}
          />
          {t('gateway.enabled')}
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <button className="btn" onClick={onCancel}>
          {t('gateway.cancel')}
        </button>
        <button
          className="btn btn-primary"
          onClick={() => onSave({ ...form, name: form.name.trim(), baseURL: form.baseURL.trim() })}
          disabled={!form.name.trim() || !form.baseURL.trim() || !form.model.trim()}
        >
          {t('gateway.save')}
        </button>
      </div>
    </div>
  )
}

function GatewayPage(): React.JSX.Element {
  const { t } = useTranslation()
  const [gw, setGw] = useState<GwGatewayView | null>(null)
  const [logs, setLogs] = useState<GwRequestLogEntry[]>([])
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  const [port, setPort] = useState('')
  const [reveal, setReveal] = useState('')
  const [editing, setEditing] = useState<GwModelConfig | 'new' | null>(null)
  const [testing, setTesting] = useState<string>('')
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; error?: string }>>({})
  const [simText, setSimText] = useState('')
  const [sim, setSim] = useState<GwSimulationResult | null>(null)
  const [simming, setSimming] = useState(false)

  const reload = useCallback(async (): Promise<void> => {
    const [v, l] = await Promise.all([window.api.gwGet(), window.api.gwLogs()])
    setGw(v)
    setLogs(l)
    setName(v.name)
    setPort(String(v.port))
  }, [])

  useEffect(() => {
    void reload()
    // 网关运行中时轮询状态与请求日志，保持页面实时
    const timer = setInterval(() => {
      void (async () => {
        try {
          const [v, l] = await Promise.all([window.api.gwGet(), window.api.gwLogs()])
          setGw(v)
          setLogs(l)
        } catch {
          // 轮询失败静默忽略，下次重试
        }
      })()
    }, 4000)
    return () => clearInterval(timer)
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

  const saveModels = async (models: GwModelConfig[]): Promise<void> => {
    await act(() => window.api.gwUpdate({ models }))
    setEditing(null)
  }

  const runSim = async (): Promise<void> => {
    setSimming(true)
    try {
      setSim(await window.api.gwSimulate(simText))
    } finally {
      setSimming(false)
    }
  }

  const testModel = async (id: string): Promise<void> => {
    setTesting(id)
    try {
      const r = await window.api.gwTestModel(id)
      setTestResult((prev) => ({ ...prev, [id]: r }))
    } finally {
      setTesting('')
    }
  }

  if (!gw) {
    return (
      <div className="text-sm" style={{ color: 'var(--muted)' }}>
        {t('common.loading')}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="card p-4 text-sm" style={{ color: 'var(--bad)' }}>
          {error}
        </div>
      )}

      {/* 状态与接入信息 */}
      <div className="card space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <span
            className="badge"
            style={{
              background: `color-mix(in srgb, ${gw.running ? 'var(--ok)' : 'var(--muted)'} 16%, transparent)`,
              color: gw.running ? 'var(--ok)' : 'var(--muted)'
            }}
          >
            {gw.running ? t('gateway.running') : t('gateway.stopped')}
          </span>
          <input
            className="input max-w-56"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() =>
              name.trim() &&
              name !== gw.name &&
              void act(() => window.api.gwUpdate({ name: name.trim() }))
            }
          />
          <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--muted)' }}>
            {t('gateway.port')}
            <input
              className="input w-24"
              value={port}
              onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
              onBlur={() =>
                Number(port) > 0 &&
                Number(port) !== gw.port &&
                void act(() => window.api.gwUpdate({ port: Number(port) }))
              }
            />
          </label>
          <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--muted)' }}>
            <input
              type="checkbox"
              checked={gw.autoStart}
              onChange={(e) => void act(() => window.api.gwUpdate({ autoStart: e.target.checked }))}
            />
            {t('gateway.autoStart')}
          </label>
          <div className="ml-auto flex gap-2">
            {gw.running ? (
              <button className="btn" onClick={() => void act(() => window.api.gwStop())}>
                <CircleStop size={14} />
                {t('gateway.stop')}
              </button>
            ) : (
              <button
                className="btn btn-primary"
                onClick={() => void act(() => window.api.gwStart())}
              >
                <Play size={14} />
                {t('gateway.start')}
              </button>
            )}
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}>
            <div className="text-xs" style={{ color: 'var(--muted)' }}>
              {t('gateway.endpoint')}
            </div>
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate font-mono text-sm">
                {gw.endpoint || '—'}
              </code>
              {gw.running && <CopyBtn text={gw.endpoint} label={t('gateway.copy')} />}
            </div>
          </div>
          <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}>
            <div className="text-xs" style={{ color: 'var(--muted)' }}>
              {t('gateway.apiKey')}
            </div>
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate font-mono text-sm">
                {reveal || gw.keyMasked}
              </code>
              <button
                className="btn shrink-0"
                onClick={() => void window.api.gwRevealKey().then(setReveal)}
              >
                {reveal ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
              {reveal && <CopyBtn text={reveal} label={t('gateway.copy')} />}
              <button
                className="btn shrink-0"
                title={t('gateway.regenKey')}
                onClick={() =>
                  void act(() => window.api.gwRegenerateKey()).then(() => setReveal(''))
                }
              >
                <RefreshCw size={13} />
              </button>
            </div>
          </div>
        </div>
        <div className="text-xs" style={{ color: 'var(--muted)' }}>
          {t('gateway.bindHint')}
        </div>
      </div>

      {/* 模型列表 */}
      <div className="card overflow-hidden">
        <div
          className="flex items-center justify-between border-b px-4 py-3"
          style={{ borderColor: 'var(--border)' }}
        >
          <div className="text-sm font-medium">
            {t('gateway.models')}（{gw.models.length}）
          </div>
          <button className="btn btn-primary" onClick={() => setEditing('new')}>
            <Plus size={14} />
            {t('gateway.addModel')}
          </button>
        </div>
        {gw.models.length === 0 && !editing && (
          <div className="px-4 py-10 text-center text-sm" style={{ color: 'var(--muted)' }}>
            {t('gateway.noModels')}
          </div>
        )}
        <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
          {gw.models.map((m) => {
            const tb = TIER_BADGE[m.tier]
            const tr = testResult[m.id]
            return (
              <div key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <KeyRound
                  size={15}
                  style={{ color: m.enabled ? 'var(--accent)' : 'var(--muted)' }}
                />
                <span
                  className="font-medium"
                  style={{ color: m.enabled ? undefined : 'var(--muted)' }}
                >
                  {m.name}
                </span>
                <span
                  className="badge"
                  style={{
                    background: `color-mix(in srgb, ${tb.cls} 16%, transparent)`,
                    color: tb.cls
                  }}
                >
                  {t(tb.key)}
                </span>
                <span
                  className="badge"
                  style={{
                    background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
                    color: 'var(--accent)'
                  }}
                >
                  {m.kind === 'anthropic' ? t('gateway.kindAnthropic') : t('gateway.kindOpenAI')}
                </span>
                <code className="font-mono text-xs" style={{ color: 'var(--muted)' }}>
                  {m.model}
                </code>
                <code
                  className="max-w-64 truncate font-mono text-xs"
                  style={{ color: 'var(--muted)' }}
                  title={m.baseURL}
                >
                  {m.baseURL}
                </code>
                {tr && (
                  <span className="text-xs" style={{ color: tr.ok ? 'var(--ok)' : 'var(--bad)' }}>
                    {tr.ok
                      ? `✓ ${t('gateway.testOk')}`
                      : `✗ ${t('gateway.testFail')}: ${tr.error?.slice(0, 60)}`}
                  </span>
                )}
                <div className="ml-auto flex gap-2">
                  <button
                    className="btn"
                    onClick={() => void testModel(m.id)}
                    disabled={testing === m.id}
                  >
                    {testing === m.id ? t('gateway.testing') : t('gateway.test')}
                  </button>
                  <button
                    className="btn"
                    onClick={() =>
                      void act(() =>
                        window.api.gwUpdate({
                          models: gw.models.map((x) =>
                            toConfig(x.id === m.id ? { ...x, enabled: !x.enabled } : x)
                          )
                        })
                      )
                    }
                  >
                    {m.enabled ? t('gateway.disable') : t('gateway.enable')}
                  </button>
                  <button
                    className="btn"
                    onClick={() =>
                      setEditing({
                        id: m.id,
                        name: m.name,
                        kind: m.kind,
                        baseURL: m.baseURL,
                        apiKey: '',
                        model: m.model,
                        tier: m.tier,
                        enabled: m.enabled,
                        updatedAt: m.updatedAt
                      })
                    }
                  >
                    {t('gateway.edit')}
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      if (window.confirm(t('gateway.confirmDelete')))
                        void saveModels(gw.models.filter((x) => x.id !== m.id).map(toConfig))
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {editing && (
        <ModelForm
          initial={editing === 'new' ? undefined : editing}
          onCancel={() => setEditing(null)}
          onSave={(m) => {
            const exists = editing !== 'new' && gw.models.some((x) => x.id === m.id)
            // 编辑时 apiKey 留空表示沿用原值（store 侧按 id 合并）
            const next = exists
              ? gw.models.map((x) => (x.id === m.id ? m : toConfig(x)))
              : [...gw.models.map(toConfig), { ...m, id: '' }]
            void saveModels(next)
          }}
        />
      )}

      {/* 路由策略 */}
      <div className="card space-y-2 p-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Route size={15} />
          {t('gateway.policyTitle')}
        </div>
        <div className="text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>
          {t('gateway.policyBody')}
        </div>
        <div className="text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>
          {t('gateway.difficultySignals')}
        </div>
      </div>

      {/* 路由模拟器 */}
      <div className="card space-y-3 p-4">
        <div className="text-sm font-medium">{t('gateway.simTitle')}</div>
        <div className="text-xs" style={{ color: 'var(--muted)' }}>
          {t('gateway.simHint')}
        </div>
        <textarea
          className="input min-h-24 font-mono text-xs"
          value={simText}
          onChange={(e) => setSimText(e.target.value)}
        />
        <div className="flex items-center gap-3">
          <button
            className="btn btn-primary"
            onClick={() => void runSim()}
            disabled={simming || !simText.trim()}
          >
            {simming ? t('common.loading') : t('gateway.simRun')}
          </button>
          {sim && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span style={{ color: 'var(--muted)' }}>
                {t('gateway.simComplexity')} {sim.complexity}
              </span>
              <span
                className="badge"
                style={{
                  background: `color-mix(in srgb, ${TIER_BADGE[sim.tier].cls} 16%, transparent)`,
                  color: TIER_BADGE[sim.tier].cls
                }}
              >
                {t(TIER_BADGE[sim.tier].key)}
              </span>
              <span style={{ color: 'var(--muted)' }}>
                {t('gateway.simSignals')}:{' '}
                {sim.signals.length ? sim.signals.join('、') : t('gateway.simNone')}
              </span>
              <span style={{ color: 'var(--accent)' }}>
                →{' '}
                {sim.chosen ? `${sim.chosen.name} (${sim.chosen.model})` : t('gateway.simNoModel')}{' '}
                · {sim.reason}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* 最近请求 */}
      <div className="card overflow-hidden">
        <div
          className="border-b px-4 py-3 text-sm font-medium"
          style={{ borderColor: 'var(--border)' }}
        >
          {t('gateway.logsTitle')}
        </div>
        {logs.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm" style={{ color: 'var(--muted)' }}>
            {t('gateway.noLogs')}
          </div>
        ) : (
          <table className="w-full text-left text-xs">
            <thead style={{ color: 'var(--muted)' }}>
              <tr className="border-b" style={{ borderColor: 'var(--border)' }}>
                <th className="px-4 py-2 font-normal">{t('gateway.logsTime')}</th>
                <th className="px-4 py-2 font-normal">{t('gateway.logsModel')}</th>
                <th className="px-4 py-2 font-normal">{t('gateway.logsComplexity')}</th>
                <th className="px-4 py-2 font-normal">{t('gateway.logsLatency')}</th>
                <th className="px-4 py-2 font-normal">{t('gateway.logsStatus')}</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.id} className="border-b" style={{ borderColor: 'var(--border)' }}>
                  <td
                    className="px-4 py-2"
                    style={{ color: 'var(--muted)' }}
                    title={formatDate(l.at)}
                  >
                    {relativeTime(l.at)}
                  </td>
                  <td className="px-4 py-2">
                    {l.modelName || '—'}
                    {l.signals.length > 0 && (
                      <span className="ml-2" style={{ color: 'var(--muted)' }}>
                        {l.signals.join('、')}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {l.complexity} · {t(TIER_BADGE[l.tier].key)}
                  </td>
                  <td className="px-4 py-2">{l.latencyMs}ms</td>
                  <td
                    className="px-4 py-2"
                    style={{ color: l.status === 'ok' ? 'var(--ok)' : 'var(--bad)' }}
                    title={l.error}
                  >
                    {t(`gateway.state.${l.status}`)}
                    {l.error ? ` · ${l.error.slice(0, 60)}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

export default GatewayPage
