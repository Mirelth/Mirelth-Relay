/**
 * Git-native 团队仓库管理
 * 负责 ~/.agent-tower/team-repo/ 的初始化、同步和版本控制
 */
import { execFileSync, execSync } from 'child_process'
import { join } from 'path'
import { HOME, exists, readText } from './lib/fs'
import { logger } from './lib/logger'

const TEAM_REPO_DIR = join(HOME, '.agent-tower', 'team-repo')
const SKILLS_DIR = join(TEAM_REPO_DIR, 'skills')
const RULES_DIR = join(TEAM_REPO_DIR, 'rules')
const MCP_DIR = join(TEAM_REPO_DIR, 'mcp')
const HOOKS_DIR = join(TEAM_REPO_DIR, 'hooks')
const KNOWLEDGE_DIR = join(TEAM_REPO_DIR, 'knowledge')

export interface TeamRepoStatus {
  initialized: boolean
  isGitRepo: boolean
  remoteUrl?: string
  branch: string
  lastSyncAt?: number
  localChanges: boolean
}

/** 初始化团队仓库目录结构 */
export function initTeamRepo(): { success: boolean; error?: string } {
  try {
    if (!exists(TEAM_REPO_DIR)) {
      execFileSync('mkdir', ['-p', TEAM_REPO_DIR])
      execFileSync('mkdir', ['-p', SKILLS_DIR, RULES_DIR, MCP_DIR, HOOKS_DIR, KNOWLEDGE_DIR])

      // 初始化 Git 仓库
      execFileSync('git', ['init'], { cwd: TEAM_REPO_DIR })
      execFileSync('git', ['checkout', '-b', 'main'], { cwd: TEAM_REPO_DIR })

      // 创建 .gitignore
      const gitignore = `node_modules/
.DS_Store
*.log
`
      require('fs').writeFileSync(join(TEAM_REPO_DIR, '.gitignore'), gitignore)

      // 初始提交
      execFileSync('git', ['add', '.'], { cwd: TEAM_REPO_DIR })
      execFileSync('git', ['commit', '-m', 'Initial team repo structure'], { cwd: TEAM_REPO_DIR })

      logger.info('team-repo', `团队仓库已初始化：${TEAM_REPO_DIR}`)
      return { success: true }
    }
    return { success: true }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.error('team-repo', `初始化失败：${error}`)
    return { success: false, error }
  }
}

/** 获取仓库状态 */
export function getRepoStatus(): TeamRepoStatus {
  const initialized = exists(TEAM_REPO_DIR)
  const isGitRepo = initialized && exists(join(TEAM_REPO_DIR, '.git'))

  if (!initialized || !isGitRepo) {
    return {
      initialized,
      isGitRepo,
      branch: 'main',
      localChanges: false
    }
  }

  try {
    const branch = execSync('git branch --show-current', { cwd: TEAM_REPO_DIR, encoding: 'utf8' }).trim()
    const remoteUrl = execSync('git remote get-url origin', { cwd: TEAM_REPO_DIR, encoding: 'utf8' }).trim() || undefined
    const status = execSync('git status --porcelain', { cwd: TEAM_REPO_DIR, encoding: 'utf8' }).trim()

    return {
      initialized: true,
      isGitRepo: true,
      remoteUrl,
      branch,
      localChanges: status.length > 0
    }
  } catch {
    return {
      initialized: true,
      isGitRepo: true,
      branch: 'main',
      localChanges: false
    }
  }
}

/** 添加远程仓库 */
export function addRemote(url: string): { success: boolean; error?: string } {
  try {
    if (!exists(TEAM_REPO_DIR)) {
      initTeamRepo()
    }
    execFileSync('git', ['remote', 'add', 'origin', url], { cwd: TEAM_REPO_DIR })
    logger.info('team-repo', `已添加远程仓库：${url}`)
    return { success: true }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.error('team-repo', `添加远程失败：${error}`)
    return { success: false, error }
  }
}

/** Push 到远程 */
export function pushToRemote(branch = 'main'): { success: boolean; error?: string } {
  try {
    execFileSync('git', ['add', '.'], { cwd: TEAM_REPO_DIR })
    execFileSync('git', ['commit', '-m', `Sync at ${new Date().toISOString()}`], { cwd: TEAM_REPO_DIR })
    execFileSync('git', ['push', '-u', 'origin', branch], { cwd: TEAM_REPO_DIR })
    logger.info('team-repo', `已推送到远程：${branch}`)
    return { success: true }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.error('team-repo', `推送失败：${error}`)
    return { success: false, error }
  }
}

/** Pull 从远程 */
export function pullFromRemote(branch = 'main'): { success: boolean; error?: string } {
  try {
    execFileSync('git', ['pull', 'origin', branch], { cwd: TEAM_REPO_DIR })
    logger.info('team-repo', `已从远程拉取：${branch}`)
    return { success: true }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.error('team-repo', `拉取失败：${error}`)
    return { success: false, error }
  }
}

/** 列出所有技能 */
export function listTeamSkills(): string[] {
  if (!exists(SKILLS_DIR)) return []
  try {
    return require('fs')
      .readdirSync(SKILLS_DIR)
      .filter((name: string) => !name.startsWith('.'))
  } catch {
    return []
  }
}

/** 列出所有规则 */
export function listTeamRules(): string[] {
  if (!exists(RULES_DIR)) return []
  try {
    return require('fs')
      .readdirSync(RULES_DIR)
      .filter((name: string) => !name.startsWith('.'))
  } catch {
    return []
  }
}

/** 获取技能内容 */
export function getSkillContent(skillName: string): { skillMd?: string; prompt?: string; examples?: string } {
  const skillDir = join(SKILLS_DIR, skillName)
  if (!exists(skillDir)) return {}

  return {
    skillMd: readText(join(skillDir, 'SKILL.md')) || undefined,
    prompt: readText(join(skillDir, 'prompt.md')) || undefined,
    examples: readText(join(skillDir, 'examples.md')) || undefined
  }
}

/** 获取规则内容 */
export function getRuleContent(ruleName: string): string | null {
  return readText(join(RULES_DIR, ruleName))
}

/** 保存技能 */
export function saveSkill(skillName: string, content: { skillMd: string; prompt?: string; examples?: string }): { success: boolean; error?: string } {
  try {
    const skillDir = join(SKILLS_DIR, skillName)
    if (!exists(skillDir)) {
      execFileSync('mkdir', ['-p', skillDir])
    }
    require('fs').writeFileSync(join(skillDir, 'SKILL.md'), content.skillMd)
    if (content.prompt) {
      require('fs').writeFileSync(join(skillDir, 'prompt.md'), content.prompt)
    }
    if (content.examples) {
      require('fs').writeFileSync(join(skillDir, 'examples.md'), content.examples)
    }
    logger.info('team-repo', `技能已保存：${skillName}`)
    return { success: true }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.error('team-repo', `保存技能失败：${error}`)
    return { success: false, error }
  }
}

/** 保存规则 */
export function saveRule(ruleName: string, content: string): { success: boolean; error?: string } {
  try {
    require('fs').writeFileSync(join(RULES_DIR, ruleName), content)
    logger.info('team-repo', `规则已保存：${ruleName}`)
    return { success: true }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.error('team-repo', `保存规则失败：${error}`)
    return { success: false, error }
  }
}

/** 记录摩擦点 */
export function recordFrictionPoint(agentId: string, description: string, category: string): void {
  try {
    const line = JSON.stringify({
      ts: Date.now(),
      agentId,
      description,
      category
    })
    const filePath = join(KNOWLEDGE_DIR, 'friction-points.jsonl')
    require('fs').appendFileSync(filePath, line + '\n')
  } catch (err) {
    logger.error('team-repo', `记录摩擦点失败：${err}`)
  }
}

export {
  TEAM_REPO_DIR,
  SKILLS_DIR,
  RULES_DIR,
  MCP_DIR,
  HOOKS_DIR,
  KNOWLEDGE_DIR
}
