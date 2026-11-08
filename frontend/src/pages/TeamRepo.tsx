import { useCallback, useEffect, useState } from 'react'
import { CloudUpload, CloudDownload, FolderGit, Plus } from 'lucide-react'

interface TeamSkill {
  name: string
  hasSkillMd: boolean
  hasPrompt: boolean
  hasExamples: boolean
}

interface TeamRule {
  name: string
  size: number
  preview: string
}

interface RepoStatus {
  initialized: boolean
  isGitRepo: boolean
  remoteUrl?: string
  branch: string
  localChanges: boolean
}

export default function TeamRepo(): React.JSX.Element {
  const [status, setStatus] = useState<RepoStatus | null>(null)
  const [skills, setSkills] = useState<TeamSkill[]>([])
  const [rules, setRules] = useState<TeamRule[]>([])
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [remoteInput, setRemoteInput] = useState('')
  const [showNewRule, setShowNewRule] = useState(false)
  const [ruleName, setRuleName] = useState('')
  const [ruleBody, setRuleBody] = useState('')

  const reload = useCallback(async (): Promise<void> => {
    try {
      const [s, sk, r] = await Promise.all([
        window.api.teamRepoStatus(),
        window.api.teamRepoSkills(),
        window.api.teamRepoRules()
      ])
      setStatus(s)
      setSkills(sk || [])
      setRules(r || [])
    } catch (err) {
      setMessage(`加载失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const act = async (
    fn: () => Promise<{
      success: boolean
      error?: string
      syncedSkills?: string[]
      syncedRules?: string[]
    }>,
    okPrefix: string
  ): Promise<void> => {
    setMessage('')
    try {
      const result = await fn()
      if (result.success) {
        const n = result.syncedSkills
          ? `：${result.syncedSkills.length} 个技能 / ${result.syncedRules?.length ?? 0} 个规则`
          : ''
        setMessage(`${okPrefix}成功${n}`)
        await reload()
      } else {
        setMessage(`${okPrefix}失败：${result.error}`)
      }
    } catch (err) {
      setMessage(`操作失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const addRemote = async (): Promise<void> => {
    if (!remoteInput.trim()) return
    await act(() => window.api.teamRepoAddRemote(remoteInput.trim()), '添加远程')
    setRemoteInput('')
  }

  const saveRule = async (): Promise<void> => {
    if (!ruleName.trim() || !ruleBody.trim()) return
    const name = ruleName.trim().endsWith('.md') ? ruleName.trim() : `${ruleName.trim()}.md`
    await act(() => window.api.teamRepoSaveRule(name, ruleBody), `保存规则 ${name}`)
    setShowNewRule(false)
    setRuleName('')
    setRuleBody('')
  }

  return (
    <div className="space-y-4">
      <div className="text-sm" style={{ color: 'var(--muted)' }}>
        团队仓库是一个 Git 仓库（~/.relay/team-repo），集中管理团队的 Skills
        与规则文件；绑定远程后可在成员间 push/pull 同步。
      </div>

      {message && (
        <div
          className="card p-3 text-sm"
          style={{ color: message.includes('失败') ? 'var(--bad)' : 'var(--ok)' }}
        >
          {message}
        </div>
      )}

      {/* 仓库状态 */}
      <div className="card space-y-2 p-4">
        <div className="text-sm font-medium">仓库状态</div>
        {loading || !status ? (
          <div className="text-xs" style={{ color: 'var(--muted)' }}>
            加载中…
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span
              className="badge"
              style={{
                background: `color-mix(in srgb, ${status.initialized ? 'var(--ok)' : 'var(--bad)'} 14%, transparent)`,
                color: status.initialized ? 'var(--ok)' : 'var(--bad)'
              }}
            >
              {status.initialized ? '已初始化' : '未初始化'}
            </span>
            <span
              className="badge"
              style={{
                background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
                color: 'var(--accent)'
              }}
            >
              分支 {status.branch}
            </span>
            {status.remoteUrl && (
              <span
                className="truncate font-mono text-xs"
                style={{ color: 'var(--muted)' }}
                title={status.remoteUrl}
              >
                {status.remoteUrl}
              </span>
            )}
            {status.localChanges && (
              <span
                className="badge"
                style={{
                  background: 'color-mix(in srgb, var(--warn) 14%, transparent)',
                  color: 'var(--warn)'
                }}
              >
                有未提交更改
              </span>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          {status && !status.initialized && (
            <button
              className="btn btn-primary"
              onClick={() => void act(() => window.api.teamRepoInit(), '初始化')}
              disabled={loading}
            >
              <FolderGit size={14} />
              初始化仓库
            </button>
          )}
          {status?.initialized && (
            <>
              <button
                className="btn btn-primary"
                onClick={() => void act(() => window.api.teamRepoPush(), '推送')}
                disabled={loading}
              >
                <CloudUpload size={14} />
                推送到远程
              </button>
              <button
                className="btn"
                onClick={() => void act(() => window.api.teamRepoPull(), '拉取')}
                disabled={loading}
              >
                <CloudDownload size={14} />
                从远程拉取
              </button>
              <button className="btn" onClick={() => setShowNewRule((v) => !v)}>
                <Plus size={14} />
                新建规则
              </button>
            </>
          )}
        </div>

        {status?.initialized && !status.remoteUrl && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <input
              className="input min-w-0 flex-1 font-mono text-xs"
              placeholder="git@cnb.cool:your-org/team-repo.git（团队共享时填写）"
              value={remoteInput}
              onChange={(e) => setRemoteInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void addRemote()
              }}
            />
            <button className="btn" onClick={() => void addRemote()} disabled={!remoteInput.trim()}>
              绑定远程
            </button>
          </div>
        )}
      </div>

      {showNewRule && (
        <div className="card space-y-3 p-4">
          <label className="grid gap-1">
            <span className="text-xs" style={{ color: 'var(--muted)' }}>
              规则名（自动补 .md）
            </span>
            <input
              className="input"
              value={ruleName}
              onChange={(e) => setRuleName(e.target.value)}
              placeholder="code-style"
            />
          </label>
          <label className="grid gap-1">
            <span className="text-xs" style={{ color: 'var(--muted)' }}>
              规则内容（Markdown）
            </span>
            <textarea
              className="input min-h-32 font-mono text-xs"
              value={ruleBody}
              onChange={(e) => setRuleBody(e.target.value)}
              placeholder="# 团队代码规范&#10;- 提交信息使用中文&#10;…"
            />
          </label>
          <div className="flex justify-end gap-2">
            <button className="btn" onClick={() => setShowNewRule(false)}>
              取消
            </button>
            <button
              className="btn btn-primary"
              disabled={!ruleName.trim() || !ruleBody.trim()}
              onClick={() => void saveRule()}
            >
              保存
            </button>
          </div>
        </div>
      )}

      {/* 技能列表 */}
      <div className="card overflow-hidden">
        <div
          className="border-b px-4 py-3 text-sm font-medium"
          style={{ borderColor: 'var(--border)' }}
        >
          团队技能（{skills.length}）
        </div>
        {skills.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs" style={{ color: 'var(--muted)' }}>
            暂无技能。skills/&lt;name&gt;/SKILL.md 结构的目录会被识别为团队技能。
          </div>
        ) : (
          <div className="grid gap-3 p-4 md:grid-cols-2 lg:grid-cols-3">
            {skills.map((skill) => (
              <div
                key={skill.name}
                className="rounded-lg border p-3"
                style={{ borderColor: 'var(--border)' }}
              >
                <div className="mb-2 font-medium">{skill.name}</div>
                <div className="space-y-0.5 text-xs" style={{ color: 'var(--muted)' }}>
                  <div>{skill.hasSkillMd ? '✓' : '✗'} SKILL.md</div>
                  <div>{skill.hasPrompt ? '✓' : '✗'} prompt.md</div>
                  <div>{skill.hasExamples ? '✓' : '✗'} examples.md</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 规则列表 */}
      <div className="card overflow-hidden">
        <div
          className="border-b px-4 py-3 text-sm font-medium"
          style={{ borderColor: 'var(--border)' }}
        >
          团队规则（{rules.length}）
        </div>
        {rules.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs" style={{ color: 'var(--muted)' }}>
            暂无规则，点击上方「新建规则」创建第一条
          </div>
        ) : (
          <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
            {rules.map((rule) => (
              <div key={rule.name} className="px-4 py-3">
                <div className="text-sm font-medium">{rule.name}</div>
                <div
                  className="mt-1 truncate text-xs"
                  style={{ color: 'var(--muted)' }}
                  title={rule.preview}
                >
                  {rule.preview || '（空文件）'}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
