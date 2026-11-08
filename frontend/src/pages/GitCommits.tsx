import { Fragment, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Download, GitCommitHorizontal, Search } from 'lucide-react'
import type { AgentInfo, CommitFileChange, CommitInfo } from '@shared/types'
import { toCsv } from '@shared/csv'
import { useRefresh } from '../components/Layout'
import { formatDate } from '../lib/format'

const RANGES = [
  { label: '全部时间', days: 0 },
  { label: '当天', days: 1 },
  { label: '最近 3 天', days: 3 },
  { label: '最近 7 天', days: 7 },
  { label: '最近 30 天', days: 30 },
  { label: '最近 90 天', days: 90 }
]

export default function GitCommits() {
  const [commits, setCommits] = useState<CommitInfo[]>([])
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [agentId, setAgentId] = useState('')
  const [project, setProject] = useState('')
  const [rangeDays, setRangeDays] = useState(0)
  const [search, setSearch] = useState('')
  const [detail, setDetail] = useState<Record<string, CommitFileChange[]>>({})
  const [openRows, setOpenRows] = useState<Set<string>>(new Set())
  const [exportMsg, setExportMsg] = useState('')
  const { refreshTick } = useRefresh()

  useEffect(() => {
    setLoading(true)
    void window.api.scanAgents().then(setAgents)
    // 先取全量列表，再在客户端过滤，避免多次跨进程往返
    void window.api
      .listCommits({ limit: 500 })
      .then(setCommits)
      .finally(() => setLoading(false))
  }, [refreshTick])

  const agentMap = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents])

  const filtered = useMemo(() => {
    const since = rangeDays > 0 ? Date.now() - rangeDays * 86400_000 : 0
    const q = search.trim().toLowerCase()
    return commits.filter((c) => {
      if (agentId && !c.agentIds.includes(agentId)) return false
      if (project && c.repoPath !== project) return false
      if (since && new Date(c.date).getTime() < since) return false
      if (
        q &&
        !c.message.toLowerCase().includes(q) &&
        !c.author.toLowerCase().includes(q) &&
        !c.repoName.toLowerCase().includes(q)
      )
        return false
      return true
    })
  }, [commits, agentId, project, rangeDays, search])

  const projects = useMemo(() => {
    const set = new Set(commits.map((c) => c.repoPath))
    return [...set].map((p) => ({ path: p, name: p.split('/').pop() || p }))
  }, [commits])

  const exportCsv = async (): Promise<void> => {
    const rows = filtered.map((c) => [
      c.shortHash,
      new Date(c.date).toLocaleString('zh-CN', { hour12: false }),
      c.repoName,
      c.repoPath,
      c.agentIds.map((aid) => agentMap.get(aid)?.name || aid).join('、'),
      c.author,
      c.email,
      c.message,
      c.additions,
      c.deletions,
      c.filesChanged
    ])
    const res = await window.api.exportSave({
      defaultName: 'relay-commits.csv',
      content: toCsv(
        [
          '提交',
          '时间',
          '项目',
          '路径',
          '智能体',
          '作者',
          '邮箱',
          '信息',
          '新增行',
          '删除行',
          '文件数'
        ],
        rows
      ),
      kind: 'csv'
    })
    setExportMsg(
      res.savedPath ? `已导出：${res.savedPath}` : res.error ? `导出失败：${res.error}` : ''
    )
    setTimeout(() => setExportMsg(''), 6000)
  }

  const toggleRow = (id: string): void => {
    setOpenRows((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
        if (!detail[id]) {
          void window.api.getCommitDetail(id).then((d) => {
            setDetail((prev) => ({ ...prev, [id]: d?.files || [] }))
          })
        }
      }
      return next
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select className="input" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          <option value="">全部智能体</option>
          {agents
            .filter((a) => a.detected)
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
        </select>
        <select className="input" value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="">全部项目</option>
          {projects.map((p) => (
            <option key={p.path} value={p.path}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          className="input"
          value={rangeDays}
          onChange={(e) => setRangeDays(Number(e.target.value))}
        >
          {RANGES.map((r) => (
            <option key={r.days} value={r.days}>
              {r.label}
            </option>
          ))}
        </select>
        <div className="relative">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2"
            style={{ color: 'var(--muted)' }}
          />
          <input
            className="input pl-8"
            placeholder="搜索提交信息 / 作者…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 220 }}
          />
        </div>
        <button
          className="btn"
          onClick={() => void exportCsv()}
          disabled={loading || filtered.length === 0}
        >
          <Download size={14} /> 导出 CSV
        </button>
        <span className="ml-auto text-sm" style={{ color: 'var(--muted)' }}>
          {loading
            ? '加载中…'
            : exportMsg
              ? exportMsg
              : `${filtered.length} 次提交（来自 ${projects.length} 个仓库）`}
        </span>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr
              className="border-b text-left text-xs"
              style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
            >
              <th className="w-8 px-2 py-3"></th>
              <th className="px-3 py-3">提交</th>
              <th className="px-3 py-3">项目</th>
              <th className="px-3 py-3">智能体</th>
              <th className="px-3 py-3">作者</th>
              <th className="px-3 py-3">时间</th>
              <th className="px-3 py-3 text-right">变更</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => {
              const open = openRows.has(c.id)
              return (
                <Fragment key={c.id}>
                  <tr
                    className="row-hover cursor-pointer border-b"
                    style={{ borderColor: 'var(--border)' }}
                    onClick={() => toggleRow(c.id)}
                  >
                    <td className="px-2 py-2.5">
                      {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-baseline gap-2">
                        <span className="font-mono text-xs" style={{ color: 'var(--accent)' }}>
                          {c.shortHash}
                        </span>
                        <span className="max-w-lg truncate">{c.message}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-xs">{c.repoName}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {c.agentIds.map((aid) => {
                          const a = agentMap.get(aid)
                          return (
                            <span
                              key={aid}
                              className="badge"
                              style={{
                                background: (a?.color || '#666') + '22',
                                color: a?.color || '#999'
                              }}
                            >
                              {a?.name || aid}
                            </span>
                          )
                        })}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-xs">{c.author}</td>
                    <td className="px-3 py-2.5 text-xs" style={{ color: 'var(--muted)' }}>
                      {formatDate(c.date)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-xs">
                      <span style={{ color: 'var(--ok)' }}>+{c.additions}</span>{' '}
                      <span style={{ color: 'var(--bad)' }}>−{c.deletions}</span>
                    </td>
                  </tr>
                  {open && (
                    <tr
                      className="border-b"
                      style={{ borderColor: 'var(--border)', background: 'var(--panel-2)' }}
                    >
                      <td colSpan={7} className="px-10 py-3">
                        {detail[c.id] ? (
                          <div className="max-h-64 space-y-1 overflow-auto">
                            {detail[c.id].map((f) => (
                              <div
                                key={f.file}
                                className="flex items-center justify-between rounded px-2 py-1 font-mono text-xs"
                              >
                                <span className="truncate">{f.file}</span>
                                <span className="shrink-0">
                                  <span style={{ color: 'var(--ok)' }}>+{f.additions}</span>{' '}
                                  <span style={{ color: 'var(--bad)' }}>−{f.deletions}</span>
                                </span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="text-xs" style={{ color: 'var(--muted)' }}>
                            加载变更文件中…
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
            {!loading && filtered.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-10 text-center"
                  style={{ color: 'var(--muted)' }}
                >
                  <GitCommitHorizontal size={28} className="mx-auto mb-2 opacity-50" />
                  没有匹配的提交记录
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
