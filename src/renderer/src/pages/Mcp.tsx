import { useEffect, useState } from 'react'
import { CheckCircle2, ChevronDown, ChevronRight, CircleDashed, MinusCircle, Wrench, XCircle } from 'lucide-react'
import type { AgentInfo, McpServer, McpStatus } from '@shared/types'
import { useRefresh } from '../components/Layout'
import { relativeTime } from '../lib/format'

const STATUS_META: Record<McpStatus, { label: string; color: string; bg: string; icon: typeof CheckCircle2 }> = {
  online: { label: '在线', color: 'var(--ok)', bg: 'color-mix(in srgb, var(--ok) 18%, transparent)', icon: CheckCircle2 },
  offline: { label: '离线', color: 'var(--bad)', bg: 'color-mix(in srgb, var(--bad) 18%, transparent)', icon: XCircle },
  unverified: { label: '未验证', color: 'var(--warn)', bg: 'color-mix(in srgb, var(--warn) 18%, transparent)', icon: CircleDashed },
  disabled: { label: '已禁用', color: 'var(--muted)', bg: 'color-mix(in srgb, var(--muted) 18%, transparent)', icon: MinusCircle }
}

export default function Mcp() {
  const [servers, setServers] = useState<McpServer[]>([])
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [checking, setChecking] = useState(false)
  const { refreshTick } = useRefresh()

  useEffect(() => {
    void window.api.listMcp().then(setServers)
    void window.api.scanAgents().then(setAgents)
  }, [refreshTick])

  const agentMap = new Map(agents.map((a) => [a.id, a]))
  const groups = new Map<string, McpServer[]>()
  for (const s of servers) {
    if (!groups.has(s.agentId)) groups.set(s.agentId, [])
    groups.get(s.agentId)!.push(s)
  }

  const checkAll = (): void => {
    setChecking(true)
    void window.api
      .checkAllMcp()
      .then(setServers)
      .finally(() => setChecking(false))
  }

  const toggle = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm" style={{ color: 'var(--muted)' }}>
          共 {servers.length} 个 MCP 服务 ·{' '}
          <span style={{ color: 'var(--ok)' }}>{servers.filter((s) => s.status === 'online').length} 在线</span> ·{' '}
          <span style={{ color: 'var(--bad)' }}>{servers.filter((s) => s.status === 'offline').length} 离线</span>
        </div>
        <button className="btn btn-primary" onClick={checkAll} disabled={checking}>
          {checking ? '检测中…' : '检测全部连接'}
        </button>
      </div>

      {[...groups.entries()].map(([agentId, list]) => {
        const agent = agentMap.get(agentId)
        return (
          <div key={agentId} className="card overflow-hidden">
            <div className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: 'var(--border)' }}>
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: agent?.color || '#666' }} />
              <span className="font-medium">{agent?.name || agentId}</span>
              <span className="text-xs" style={{ color: 'var(--muted)' }}>{list.length} 个服务</span>
            </div>
            <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
              {list.map((s) => {
                const meta = STATUS_META[s.status]
                const Icon = meta.icon
                const open = expanded.has(s.id)
                return (
                  <div key={s.id}>
                    <div className="row-hover flex cursor-pointer items-center gap-3 px-4 py-3" onClick={() => toggle(s.id)}>
                      {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                      <span className="badge" style={{ background: meta.bg, color: meta.color }}>
                        <Icon size={12} /> {meta.label}
                      </span>
                      <span className="font-medium">{s.name}</span>
                      <span className="badge" style={{ background: '#6366f122', color: '#a5b4fc' }}>
                        {s.transport}
                      </span>
                      <span className="truncate font-mono text-xs" style={{ color: 'var(--muted)' }}>
                        {s.endpoint || '—'}
                      </span>
                      <span className="ml-auto shrink-0 text-xs" style={{ color: 'var(--muted)' }}>
                        {s.tools.length > 0 && `${s.tools.length} 个工具 · `}
                        {s.lastChecked ? `检测于 ${relativeTime(s.lastChecked)}` : '未检测'}
                      </span>
                    </div>
                    {open && (
                      <div className="px-10 pb-4">
                        {s.statusDetail && (
                          <div className="mb-2 text-xs" style={{ color: 'var(--muted)' }}>
                            状态详情：{s.statusDetail}
                          </div>
                        )}
                        {s.tools.length > 0 ? (
                          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-2">
                            {s.tools.map((t) => (
                              <div key={t.name} className="rounded-lg px-3 py-2 text-xs" style={{ background: 'var(--panel-2)' }}>
                                <div className="flex items-center gap-1.5 font-medium">
                                  <Wrench size={11} /> {t.name}
                                </div>
                                {t.description && (
                                  <div className="mt-1 line-clamp-2" style={{ color: 'var(--muted)' }}>{t.description}</div>
                                )}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="text-xs" style={{ color: 'var(--muted)' }}>
                            {s.transport === 'http' || s.transport === 'sse'
                              ? '连接成功后可加载工具列表；点击"检测全部连接"尝试拉取。'
                              : 'stdio 服务无法远程枚举工具，请查看智能体内配置。'}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}

      {servers.length === 0 && (
        <div className="card p-10 text-center" style={{ color: 'var(--muted)' }}>
          <Wrench size={28} className="mx-auto mb-3 opacity-50" />
          未发现 MCP 配置，或尚未扫描
        </div>
      )}
    </div>
  )
}
