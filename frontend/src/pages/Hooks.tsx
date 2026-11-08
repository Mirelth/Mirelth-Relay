import { useEffect, useState } from 'react'
import React from 'react'
import { Plus, Trash2, Webhook, X, Zap } from 'lucide-react'
import type { HookCreateInput, HookEntry, HooksTarget } from '@shared/types'
import { useRefresh } from '../components/Layout'

const EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'Notification', 'SessionStart']

export default function Hooks(): React.JSX.Element {
  const [hooks, setHooks] = useState<HookEntry[]>([])
  const [targets, setTargets] = useState<HooksTarget[]>([])
  const [form, setForm] = useState<(HookCreateInput & { targetPath?: string }) | null>(null)
  const { refreshTick } = useRefresh()

  const reload = async (): Promise<void> => {
    setHooks(await window.api.listHooks())
    setTargets(await window.api.listHookTargets())
  }

  useEffect(() => {
    void reload()
  }, [refreshTick])

  const availableTargets = targets.filter((t) => t.exists)

  const create = async (): Promise<void> => {
    if (!form || !form.command.trim()) return
    await window.api.createHook(form)
    setForm(null)
    await reload()
  }

  const remove = async (id: string): Promise<void> => {
    await window.api.deleteHook(id)
    await reload()
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm" style={{ color: 'var(--muted)' }}>
          管理各智能体 settings 中的 hooks（工具调用前后等事件触发命令）。写入前自动备份原配置。
        </div>
        <button
          className="btn btn-primary"
          onClick={() =>
            setForm({ agentId: availableTargets[0]?.agentId || '', event: 'PreToolUse', command: '' })
          }
          disabled={availableTargets.length === 0}
        >
          <Plus size={14} /> 新建 Hook
        </button>
      </div>

      {hooks.length === 0 && (
        <div className="card p-10 text-center" style={{ color: 'var(--muted)' }}>
          <Webhook size={28} className="mx-auto mb-3 opacity-50" />
          {availableTargets.length === 0
            ? '未检测到支持 hooks 管理的智能体配置文件'
            : '当前没有任何 hooks 配置，点击右上角"新建 Hook"创建'}
        </div>
      )}

      {availableTargets.some((t) => !t.verified) && (
        <div className="card px-4 py-3 text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>
          <span
            className="badge mr-2"
            style={{ background: 'color-mix(in srgb, var(--warn) 18%, transparent)', color: 'var(--warn)' }}
          >
            生效状态说明
          </span>
          标注「未验证生效」的智能体：配置已按 Anthropic hooks 通用格式正确写入文件，但
          <b style={{ color: 'var(--warn)' }}>尚未实测该智能体运行时是否执行这些 hooks</b>（取决于其版本与实现）。写入前自动备份，格式无法解析时拒绝写入。
        </div>
      )}

      {/* 按智能体分组 */}
      {[...new Set(hooks.map((h) => h.agentId))].map((agentId) => {
        const list = hooks.filter((h) => h.agentId === agentId)
        const first = list[0]
        const tgt = targets.find((t) => t.agentId === agentId)
        return (
          <div key={agentId} className="card overflow-hidden">
            <div className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: 'var(--border)' }}>
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: first.color }} />
              <span className="font-medium">{first.agentName}</span>
              <span className="text-xs" style={{ color: 'var(--muted)' }}>{list.length} 个 hook</span>
              {tgt && !tgt.verified && (
                <span
                  className="badge"
                  title="写入成功，但该智能体是否执行 hooks 尚未实测"
                  style={{ background: 'color-mix(in srgb, var(--warn) 18%, transparent)', color: 'var(--warn)' }}
                >
                  未验证生效
                </span>
              )}
            </div>
            <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
              {list.map((h) => (
                <div key={h.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="badge" style={{ background: 'color-mix(in srgb, var(--accent) 15%, transparent)', color: 'var(--accent)' }}>
                    <Zap size={11} /> {h.event}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-xs">{h.command}</div>
                    <div className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>
                      {h.matcher ? `匹配 ${h.matcher} · ` : ''}{h.timeout ? `${h.timeout}s 超时 · ` : ''}{h.sourcePath}
                    </div>
                  </div>
                  <button className="btn px-2 py-1" title="删除" onClick={() => void remove(h.id)}>
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )
      })}

      {/* 支持的目标 */}
      <div className="card overflow-hidden">
        <div className="border-b px-4 py-3 text-sm font-medium" style={{ borderColor: 'var(--border)' }}>
          Hooks 配置位置
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
              <th className="px-4 py-2.5">智能体</th>
              <th className="px-4 py-2.5">配置文件</th>
              <th className="px-4 py-2.5">状态</th>
              <th className="px-4 py-2.5">说明</th>
            </tr>
          </thead>
          <tbody>
            {targets.map((t) => (
              <tr key={t.agentId} className="border-b" style={{ borderColor: 'var(--border)' }}>
                <td className="px-4 py-2.5">
                  <span className="badge" style={{ background: t.color + '22', color: t.color }}>{t.agentName}</span>
                </td>
                <td className="px-4 py-2.5 font-mono text-xs" style={{ color: 'var(--muted)' }}>{t.settingsPath}</td>
                <td className="px-4 py-2.5">
                  {t.exists ? (
                    <span className="badge" style={{ background: 'color-mix(in srgb, var(--ok) 18%, transparent)', color: 'var(--ok)' }}>
                      可管理 · {t.hookCount} 组
                    </span>
                  ) : (
                    <span className="badge" style={{ background: 'color-mix(in srgb, var(--muted) 15%, transparent)', color: 'var(--muted)' }}>
                      未检测到
                    </span>
                  )}
                  {!t.verified && t.exists && (
                    <span className="badge ml-1" style={{ background: 'color-mix(in srgb, var(--warn) 15%, transparent)', color: 'var(--warn)' }}>
                      未验证生效
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-xs" style={{ color: 'var(--muted)' }}>{t.note || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 新建对话框 */}
      {form && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ background: 'rgba(0,0,0,0.5)' }} onClick={() => setForm(null)}>
          <div className="card w-full max-w-lg p-5" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold">新建 Hook</h2>
              <button className="btn px-2 py-1" onClick={() => setForm(null)}>
                <X size={14} />
              </button>
            </div>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-xs" style={{ color: 'var(--muted)' }}>
                  智能体
                  <select className="input mt-1 w-full" value={form.agentId} onChange={(e) => setForm({ ...form, agentId: e.target.value })}>
                    {availableTargets.map((t) => (
                      <option key={t.agentId} value={t.agentId}>{t.agentName}</option>
                    ))}
                  </select>
                </label>
                <label className="block text-xs" style={{ color: 'var(--muted)' }}>
                  触发事件
                  <select className="input mt-1 w-full" value={form.event} onChange={(e) => setForm({ ...form, event: e.target.value })}>
                    {EVENTS.map((ev) => (
                      <option key={ev} value={ev}>{ev}</option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="block text-xs" style={{ color: 'var(--muted)' }}>
                Matcher（可选，工具名匹配模式）
                <input className="input mt-1 w-full font-mono" value={form.matcher || ''} onChange={(e) => setForm({ ...form, matcher: e.target.value })} placeholder="Bash|Edit" />
              </label>
              <label className="block text-xs" style={{ color: 'var(--muted)' }}>
                命令 *
                <input className="input mt-1 w-full font-mono" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder="/usr/local/bin/notify.sh" />
              </label>
              <label className="block text-xs" style={{ color: 'var(--muted)' }}>
                超时秒数（可选）
                <input className="input mt-1 w-full" type="number" value={form.timeout ?? ''} onChange={(e) => setForm({ ...form, timeout: e.target.value ? Number(e.target.value) : undefined })} placeholder="60" />
              </label>
              <div className="flex justify-end gap-2 pt-1">
                <button className="btn" onClick={() => setForm(null)}>取消</button>
                <button className="btn btn-primary" disabled={!form.command.trim()} onClick={() => void create()}>写入</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
