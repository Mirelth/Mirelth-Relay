import * as fs from 'fs'
import { join } from 'path'
import { HOME, commitWithVerify, exists, loadForWrite, readJson } from './lib/fs'
import type { HookCreateInput, HookEntry, HooksTarget } from '@shared/types'

/**
 * Hooks 管理：读写各智能体 settings 文件顶层的 `hooks` 键
 * （Anthropic 系通用格式：{ hooks: { EventName: [{ matcher, hooks: [{ type:'command', command, timeout }] }] } }）。
 * 写入前自动备份；各智能体是否消费该配置由其自身版本决定。
 */

interface RawHook {
  type?: string
  command?: string
  timeout?: number
}
interface RawMatcherGroup {
  matcher?: string
  hooks?: RawHook[]
  disabled?: boolean
}

interface TargetDef {
  agentId: string
  agentName: string
  color: string
  settingsPath: string
  verified: boolean
  note?: string
}

const TARGETS: TargetDef[] = [
  {
    agentId: 'zcode',
    agentName: 'ZCode',
    color: '#6366f1',
    settingsPath: join(HOME, '.zcode/v2/setting.json'),
    verified: false,
    note: '配置格式与 Claude Code hooks 通用；是否被当前版本消费取决于 ZCode 版本'
  },
  {
    agentId: 'claude-code',
    agentName: 'Claude Code',
    color: '#d97706',
    settingsPath: join(HOME, '.claude/settings.json'),
    verified: true,
    note: '官方 hooks 配置格式'
  },
  {
    agentId: 'codebuddy',
    agentName: 'CodeBuddy',
    color: '#3b82f6',
    settingsPath: join(HOME, '.codebuddy/settings.json'),
    verified: false,
    note: '同 anthropic 系格式；是否生效取决于 CodeBuddy 版本'
  },
  {
    agentId: 'workbuddy',
    agentName: 'WorkBuddy',
    color: '#10b981',
    settingsPath: join(HOME, '.workbuddy/settings.json'),
    verified: false,
    note: '同 anthropic 系格式；是否生效取决于 WorkBuddy 版本'
  },
  {
    agentId: 'qoder',
    agentName: 'Qoder',
    color: '#f59e0b',
    settingsPath: join(HOME, '.qoder/settings.json'),
    verified: false,
    note: '同 anthropic 系格式；是否生效取决于 Qoder 版本'
  }
]

function readHooksFile(settingsPath: string): Record<string, RawMatcherGroup[]> {
  const cfg = readJson<{ hooks?: Record<string, RawMatcherGroup[]> }>(settingsPath)
  return cfg?.hooks || {}
}

export function listHooks(): HookEntry[] {
  const out: HookEntry[] = []
  for (const t of TARGETS) {
    if (!exists(t.settingsPath)) continue
    const hooks = readHooksFile(t.settingsPath)
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) continue
      groups.forEach((g, gi) => {
        for (const h of g.hooks || []) {
          if (!h.command) continue
          out.push({
            id: `${t.agentId}|${event}|${gi}|${h.command}`,
            agentId: t.agentId,
            agentName: t.agentName,
            color: t.color,
            event,
            matcher: g.matcher,
            command: h.command,
            timeout: h.timeout,
            sourcePath: t.settingsPath
          })
        }
      })
    }
  }
  return out
}

export function listHookTargets(): HooksTarget[] {
  return TARGETS.map((t) => {
    const installed = exists(t.settingsPath)
    return {
      agentId: t.agentId,
      agentName: t.agentName,
      color: t.color,
      settingsPath: t.settingsPath,
      exists: installed,
      hookCount: installed ? Object.values(readHooksFile(t.settingsPath)).reduce((n, g) => n + (g?.length || 0), 0) : 0,
      verified: t.verified,
      note: t.note
    }
  })
}

function writeHooks(settingsPath: string, hooks: Record<string, RawMatcherGroup[]>): string {
  const cfg = loadForWrite(settingsPath, (p) => readJson<Record<string, unknown>>(p))
  if (Object.keys(hooks).length > 0) cfg.hooks = hooks
  else delete cfg.hooks
  const bak = commitWithVerify(
    settingsPath,
    () => fs.writeFileSync(settingsPath, JSON.stringify(cfg, null, 2) + '\n'),
    (p) => readJson(p)
  )
  if (!bak) throw new Error('settings 文件不存在，无法写入')
  return bak
}

export function createHook(input: HookCreateInput): { backupPath?: string } {
  const t = TARGETS.find((x) => x.agentId === input.agentId)
  if (!t) throw new Error('不支持在该智能体上管理 hooks')
  if (!exists(t.settingsPath)) throw new Error('未检测到该智能体的 settings 文件')
  if (!input.command.trim()) throw new Error('命令不能为空')
  const hooks = readHooksFile(t.settingsPath)
  const groups = hooks[input.event] || []
  groups.push({
    ...(input.matcher ? { matcher: input.matcher } : {}),
    hooks: [{ type: 'command', command: input.command.trim(), ...(input.timeout ? { timeout: input.timeout } : {}) }]
  })
  hooks[input.event] = groups
  return { backupPath: writeHooks(t.settingsPath, hooks) }
}

export function deleteHook(hookId: string): { backupPath?: string } {
  const [agentId, event, gi, command] = hookId.split('|')
  const t = TARGETS.find((x) => x.agentId === agentId)
  if (!t || !exists(t.settingsPath)) throw new Error('未找到对应的 hooks 配置')
  const hooks = readHooksFile(t.settingsPath)
  const groups = hooks[event]
  if (!Array.isArray(groups)) throw new Error('未找到对应事件的 hooks')
  const group = groups[Number(gi)]
  if (!group?.hooks) throw new Error('未找到对应 hook 条目')
  group.hooks = group.hooks.filter((h) => h.command !== command)
  if (group.hooks.length === 0) groups.splice(Number(gi), 1)
  if (groups.length === 0) delete hooks[event]
  return { backupPath: writeHooks(t.settingsPath, hooks) }
}
