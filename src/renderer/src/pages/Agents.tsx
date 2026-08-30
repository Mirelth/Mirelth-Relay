import { useEffect, useState } from 'react'
import { Bot, ChevronDown, ChevronUp, Puzzle, Wrench } from 'lucide-react'
import type { AgentDetail, AgentInfo } from '@shared/types'
import { useRefresh } from '../components/Layout'
import { formatBytes, relativeTime } from '../lib/format'

export default function Agents() {
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [detail, setDetail] = useState<AgentDetail | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const { refreshTick, lastScanAt } = useRefresh()

  useEffect(() => {
    void window.api.scanAgents().then(setAgents)
  }, [refreshTick])

  const openDetail = (id: string): void => {
    if (detail?.info.id === id) {
      setDetail(null)
      return
    }
    void window.api.getAgentDetail(id).then(setDetail)
  }

  const detected = agents.filter((a) => a.detected)

  return (
    <div className="space-y-4">
      <div className="text-sm" style={{ color: 'var(--muted)' }}>
        共检测到 {detected.length} 个智能体（{agents.length} 个已注册类型） · 数据更新于 {relativeTime(lastScanAt)}
      </div>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-4">
        {detected.map((a) => (
          <div key={a.id} className="card cursor-pointer p-4 transition-transform hover:-translate-y-0.5" onClick={() => openDetail(a.id)}>
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl text-sm font-bold text-white" style={{ background: a.color }}>
                  {a.name.slice(0, 2).toUpperCase()}
                </div>
                <div>
                  <div className="font-semibold">{a.name}</div>
                  <div className="text-xs" style={{ color: 'var(--muted)' }}>
                    {a.vendor || '未知厂商'} · {a.version || '版本未知'} · {{ cli: 'CLI', ide: 'IDE', desktop: '桌面应用' }[a.kind]}
                  </div>
                </div>
              </div>
              <span className="badge" style={{ background: 'color-mix(in srgb, var(--ok) 20%, transparent)', color: 'var(--ok)' }}>
                已安装
              </span>
            </div>
            <div className="mt-4 flex items-center gap-4 text-xs" style={{ color: 'var(--muted)' }}>
              <span className="inline-flex items-center gap-1">
                <Puzzle size={13} /> {a.skillCount} 个技能
              </span>
              <span className="inline-flex items-center gap-1">
                <Wrench size={13} /> {a.mcpCount} 个 MCP
              </span>
              <span className="inline-flex items-center gap-1">
                <Bot size={13} /> {a.projectCount} 个项目
              </span>
              {a.hasUsage && (
                <span className="badge" style={{ background: '#6366f122', color: '#a5b4fc' }}>
                  用量数据
                </span>
              )}
            </div>
          </div>
        ))}
        {detected.length === 0 && (
          <div className="card p-8 text-center" style={{ color: 'var(--muted)' }}>
            尚未扫描到数据，点击右上角"立即刷新"开始扫描
          </div>
        )}
      </div>

      {/* 详情抽屉 */}
      {detail && (
        <div className="card p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-base font-semibold">
              {detail.info.name} · 详细配置
            </h2>
            <button className="btn" onClick={() => setDetail(null)}>
              关闭
            </button>
          </div>

          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <section>
              <h3 className="mb-2 text-sm font-medium">配置文件</h3>
              <div className="space-y-3">
                {detail.configs.map((c) => (
                  <div key={c.path} className="rounded-lg p-3" style={{ background: 'var(--panel-2)' }}>
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span className="font-mono">{c.path}</span>
                      <span style={{ color: c.exists ? 'var(--ok)' : 'var(--muted)' }}>{c.exists ? '存在' : '不存在'}</span>
                    </div>
                    {c.summary != null && (
                      <pre className="max-h-56 overflow-auto text-xs" style={{ color: 'var(--muted)' }}>
                        {JSON.stringify(c.summary, null, 2)}
                      </pre>
                    )}
                  </div>
                ))}
              </div>

              <h3 className="mb-2 mt-5 text-sm font-medium">项目目录（{detail.projectDirs.length}）</h3>
              <div className="max-h-40 space-y-1 overflow-auto text-xs">
                {detail.projectDirs.map((p) => (
                  <div key={p} className="rounded px-2 py-1 font-mono" style={{ background: 'var(--panel-2)', color: 'var(--muted)' }}>
                    {p}
                  </div>
                ))}
                {detail.projectDirs.length === 0 && <div style={{ color: 'var(--muted)' }}>未发现关联项目</div>}
              </div>
            </section>

            <section>
              <h3 className="mb-2 text-sm font-medium">数据目录</h3>
              <div className="space-y-2">
                {detail.dataDirs.map((d) => (
                  <div key={d.path} className="flex items-center justify-between rounded-lg px-3 py-2 text-xs" style={{ background: 'var(--panel-2)' }}>
                    <div>
                      <div>{d.label}</div>
                      <div className="font-mono" style={{ color: 'var(--muted)' }}>{d.path}</div>
                    </div>
                    <div className="shrink-0" style={{ color: 'var(--muted)' }}>{formatBytes(d.sizeBytes)}</div>
                  </div>
                ))}
              </div>

              <h3 className="mb-2 mt-5 text-sm font-medium">技能（{detail.skills.length}）</h3>
              <div className="max-h-52 space-y-1 overflow-auto">
                {detail.skills.map((s) => (
                  <div key={s.id} className="flex items-center justify-between rounded px-2 py-1.5 text-xs" style={{ background: 'var(--panel-2)' }}>
                    <span>{s.name}</span>
                    <span className="font-mono text-[11px]" style={{ color: 'var(--muted)' }}>{s.version || s.installedAt ? relativeTime(s.installedAt) : ''}</span>
                  </div>
                ))}
                {detail.skills.length === 0 && <div className="text-xs" style={{ color: 'var(--muted)' }}>未发现技能</div>}
              </div>
            </section>
          </div>

          {/* 展开原始 JSON */}
          <button
            className="btn mt-4"
            onClick={() => setExpanded((e) => ({ ...e, [detail.info.id]: !e[detail.info.id] }))}
          >
            {expanded[detail.info.id] ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            {expanded[detail.info.id] ? '收起' : '展开'}完整数据
          </button>
          {expanded[detail.info.id] && (
            <pre className="mt-2 max-h-80 overflow-auto rounded-lg p-3 text-xs" style={{ background: 'var(--panel-2)', color: 'var(--muted)' }}>
              {JSON.stringify(detail, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
