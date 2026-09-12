import { useEffect, useState } from 'react'

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

export default function TeamRepo() {
  const [status, setStatus] = useState<RepoStatus | null>(null)
  const [skills, setSkills] = useState<TeamSkill[]>([])
  const [rules, setRules] = useState<TeamRule[]>([])
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')

  const loadData = async () => {
    setLoading(true)
    try {
      const [statusRes, skillsRes, rulesRes] = await Promise.all([
        window.api.teamRepoStatus(),
        window.api.teamRepoSkills(),
        window.api.teamRepoRules()
      ])
      setStatus(statusRes)
      setSkills(skillsRes || [])
      setRules(rulesRes || [])
    } catch (err) {
      setMessage(`加载失败：${err}`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadData()
  }, [])

  const handleInit = async () => {
    try {
      const result = await window.api.teamRepoInit()
      if (result.success) {
        setMessage('团队仓库初始化成功')
        loadData()
      } else {
        setMessage(`初始化失败：${result.error}`)
      }
    } catch (err) {
      setMessage(`操作失败：${err}`)
    }
  }

  const handlePush = async () => {
    try {
      const result = await window.api.teamRepoPush()
      if (result.success) {
        setMessage(`推送成功：${result.syncedSkills.length} 个技能，${result.syncedRules.length} 个规则`)
      } else {
        setMessage(`推送失败：${result.error}`)
      }
    } catch (err) {
      setMessage(`操作失败：${err}`)
    }
  }

  const handlePull = async () => {
    try {
      const result = await window.api.teamRepoPull()
      if (result.success) {
        setMessage(`拉取成功：${result.syncedSkills.length} 个技能，${result.syncedRules.length} 个规则`)
        loadData()
      } else {
        setMessage(`拉取失败：${result.error}`)
      }
    } catch (err) {
      setMessage(`操作失败：${err}`)
    }
  }

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">团队仓库</h1>

      {message && (
        <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded text-blue-800">
          {message}
        </div>
      )}

      {/* 仓库状态 */}
      <div className="mb-6 p-4 bg-gray-50 rounded-lg">
        <h2 className="text-lg font-semibold mb-3">仓库状态</h2>
        {status ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-gray-600">初始化：</span>
              <span className={status.initialized ? 'text-green-600' : 'text-red-600'}>
                {status.initialized ? '已初始化' : '未初始化'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-gray-600">Git 仓库：</span>
              <span className={status.isGitRepo ? 'text-green-600' : 'text-yellow-600'}>
                {status.isGitRepo ? '是' : '否'}
              </span>
            </div>
            {status.remoteUrl && (
              <div className="flex items-center gap-2">
                <span className="text-gray-600">远程地址：</span>
                <span className="text-blue-600">{status.remoteUrl}</span>
              </div>
            )}
            <div className="flex items-center gap-2">
              <span className="text-gray-600">分支：</span>
              <span>{status.branch}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-gray-600">本地更改：</span>
              <span className={status.localChanges ? 'text-yellow-600' : 'text-green-600'}>
                {status.localChanges ? '有未提交更改' : '无'}
              </span>
            </div>
          </div>
        ) : (
          <p className="text-gray-500">加载中...</p>
        )}
      </div>

      {/* 操作按钮 */}
      <div className="mb-6 flex gap-3">
        {!status?.initialized && (
          <button
            onClick={handleInit}
            disabled={loading}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            初始化仓库
          </button>
        )}
        {status?.initialized && (
          <>
            <button
              onClick={handlePush}
              disabled={loading}
              className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50"
            >
              推送到远程
            </button>
            <button
              onClick={handlePull}
              disabled={loading}
              className="px-4 py-2 bg-purple-600 text-white rounded hover:bg-purple-700 disabled:opacity-50"
            >
              从远程拉取
            </button>
          </>
        )}
      </div>

      {/* 技能列表 */}
      <div className="mb-6">
        <h2 className="text-lg font-semibold mb-3">团队技能 ({skills.length})</h2>
        {skills.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {skills.map((skill) => (
              <div key={skill.name} className="p-4 border rounded-lg bg-white">
                <h3 className="font-medium mb-2">{skill.name}</h3>
                <div className="text-sm text-gray-600 space-y-1">
                  <div>{skill.hasSkillMd ? '✓ SKILL.md' : '✗ SKILL.md'}</div>
                  <div>{skill.hasPrompt ? '✓ prompt.md' : '✗ prompt.md'}</div>
                  <div>{skill.hasExamples ? '✓ examples.md' : '✗ examples.md'}</div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-gray-500">暂无技能</p>
        )}
      </div>

      {/* 规则列表 */}
      <div>
        <h2 className="text-lg font-semibold mb-3">团队规则 ({rules.length})</h2>
        {rules.length > 0 ? (
          <div className="space-y-2">
            {rules.map((rule) => (
              <div key={rule.name} className="p-3 border rounded bg-white">
                <div className="font-medium">{rule.name}</div>
                <div className="text-sm text-gray-600 mt-1">{rule.preview}...</div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-gray-500">暂无规则</p>
        )}
      </div>
    </div>
  )
}
