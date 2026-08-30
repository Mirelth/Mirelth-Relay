import * as fs from 'fs'
import * as path from 'path'
import { HOME, exists, isDir } from './lib/fs'
import type { SkillCopyResult, SkillCopyTarget } from '@shared/types'
import { getStore } from './cache'

/**
 * 技能复制：把某个智能体的技能目录（含 SKILL.md）拷贝到其他智能体的用户级技能目录。
 * 目标同名目录已存在时默认拒绝，overwrite 时先把旧目录改名备份。
 * ZCode（插件市场管理）、Trae/Qoder（无用户技能目录）不支持作为目标。
 */

interface CopyTargetDef {
  agentId: string
  agentName: string
  color: string
  skillsDir: string
  note?: string
}

const TARGETS: CopyTargetDef[] = [
  { agentId: 'codebuddy', agentName: 'CodeBuddy', color: '#3b82f6', skillsDir: path.join(HOME, '.codebuddy/skills') },
  { agentId: 'workbuddy', agentName: 'WorkBuddy', color: '#10b981', skillsDir: path.join(HOME, '.workbuddy/skills') },
  { agentId: 'loomy', agentName: 'Loomy OpenCode', color: '#06b6d4', skillsDir: path.join(HOME, '.config/loomy-opencode/skills') },
  { agentId: 'hub', agentName: 'Hub', color: '#14b8a6', skillsDir: path.join(HOME, '.hub/skills') },
  { agentId: 'claude-code', agentName: 'Claude Code', color: '#d97706', skillsDir: path.join(HOME, '.claude/skills'), note: '未安装时目录会自动创建，安装后生效' },
  {
    agentId: 'zcode',
    agentName: 'ZCode',
    color: '#6366f1',
    skillsDir: '',
    note: '技能由插件市场管理，目录写入会被更新覆盖，不支持'
  },
  {
    agentId: 'trae-cn',
    agentName: 'Trae CN',
    color: '#ef4444',
    skillsDir: '',
    note: '内置技能目录由应用管理，无用户级技能目录，不支持'
  },
  {
    agentId: 'qoder',
    agentName: 'Qoder',
    color: '#f59e0b',
    skillsDir: '',
    note: '技能经插件体系安装，不支持目录复制'
  }
]

function countSkills(dir: string): number {
  try {
    return fs.readdirSync(dir).filter((n) => !n.startsWith('.') && isDir(path.join(dir, n))).length
  } catch {
    return 0
  }
}

export function listSkillCopyTargets(): SkillCopyTarget[] {
  return TARGETS.map((t) => {
    const supported = t.skillsDir !== ''
    const existsDir = supported && exists(t.skillsDir)
    return {
      agentId: t.agentId,
      agentName: t.agentName,
      color: t.color,
      skillsDir: t.skillsDir || '—',
      exists: existsDir,
      installedSkillCount: existsDir ? countSkills(t.skillsDir) : 0,
      support: supported,
      note: t.note
    }
  })
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDir(s, d)
    else fs.copyFileSync(s, d)
  }
}

export function copySkill(skillId: string, agentIds: string[], overwrite = false): SkillCopyResult[] {
  const store = getStore()
  const all = store.listSkills()
  const skill = all.find((s) => s.id === skillId)
  if (!skill) throw new Error('技能不存在（请先刷新扫描）')
  // 同名技能可能有多条记录（不同目录），优先取含 SKILL.md 的作为复制源
  const candidates = all.filter((s) => s.agentId === skill.agentId && s.name === skill.name && s.source && isDir(s.source))
  const best = candidates.find((s) => exists(path.join(s.source, 'SKILL.md'))) || candidates[0] || skill
  if (!best.source || !isDir(best.source)) {
    throw new Error('该技能没有可复制的目录（可能来自配置清单而非技能目录）')
  }
  const sourceDir = best.source

  const results: SkillCopyResult[] = []
  for (const agentId of agentIds) {
    const t = TARGETS.find((x) => x.agentId === agentId)
    const agentName = t?.agentName || agentId
    if (!t || !t.skillsDir) {
      results.push({ agentId, agentName, ok: false, message: '该智能体不支持技能目录复制' })
      continue
    }
    const dest = path.join(t.skillsDir, skill.name)
    let backupPath: string | undefined
    try {
      if (exists(dest)) {
        if (!overwrite) {
          results.push({ agentId, agentName, ok: false, message: `目标已存在同名技能目录 ${dest}（可勾选覆盖）` })
          continue
        }
        backupPath = `${dest}.agentmgr-bak-${Date.now()}`
        fs.renameSync(dest, backupPath)
      }
      copyDir(sourceDir, dest)
      // 基本校验：目标含 SKILL.md（源也应有；源没有时目录原样复制也算成功）
      const hasSkillMd = exists(path.join(dest, 'SKILL.md'))
      results.push({
        agentId,
        agentName,
        ok: true,
        message: `已复制到 ${dest}${hasSkillMd ? '' : '（注意：源技能目录不含 SKILL.md）'}`,
        backupPath
      })
    } catch (err) {
      results.push({
        agentId,
        agentName,
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        ...(backupPath ? { backupPath } : {})
      })
    }
  }
  return results
}
