import { useMemo, useState } from 'react'
import { useEffect } from 'react'
import { Copy, Puzzle, Search, X } from 'lucide-react'
import type { AgentInfo, SkillCopyResult, SkillCopyTarget, SkillInfo } from '@shared/types'
import { useRefresh } from '../components/Layout'
import { formatDate } from '../lib/format'

export default function Skills() {
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [search, setSearch] = useState('')
  const [agentId, setAgentId] = useState('')
  const [copySource, setCopySource] = useState<SkillInfo | null>(null)
  const { refreshTick } = useRefresh()

  useEffect(() => {
    void window.api.listSkills({ search: search || undefined, agentId: agentId || undefined }).then(setSkills)
  }, [refreshTick, search, agentId])

  useEffect(() => {
    void window.api.scanAgents().then(setAgents)
  }, [refreshTick])

  const agentMap = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--muted)' }} />
          <input
            className="input pl-8"
            placeholder="搜索技能名称或描述…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 260 }}
          />
        </div>
        <select className="input" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          <option value="">全部智能体</option>
          {agents.filter((a) => a.detected).map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
        <span className="ml-auto text-sm" style={{ color: 'var(--muted)' }}>
          共 {skills.length} 个技能
        </span>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
              <th className="px-4 py-3">技能名称</th>
              <th className="px-4 py-3">所属智能体</th>
              <th className="px-4 py-3">版本</th>
              <th className="px-4 py-3">描述</th>
              <th className="px-4 py-3">安装时间</th>
              <th className="px-4 py-3">类型</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {skills.map((s) => {
              const agent = agentMap.get(s.agentId)
              return (
                <tr key={s.id} className="border-b align-top" style={{ borderColor: 'var(--border)' }}>
                  <td className="px-4 py-2.5 font-medium">{s.name}</td>
                  <td className="px-4 py-2.5">
                    <span className="badge" style={{ background: (agent?.color || '#666') + '22', color: agent?.color || '#999' }}>
                      {agent?.name || s.agentId}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs">{s.version || '—'}</td>
                  <td className="max-w-md px-4 py-2.5 text-xs" style={{ color: 'var(--muted)' }}>
                    <div className="line-clamp-2">{s.description || '—'}</div>
                  </td>
                  <td className="px-4 py-2.5 text-xs" style={{ color: 'var(--muted)' }}>{formatDate(s.installedAt)}</td>
                  <td className="px-4 py-2.5">
                    <span className="badge" style={{ background: s.builtin ? 'color-mix(in srgb, var(--muted) 15%, transparent)' : 'color-mix(in srgb, var(--accent) 15%, transparent)', color: s.builtin ? 'var(--muted)' : 'var(--accent)' }}>
                      {s.builtin ? '内置' : '安装'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <button className="btn px-2 py-1" title="复制到其他智能体" onClick={() => setCopySource(s)}>
                      <Copy size={13} />
                    </button>
                  </td>
                </tr>
              )
            })}
            {skills.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center" style={{ color: 'var(--muted)' }}>
                  <Puzzle size={24} className="mx-auto mb-2 opacity-50" />
                  没有匹配的技能
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {copySource && <CopyDialog skill={copySource} onClose={() => setCopySource(null)} />}
    </div>
  )
}

function CopyDialog({ skill, onClose }: { skill: SkillInfo; onClose: () => void }): React.JSX.Element {
  const [targets, setTargets] = useState<SkillCopyTarget[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [overwrite, setOverwrite] = useState(false)
  const [results, setResults] = useState<SkillCopyResult[] | null>(null)
  const [copying, setCopying] = useState(false)

  useEffect(() => {
    void window.api.listSkillCopyTargets().then((ts) => {
      setTargets(ts)
      setSelected(new Set(ts.filter((t) => t.support && t.exists).map((t) => t.agentId)))
    })
  }, [])

  const doCopy = async (): Promise<void> => {
    setCopying(true)
    try {
      setResults(await window.api.copySkill(skill.id, [...selected], overwrite))
    } finally {
      setCopying(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ background: 'rgba(0,0,0,0.5)' }} onClick={onClose}>
      <div className="card max-h-[85vh] w-full max-w-xl overflow-auto p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">把「{skill.name}」复制到其他智能体</h2>
          <button className="btn px-2 py-1" onClick={onClose}><X size={14} /></button>
        </div>
        {results ? (
          <div className="space-y-2">
            {results.map((r) => (
              <div key={r.agentId} className="rounded-lg px-3 py-2.5 text-sm" style={{ background: 'var(--panel-2)' }}>
                <div className="flex items-center gap-2">
                  <span className="badge" style={{ background: r.ok ? 'color-mix(in srgb, var(--ok) 18%, transparent)' : 'color-mix(in srgb, var(--bad) 18%, transparent)', color: r.ok ? 'var(--ok)' : 'var(--bad)' }}>
                    {r.ok ? '成功' : '失败'}
                  </span>
                  <span className="font-medium">{r.agentName}</span>
                </div>
                <div className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{r.message}</div>
              </div>
            ))}
            <div className="flex justify-end pt-1">
              <button className="btn btn-primary" onClick={onClose}>完成</button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
              目标已存在同名技能时覆盖（旧目录自动改名备份）
            </label>
            <div className="max-h-72 space-y-2 overflow-auto">
              {targets.map((t) => (
                <label
                  key={t.agentId}
                  className="flex items-start gap-3 rounded-lg px-3 py-2.5"
                  style={{ background: 'var(--panel-2)', opacity: t.support ? 1 : 0.5 }}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    disabled={!t.support}
                    checked={selected.has(t.agentId)}
                    onChange={() =>
                      setSelected((prev) => {
                        const next = new Set(prev)
                        if (next.has(t.agentId)) next.delete(t.agentId)
                        else next.add(t.agentId)
                        return next
                      })
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="badge" style={{ background: t.color + '22', color: t.color }}>{t.agentName}</span>
                      {t.support ? (
                        <span className="text-xs" style={{ color: t.exists ? 'var(--ok)' : 'var(--warn)' }}>
                          {t.exists ? `技能目录 · ${t.installedSkillCount} 个技能` : '目录将自动创建'}
                        </span>
                      ) : (
                        <span className="text-xs" style={{ color: 'var(--muted)' }}>不支持</span>
                      )}
                    </div>
                    {t.note && <div className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>{t.note}</div>}
                  </div>
                </label>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <button className="btn" onClick={onClose}>取消</button>
              <button className="btn btn-primary" disabled={selected.size === 0 || copying} onClick={() => void doCopy()}>
                {copying ? '复制中…' : `复制到 ${selected.size} 个智能体`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
