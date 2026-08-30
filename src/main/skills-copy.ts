import * as fs from 'fs'
import { basename, join } from 'path'
import { HOME, exists, isDir, listDirs } from './lib/fs'
import type { SkillCopyResult, SkillCopyTarget } from '@shared/types'
import { getStore } from './cache'
import { refreshAll } from './engine'

/**
 * 技能跨智能体复制：把源技能目录整体拷贝到目标智能体的用户级技能目录。
 * 已存在同名技能时默认跳过，overwrite=true 则先备份再覆盖。
 */

interface TargetDef {
  agentId: string
  agentName: string
  color: string
  skillsDir: string
  /** 该智能体是否确认按此目录发现用户技能 */
  verified: boolean
  note?: string
}

const TARGETS: TargetDef[] = [
  {
    agentId: 'codebuddy',
    agentName: 'CodeBuddy',
    color: '#3b82f6',
    skillsDir: join(HOME, '.codebuddy/skills'),
    verified: true
  },
  {
    agentId: 'workbuddy',
    agentName: 'WorkBuddy',
    color: '#10b981',
    skillsDir: join(HOME, '.workbuddy/skills'),
    verified: true
  },
  {
    agentId: 'loomy',
    agentName: 'Loomy OpenCode',
    color: '#06b6d4',
    skillsDir: join(HOME, '.config/loomy-opencode/skills'),
    verified: true
  },
  {
    agentId: 'hub',
    agentName: 'Hub',
    color: '#14b8a6',
    skillsDir: join(HOME, '.hub/skills'),
    verified: true
  },
  {
    agentId: 'zcode',
    agentName: 'ZCode',
    color: '#6366f1',
    skillsDir: join(HOME, '.zcode/skills'),
    verified: false,
    note: '按 Claude 系约定创建个人技能目录；是否被识别取决于 ZCode 版本'
  },
  {
    agentId: 'opencode',
    agentName: 'OpenCode',
    color: '#f97316',
    skillsDir: join(HOME, '.config/opencode/skills'),
    verified: false,
    note: '目录尚不存在，将自动创建；是否被识别取决于 OpenCode 版本'
  },
  {
    agentId: 'trae-cn',
    agentName: 'Trae CN',
    color: '#ef4444',
    skillsDir: '',
    verified: false,
    note: '技能由扩展/市场体系管理，无用户技能目录'
  },
  {
    agentId: 'qoder',
    agentName: 'Qoder',
    color: '#f59e0b',
    skillsDir: '',
    verified: false,
    note: '技能由插件体系管理'
  },
  {
    agentId: 'dsh',
    agentName: 'DSH',
    color: '#8b5cf6',
    skillsDir: '',
    verified: false,
    note: '使用 agent-presets 预设体系，格式不同'
  }
]

function countSkills(dir: string): number {
  if (!isDir(dir)) return 0
  return listDirs(dir).filter((d) => exists(join(d, 'SKILL.md'))).length
}

export function listSkillCopyTargets(): SkillCopyTarget[] {
  return TARGETS.map((t) => ({
    agentId: t.agentId,
    agentName: t.agentName,
    color: t.color,
    skillsDir: t.skillsDir || '—',
    exists: t.skillsDir ? isDir(t.skillsDir) : false,
    installedSkillCount: t.skillsDir ? countSkills(t.skillsDir) : 0,
    support: !!t.skillsDir,
    note: t.note
  }))
}

export async function copySkill(skillId: string, agentIds: string[], overwrite = false): Promise<SkillCopyResult[]> {
  const skill = getStore().listSkills().find((s) => s.id === skillId)
  if (!skill) throw new Error('技能不存在')
  if (!skill.source || !isDir(skill.source)) throw new Error('源技能不是目录型技能，无法复制')

  const results: SkillCopyResult[] = []
  const touchedAgents = new Set<string>()

  for (const agentId of agentIds) {
    const t = TARGETS.find((x) => x.agentId === agentId)
    if (!t || !t.skillsDir) {
      results.push({ agentId, agentName: agentId, ok: false, message: '该智能体不支持目录型技能复制' })
      continue
    }
    if (skill.agentId === agentId && isDir(skill.source) && skill.source.startsWith(t.skillsDir)) {
      results.push({ agentId, agentName: t.agentName, ok: false, message: '源技能已在该智能体的技能目录中' })
      continue
    }
    try {
      const dest = join(t.skillsDir, basename(skill.source))
      let backupPath: string | undefined
      if (exists(dest)) {
        if (!overwrite) {
          results.push({
            agentId,
            agentName: t.agentName,
            ok: false,
            message: `目标已存在 ${dest}（勾选"覆盖已存在"可替换）`
          })
          continue
        }
        backupPath = `${dest}.agentmgr-bak-${Date.now()}`
        fs.renameSync(dest, backupPath)
      }
      fs.mkdirSync(t.skillsDir, { recursive: true })
      fs.cpSync(skill.source, dest, { recursive: true })
      // 校验拷贝完整：SKILL.md 存在或目录非空
      if (!exists(dest) || fs.readdirSync(dest).length === 0) throw new Error('拷贝后目标目录为空')
      touchedAgents.add(agentId)
      results.push({
        agentId,
        agentName: t.agentName,
        ok: true,
        message: `已复制到 ${dest}`,
        backupPath
      })
    } catch (err) {
      results.push({
        agentId,
        agentName: t.agentName,
        ok: false,
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }

  // 复制成功的目标立即重扫，让技能列表马上可见
  for (const agentId of touchedAgents) {
    await refreshAll(agentId).catch(() => undefined)
  }
  return results
}
