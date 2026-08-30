import { basename, join } from 'path'
import { listDirs, mtimeIso, parseSkillMd } from '../lib/fs'
import type {
  AgentInfo,
  ConfigFileInfo,
  DataDirInfo,
  McpServer,
  SkillInfo
} from '@shared/types'

/** 原始 MCP 条目（扫描产物，健康检查前 status 未定） */
export interface RawMcp {
  name: string
  transport: 'stdio' | 'http' | 'sse' | 'unknown'
  endpoint?: string
  enabled: boolean
  tools: { name: string; description?: string }[]
  status?: McpServer['status']
  statusDetail?: string
}

/** 一条 token 用量记录（ts 为毫秒时间戳） */
export interface UsageRecord {
  ts: number
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  requests: number
  costUsd?: number
}

export interface AgentSnapshot {
  info: AgentInfo
  configs: ConfigFileInfo[]
  dataDirs: DataDirInfo[]
  skills: SkillInfo[]
  mcpServers: RawMcp[]
  usage: UsageRecord[]
  projectDirs: string[]
}

export interface ScannerMeta {
  id: string
  name: string
  vendor?: string
  kind: 'cli' | 'ide' | 'desktop'
  color: string
  /** 探测存在性的候选路径（~ 已展开） */
  probes: string[]
}

export interface Scanner {
  meta: ScannerMeta
  scan(): AgentSnapshot
}

let skillSeq = 0
export function makeSkillId(agentId: string, name: string): string {
  return `${agentId}:${name}:${++skillSeq}`
}

export function emptySnapshot(meta: ScannerMeta, detected: boolean): AgentSnapshot {
  return {
    info: {
      id: meta.id,
      name: meta.name,
      vendor: meta.vendor,
      kind: meta.kind,
      detected,
      skillCount: 0,
      mcpCount: 0,
      hasUsage: false,
      projectCount: 0,
      color: meta.color
    },
    configs: [],
    dataDirs: [],
    skills: [],
    mcpServers: [],
    usage: [],
    projectDirs: []
  }
}

export function skillsFromDir(
  agentId: string,
  dir: string,
  opts: { builtin?: boolean } = {}
): SkillInfo[] {
  const out: SkillInfo[] = []
  for (const d of listDirs(dir)) {
    const md = parseSkillMd(join(d, 'SKILL.md'))
    const name = md.name || basename(d)
    out.push({
      id: makeSkillId(agentId, name),
      agentId,
      name,
      version: md.version,
      description: md.description,
      installedAt: mtimeIso(d),
      source: d,
      builtin: opts.builtin ?? false
    })
  }
  return out
}
