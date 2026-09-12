import { useEffect, useMemo, useState } from 'react'
import React from 'react'
import { Bot, Cpu, Pencil, Plus, RefreshCw, Send, Trash2, X } from 'lucide-react'
import type {
  ApplierInfo,
  ApplyResult,
  ModelDef,
  ModelProfile,
  ModelProfileView
} from '@shared/types'
import { useRefresh } from '../components/Layout'
import { relativeTime } from '../lib/format'

/** Provider ID：小写字母开头，可含数字与连字符 */
const PROVIDER_ID_RE = /^[a-z][a-z0-9-]*$/

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

interface ModelRow {
  id: string
  name: string
  ctx: string
}

function rowsToModels(rows: ModelRow[]): ModelDef[] {
  return rows
    .filter((r) => r.id.trim())
    .map((r) => ({
      id: r.id.trim(),
      ...(r.name.trim() ? { name: r.name.trim() } : {}),
      ...(r.ctx.trim() && !isNaN(Number(r.ctx)) ? { contextWindow: Number(r.ctx) } : {})
    }))
}

function modelsToRows(models: ModelDef[]): ModelRow[] {
  return models.map((m) => ({
    id: m.id,
    name: m.name || '',
    ctx: m.contextWindow ? String(m.contextWindow) : ''
  }))
}

function modelsToText(rows: ModelRow[]): string {
  return rows
    .filter((r) => r.id.trim())
    .map((r) => [r.id.trim(), r.name.trim(), r.ctx.trim()].filter(Boolean).join(' | '))
    .join('\n')
}

function textToModels(text: string): ModelRow[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('|').map((s) => s.trim())
      return { id: parts[0] || '', name: parts[1] || '', ctx: parts[2] || '' }
    })
    .filter((r) => r.id)
}

interface FormState {
  /** 编辑模式的原始 id（存储键，不可改） */
  editId?: string
  providerId: string
  idTouched: boolean
  name: string
  kind: 'anthropic' | 'openai-compatible'
  baseURL: string
  apiKey: string
  apiKeyMasked: string
  modelsText: string
  defaultModel: string
}

const EMPTY_FORM: FormState = {
  providerId: '',
  idTouched: false,
  name: '',
  kind: 'openai-compatible',
  baseURL: '',
  apiKey: '',
  apiKeyMasked: '',
  modelsText: '',
  defaultModel: ''
}

const KIND_LABEL = {
  anthropic: 'anthropic-messages',
  'openai-compatible': 'openai-completions'
} as const

export default function Models(): React.JSX.Element {
  const [profiles, setProfiles] = useState<ModelProfileView[]>([])
  const [appliers, setAppliers] = useState<ApplierInfo[]>([])
  const [form, setForm] = useState<FormState | null>(null)
  const [applyTarget, setApplyTarget] = useState<ModelProfileView | null>(null)
  const [catalog, setCatalog] = useState<{ models: string[]; error?: string } | null>(null)
  const [catalogPicked, setCatalogPicked] = useState<Set<string>>(new Set())
  const [fetchingCatalog, setFetchingCatalog] = useState(false)
  const { refreshTick } = useRefresh()

  useEffect(() => {
    void window.api.listModelProfiles().then(setProfiles)
    void window.api.listAppliers().then(setAppliers)
  }, [refreshTick])

  const startCreate = (): void => {
    setCatalog(null)
    setForm({ ...EMPTY_FORM })
  }

  const startEdit = (p: ModelProfileView): void => {
    setCatalog(null)
    setForm({
      editId: p.id,
      providerId: p.id,
      idTouched: true,
      name: p.name,
      kind: p.kind,
      baseURL: p.baseURL,
      apiKey: '',
      apiKeyMasked: p.apiKeyMasked,
      modelsText: modelsToText(modelsToRows(p.models)),
      defaultModel: p.defaultModel || ''
    })
  }

  const patchForm = (patch: Partial<FormState>): void =>
    setForm((f) => (f ? { ...f, ...patch } : f))

  /** 新建时显示名称联动生成 Provider ID（手动改过则不覆盖） */
  const setName = (name: string): void =>
    setForm((f) =>
      f
        ? {
            ...f,
            name,
            ...(!f.editId && !f.idTouched ? { providerId: slugify(name) } : {})
          }
        : f
    )

  const idValid = !!form && PROVIDER_ID_RE.test(form.providerId.trim())
  const canSave = !!form && idValid && !!form.name.trim() && !!form.baseURL.trim()

  const fetchCatalog = async (): Promise<void> => {
    if (!form?.baseURL.trim() || fetchingCatalog) return
    setFetchingCatalog(true)
    setCatalogPicked(new Set())
    try {
      setCatalog(await window.api.fetchModelCatalog(form.baseURL.trim(), form.apiKey, form.kind))
    } finally {
      setFetchingCatalog(false)
    }
  }

  const addCatalogPicked = (): void => {
    if (!form || !catalog) return
    const existingRows = textToModels(form.modelsText)
    const existingIds = new Set(existingRows.map((r) => r.id))
    const additions = catalog.models
      .filter((id) => !existingIds.has(id) && catalogPicked.has(id))
      .map((id) => ({ id, name: '', ctx: '' }))
    const newText = modelsToText([...existingRows, ...additions])
    patchForm({ modelsText: newText })
    setCatalogPicked(new Set())
  }

  const saveForm = async (): Promise<void> => {
    if (!form || !canSave) return
    const profile: ModelProfile = {
      id: form.editId || form.providerId.trim(),
      name: form.name.trim(),
      kind: form.kind,
      baseURL: form.baseURL.trim(),
      apiKey: form.apiKey,
      models: rowsToModels(textToModels(form.modelsText)),
      ...(form.defaultModel ? { defaultModel: form.defaultModel } : {}),
      updatedAt: new Date().toISOString()
    }
    await window.api.saveModelProfile(profile)
    setForm(null)
    setProfiles(await window.api.listModelProfiles())
  }

  const removeProfile = async (id: string): Promise<void> => {
    await window.api.deleteModelProfile(id)
    setProfiles(await window.api.listModelProfiles())
  }

  const supportLabel = { full: '可自动配置', partial: '部分支持', none: '不支持' }
  const supportColor = {
    full: { background: 'color-mix(in srgb, var(--ok) 18%, transparent)', color: 'var(--ok)' },
    partial: {
      background: 'color-mix(in srgb, var(--warn) 18%, transparent)',
      color: 'var(--warn)'
    },
    none: { background: 'color-mix(in srgb, var(--muted) 15%, transparent)', color: 'var(--muted)' }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm" style={{ color: 'var(--muted)' }}>
          维护一套模型提供方配置，一键下发到支持自动配置的智能体（写入前自动备份原配置）
        </div>
        <button className="btn btn-primary" onClick={startCreate}>
          <Plus size={14} /> 新建提供方
        </button>
      </div>

      {/* Profile 卡片 */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-4">
        {profiles.map((p) => (
          <div key={p.id} className="card p-4">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div
                  className="flex h-9 w-9 items-center justify-center rounded-lg text-white"
                  style={{ background: 'var(--accent)' }}
                >
                  <Cpu size={17} />
                </div>
                <div>
                  <div className="font-semibold">{p.name}</div>
                  <div className="text-xs" style={{ color: 'var(--muted)' }}>
                    {KIND_LABEL[p.kind]} · 更新于 {relativeTime(p.updatedAt)}
                  </div>
                </div>
              </div>
              <div className="flex gap-1">
                <button className="btn px-2 py-1" onClick={() => startEdit(p)} title="编辑">
                  <Pencil size={13} />
                </button>
                <button
                  className="btn px-2 py-1"
                  onClick={() => void removeProfile(p.id)}
                  title="删除"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
            <div className="mt-3 space-y-1 text-xs" style={{ color: 'var(--muted)' }}>
              <div className="truncate font-mono">{p.baseURL}</div>
              <div>API Key：{p.hasApiKey ? p.apiKeyMasked : '未设置'}</div>
              <div>
                模型（{p.models.length}）：{p.models.map((m) => m.name || m.id).join('、') || '—'}
                {p.defaultModel && ` · 默认 ${p.defaultModel}`}
              </div>
            </div>
            <button
              className="btn btn-primary mt-3 w-full justify-center"
              onClick={() => setApplyTarget(p)}
            >
              <Send size={13} /> 配置到智能体…
            </button>
          </div>
        ))}
        {profiles.length === 0 && (
          <div className="card p-10 text-center" style={{ color: 'var(--muted)' }}>
            <Cpu size={28} className="mx-auto mb-3 opacity-50" />
            还没有提供方，点击右上角「新建提供方」开始
          </div>
        )}
      </div>

      {/* 智能体支持情况 */}
      <div className="card overflow-hidden">
        <div
          className="border-b px-4 py-3 text-sm font-medium"
          style={{ borderColor: 'var(--border)' }}
        >
          各智能体自动配置支持情况
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr
              className="border-b text-left text-xs"
              style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
            >
              <th className="px-4 py-2.5">智能体</th>
              <th className="px-4 py-2.5">支持程度</th>
              <th className="px-4 py-2.5">当前模型配置</th>
              <th className="px-4 py-2.5">说明</th>
            </tr>
          </thead>
          <tbody>
            {appliers.map((a) => (
              <tr key={a.agentId} className="border-b" style={{ borderColor: 'var(--border)' }}>
                <td className="px-4 py-2.5">
                  <span className="badge" style={{ background: a.color + '22', color: a.color }}>
                    <Bot size={11} /> {a.agentName}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <span className="badge" style={supportColor[a.support]}>
                    {supportLabel[a.support]}
                  </span>
                </td>
                <td
                  className="max-w-sm truncate px-4 py-2.5 font-mono text-xs"
                  style={{ color: 'var(--muted)' }}
                  title={a.current}
                >
                  {a.current}
                </td>
                <td className="px-4 py-2.5 text-xs" style={{ color: 'var(--muted)' }}>
                  {a.note || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 新建/编辑提供方对话框 */}
      {form && (
        <Modal title={form.editId ? '编辑模型配置' : '新建模型配置'} onClose={() => setForm(null)}>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <label className="block text-xs" style={{ color: 'var(--muted)' }}>
                名称 *
                <input
                  className="input mt-1 w-full"
                  value={form.name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="如：Z.ai GLM"
                />
              </label>
              <label className="block text-xs" style={{ color: 'var(--muted)' }}>
                协议类型
                <select
                  className="input mt-1 w-full"
                  value={form.kind}
                  onChange={(e) => {
                    patchForm({ kind: e.target.value as FormState['kind'] })
                    setCatalog(null)
                  }}
                >
                  <option value="openai-compatible">OpenAI 兼容</option>
                  <option value="anthropic">Anthropic</option>
                </select>
              </label>
            </div>

            <label className="block text-xs" style={{ color: 'var(--muted)' }}>
              Base URL *
              <input
                className="input mt-1 w-full font-mono"
                value={form.baseURL}
                onChange={(e) => patchForm({ baseURL: e.target.value })}
                placeholder="https://api.example.com/v1"
              />
            </label>

            <label className="block text-xs" style={{ color: 'var(--muted)' }}>
              API Key
              {form.editId && form.apiKeyMasked && (
                <span className="ml-1 font-mono">（当前 {form.apiKeyMasked}，留空则不修改）</span>
              )}
              <input
                className="input mt-1 w-full font-mono"
                type="password"
                value={form.apiKey}
                onChange={(e) => patchForm({ apiKey: e.target.value })}
                placeholder="sk-..."
              />
            </label>

            {/* 模型列表 */}
            <div>
              <div
                className="flex items-center justify-between text-xs"
                style={{ color: 'var(--muted)' }}
              >
                <span>模型列表（每行一个：模型ID | 显示名（可选）| 上下文窗口（可选））</span>
                <button
                  className="btn border-none bg-transparent px-1 py-0.5 underline-offset-2 hover:underline"
                  style={{ color: 'var(--accent)' }}
                  disabled={!form.baseURL.trim() || fetchingCatalog}
                  onClick={() => void fetchCatalog()}
                >
                  <RefreshCw size={11} className={fetchingCatalog ? 'animate-spin' : ''} />
                  {fetchingCatalog ? '获取中…' : '获取模型列表'}
                </button>
              </div>

              {catalog?.error && (
                <div
                  className="mt-2 rounded-lg px-3 py-2 text-xs"
                  style={{
                    background: 'color-mix(in srgb, var(--bad) 12%, transparent)',
                    color: 'var(--bad)'
                  }}
                >
                  获取失败：{catalog.error}
                </div>
              )}

              {catalog && catalog.models.length > 0 && (
                <div className="mt-2 rounded-lg p-2" style={{ background: 'var(--panel-2)' }}>
                  <div className="max-h-40 space-y-1 overflow-auto">
                    {catalog.models.map((id) => (
                      <label
                        key={id}
                        className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 font-mono text-xs"
                      >
                        <input
                          type="checkbox"
                          checked={catalogPicked.has(id)}
                          onChange={() =>
                            setCatalogPicked((prev) => {
                              const next = new Set(prev)
                              if (next.has(id)) next.delete(id)
                              else next.add(id)
                              return next
                            })
                          }
                        />
                        {id}
                      </label>
                    ))}
                  </div>
                  <div className="mt-1 flex justify-end">
                    <button
                      className="btn px-2 py-1 text-xs"
                      disabled={catalogPicked.size === 0}
                      onClick={addCatalogPicked}
                    >
                      添加所选（{catalogPicked.size}）
                    </button>
                  </div>
                </div>
              )}

              <textarea
                className="input mt-2 w-full resize-y font-mono text-xs"
                rows={5}
                value={form.modelsText}
                onChange={(e) => patchForm({ modelsText: e.target.value })}
                placeholder={'glm-5.3 | GLM-5.3 | 1000000\nglm-4.7-air'}
              />
            </div>

            <label className="block text-xs" style={{ color: 'var(--muted)' }}>
              默认模型（模型 ID，可选，下发时可设为默认）
              <input
                className="input mt-1 w-full font-mono text-xs"
                value={form.defaultModel}
                onChange={(e) => patchForm({ defaultModel: e.target.value })}
                placeholder="glm-5.3"
              />
            </label>

            <div className="flex justify-end gap-2 pt-1">
              <button className="btn" onClick={() => setForm(null)}>
                取消
              </button>
              <button
                className="btn btn-primary"
                disabled={!canSave}
                onClick={() => void saveForm()}
              >
                保存
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* 配置到智能体对话框 */}
      {applyTarget && (
        <ApplyDialog
          profile={applyTarget}
          appliers={appliers}
          onClose={() => setApplyTarget(null)}
          onDone={() => void window.api.listAppliers().then(setAppliers)}
        />
      )}
    </div>
  )
}

function ApplyDialog({
  profile,
  appliers,
  onClose,
  onDone
}: {
  profile: ModelProfileView
  appliers: ApplierInfo[]
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const applicable = useMemo(() => appliers.filter((a) => a.support !== 'none'), [appliers])
  const [selected, setSelected] = useState<Set<string>>(
    new Set(applicable.filter((a) => a.support === 'full').map((a) => a.agentId))
  )
  const [setDefault, setSetDefault] = useState(!!profile.defaultModel)
  const [results, setResults] = useState<ApplyResult[] | null>(null)
  const [applying, setApplying] = useState(false)

  const toggle = (id: string): void =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const doApply = async (): Promise<void> => {
    setApplying(true)
    try {
      const r = await window.api.applyModelProfile(profile.id, [...selected], { setDefault })
      setResults(r)
      onDone()
    } finally {
      setApplying(false)
    }
  }

  return (
    <Modal title={`把「${profile.name}」配置到智能体`} onClose={onClose}>
      {results ? (
        <div className="space-y-2">
          {results.map((r) => (
            <div
              key={r.agentId}
              className="rounded-lg px-3 py-2.5 text-sm"
              style={{ background: 'var(--panel-2)' }}
            >
              <div className="flex items-center gap-2">
                <span
                  className="badge"
                  style={{
                    background: r.ok
                      ? 'color-mix(in srgb, var(--ok) 18%, transparent)'
                      : 'color-mix(in srgb, var(--bad) 18%, transparent)',
                    color: r.ok ? 'var(--ok)' : 'var(--bad)'
                  }}
                >
                  {r.ok ? '成功' : '失败'}
                </span>
                <span className="font-medium">{r.agentName}</span>
              </div>
              <div className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
                {r.message}
              </div>
              {r.backupPath && (
                <div className="mt-0.5 font-mono text-[11px]" style={{ color: 'var(--muted)' }}>
                  备份：{r.backupPath}
                </div>
              )}
            </div>
          ))}
          <div className="flex justify-end pt-1">
            <button className="btn btn-primary" onClick={onClose}>
              完成
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {profile.defaultModel && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={setDefault}
                onChange={(e) => setSetDefault(e.target.checked)}
              />
              同时设为默认模型（{profile.defaultModel}）
            </label>
          )}
          <div className="max-h-72 space-y-2 overflow-auto">
            {appliers.map((a) => {
              const disabled = a.support === 'none'
              const checked = selected.has(a.agentId)
              return (
                <label
                  key={a.agentId}
                  className="flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5"
                  style={{
                    background: 'var(--panel-2)',
                    opacity: disabled ? 0.5 : 1,
                    cursor: disabled ? 'not-allowed' : 'pointer'
                  }}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    disabled={disabled}
                    checked={checked}
                    onChange={() => toggle(a.agentId)}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className="badge"
                        style={{ background: a.color + '22', color: a.color }}
                      >
                        {a.agentName}
                      </span>
                      <span
                        className="text-xs"
                        style={{
                          color:
                            a.support === 'full'
                              ? 'var(--ok)'
                              : a.support === 'partial'
                                ? 'var(--warn)'
                                : 'var(--muted)'
                        }}
                      >
                        {a.support === 'full'
                          ? '完整支持'
                          : a.support === 'partial'
                            ? '部分支持'
                            : '不支持'}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-xs" style={{ color: 'var(--muted)' }}>
                      {a.note || a.current}
                    </div>
                  </div>
                </label>
              )
            })}
          </div>
          <div className="text-xs" style={{ color: 'var(--muted)' }}>
            ⚠️ 写入会修改智能体的真实配置文件（自动备份为
            *.agentmgr-bak-*），建议先关闭对应智能体再下发，完成后重启生效。
          </div>
          <div className="flex justify-end gap-2">
            <button className="btn" onClick={onClose}>
              取消
            </button>
            <button
              className="btn btn-primary"
              disabled={selected.size === 0 || applying}
              onClick={() => void doApply()}
            >
              {applying ? '写入中…' : `写入 ${selected.size} 个智能体`}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}

function Modal({
  title,
  children,
  onClose
}: {
  title: string
  children: React.ReactNode
  onClose: () => void
}): React.JSX.Element {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      onClick={onClose}
    >
      <div
        className="card max-h-[85vh] w-full max-w-xl overflow-auto p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">{title}</h2>
          <button className="btn px-2 py-1" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
