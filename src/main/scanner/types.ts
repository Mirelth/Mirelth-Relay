import { basename, join } from 'path'
import { HOME, exists, listDirs, mtimeIso, parseSkillMd, resolveBin } from '../lib/fs'
import type {
  AgentInfo,
  ConfigFileInfo,
  DataDirInfo,
  McpServer,
  SkillInfo
} from '@shared/types'

/** macOS 应用包候选路径（系统级 + 用户级） */
export function appPaths(...names: string[]): string[] {
  return names.flatMap((n) => [join('/Applications', n), join(HOME, 'Applications', n)])
}

export type InstallState = AgentInfo['installState']

/**
 * 纯函数：安装状态判定。
 * hasEvidence=false（该智能体没有可验证的程序位置）→ unknown；
 * programFound（应用包/可执行文件存在）→ installed；
 * 程序不在但有数据 → residual（已卸载的配置/用量残留）。
 */
export function computeInstallState(o: { hasEvidence: boolean; programFound: boolean; dataFound: boolean }): InstallState {
  if (!o.hasEvidence) return 'unknown'
  if (o.programFound) return 'installed'
  return o.dataFound ? 'residual' : 'unknown'
}

/** 从 meta 声明的本体证据判定安装状态（engine 集中调用） */
export function detectInstallState(meta: ScannerMeta, dataFound: boolean): InstallState {
  const probes = [...(meta.installProbes || []), ...(meta.installProbeResolver?.() || [])]
  const bins = meta.installBins || []
  const hasEvidence = probes.length > 0 || bins.length > 0
  const programFound = probes.some((p) => exists(p)) || bins.some((b) => resolveBin(b) != null)
  return computeInstallState({ hasEvidence, programFound, dataFound })
}

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
  /** 程序本体证据路径（应用包等）：任一存在即判定"已安装"。缺省且无 installBins 时状态为"未确认" */
  installProbes?: string[]
  /** 程序本体证据：CLI 命令名，在 PATH 与常见安装目录解析 */
  installBins?: string[]
  /** 运行时计算的本体证据（如可移动卷上的 app 搜索），每次扫描求值一次 */
  installProbeResolver?: () => string[]
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
      installState: 'unknown',
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
