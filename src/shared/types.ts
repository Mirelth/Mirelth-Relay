// 跨进程共享的数据模型

export interface AgentInfo {
  id: string
  name: string
  vendor?: string
  version?: string
  /** 智能体类别：cli / ide / desktop */
  kind: 'cli' | 'ide' | 'desktop'
  detected: boolean
  /**
   * 安装状态（相对 detected）：
   * installed = 检测到程序本体（应用包 / 可执行文件）；
   * residual = 未发现本体但有配置或数据残留（多半已卸载，历史消耗仍可见）；
   * unknown = 该智能体无可验证的本体位置，无法判定
   */
  installState: 'installed' | 'residual' | 'unknown'
  /** 能力摘要 */
  skillCount: number
  mcpCount: number
  /** 是否提供了 token 用量数据 */
  hasUsage: boolean
  /** 关联的项目目录数 */
  projectCount: number
  color: string
}

export interface AgentDetail {
  info: AgentInfo
  /** 关键配置文件（脱敏后） */
  configs: ConfigFileInfo[]
  /** 数据目录 */
  dataDirs: DataDirInfo[]
  skills: SkillInfo[]
  mcpServers: McpServer[]
  projectDirs: string[]
}

export interface ConfigFileInfo {
  path: string
  exists: boolean
  /** 解析后的配置摘要（凭据字段已脱敏） */
  summary: Record<string, unknown> | null
  error?: string
}

export interface DataDirInfo {
  path: string
  label: string
  /** 目录大小（字节），-1 表示未统计 */
  sizeBytes: number
}

export interface SkillInfo {
  id: string
  agentId: string
  name: string
  version?: string
  description?: string
  installedAt?: string
  source: string
  builtin: boolean
}

export type McpTransport = 'stdio' | 'http' | 'sse' | 'unknown'
export type McpStatus = 'online' | 'offline' | 'unverified' | 'disabled'

export interface McpTool {
  name: string
  description?: string
}

export interface McpServer {
  id: string
  agentId: string
  name: string
  transport: McpTransport
  /** stdio 命令或 http url */
  endpoint?: string
  status: McpStatus
  statusDetail?: string
  tools: McpTool[]
  lastChecked?: string
  enabled: boolean
}

export interface CommitFileChange {
  file: string
  additions: number
  deletions: number
  status: string
}

export interface CommitInfo {
  /** agentId|repoPath|hash 复合键 */
  id: string
  hash: string
  shortHash: string
  repoPath: string
  repoName: string
  agentIds: string[]
  author: string
  email: string
  date: string
  message: string
  additions: number
  deletions: number
  filesChanged: number
  files: CommitFileChange[]
}

export interface GitFilter {
  agentId?: string
  project?: string
  since?: string
  until?: string
  search?: string
  limit?: number
}

export interface TokenRecord {
  agentId: string
  ts: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  requests: number
  costUsd?: number
}

export type TokenDimension = 'agent' | 'model' | 'day'

export interface TokenSeries {
  key: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  totalTokens: number
  requests: number
  /** 智能体上报的真实成本（USD），多数智能体无此数据 */
  costUsd: number
  /** 估算成本（人民币）：优先上报成本，其次单价表估算 */
  estCostCny: number
}

export interface TokenStatsResult {
  dimension: TokenDimension
  series: TokenSeries[]
  /** 按天的明细（用于折线图，key 为日期） */
  daily: TokenSeries[]
  total: TokenSeries
  models: string[]
  /** 成本估算元信息（时间范围内全量口径） */
  costInfo: CostInfo
}

export interface CostInfo {
  /** 估算总成本（人民币） */
  totalCostCny: number
  /** 有成本数据的 token 量（已定价或智能体上报了成本） */
  pricedTokens: number
  /** 范围内总 token 量 */
  totalTokens: number
  /** 未定价且无上报成本的模型（其成本按 0 计，未计入覆盖） */
  unpricedModels: string[]
  /** 本次估算使用的美元→人民币汇率 */
  rateUsdCny: number
}

export interface TokenDetailQuery {
  model?: string
  agentId?: string
  since?: string
  until?: string
}

export interface DashboardSummary {
  agentCount: number
  /** 已确认安装（程序本体存在）的智能体数 */
  installedAgents: number
  /** 已卸载但配置/数据残留的智能体数 */
  residualAgents: number
  skillCount: number
  mcpTotal: number
  mcpOnline: number
  mcpOffline: number
  todayTokens: number
  yesterdayTokens: number
  last7dTokens: number
  lastScanAt?: string
  repoCount: number
  commitCount7d: number
  topAgents: { agentId: string; name: string; totalTokens: number }[]
  topModels: { model: string; totalTokens: number }[]
}

export interface SkillsFilter {
  search?: string
  agentId?: string
}

export interface ScanProgress {
  phase: 'scanning' | 'done' | 'error'
  agentId?: string
  message?: string
}

export interface RefreshOptions {
  /** 只扫指定 agent，缺省全量 */
  agentId?: string
}

// ---------- 模型配置 ----------

export interface ModelDef {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
}

export interface ModelProfile {
  id: string
  name: string
  /** anthropic 兼容 / openai 兼容 */
  kind: 'anthropic' | 'openai-compatible'
  baseURL: string
  apiKey: string
  models: ModelDef[]
  /** 默认模型（models 之一），部分智能体支持设置 */
  defaultModel?: string
  updatedAt: string
}

/** 不带回显完整 apiKey 的视图 */
export type ModelProfileView = Omit<ModelProfile, 'apiKey'> & {
  apiKeyMasked: string
  hasApiKey: boolean
}

export interface ApplierInfo {
  agentId: string
  agentName: string
  color: string
  /** full = 完整写入；partial = 写入但 API key 需另行注入；none = 不支持 */
  support: 'full' | 'partial' | 'none'
  note?: string
  /** 当前已配置的模型供应商摘要 */
  current: string
}

export interface ApplyOptions {
  /** 写入后设为该智能体的默认模型（支持的智能体生效） */
  setDefault?: boolean
}

export interface ApplyResult {
  agentId: string
  agentName: string
  ok: boolean
  message: string
  backupPath?: string
}

// ---------- Hooks ----------

export interface HookEntry {
  id: string
  agentId: string
  agentName: string
  color: string
  /** 事件名，如 PreToolUse / PostToolUse / Stop */
  event: string
  matcher?: string
  command: string
  timeout?: number
  /** 来源配置文件 */
  sourcePath: string
}

export interface HookCreateInput {
  agentId: string
  event: string
  matcher?: string
  command: string
  timeout?: number
}

// ---------- 技能复制 ----------

export interface SkillCopyTarget {
  agentId: string
  agentName: string
  color: string
  /** 该智能体的用户级技能目录 */
  skillsDir: string
  exists: boolean
  installedSkillCount: number
  support: boolean
  note?: string
}

export interface SkillCopyResult {
  agentId: string
  agentName: string
  ok: boolean
  message: string
  /** 冲突时旧目录的备份路径 */
  backupPath?: string
}

export interface HooksTarget {
  agentId: string
  agentName: string
  color: string
  /** 该智能体的 hooks 配置文件（存在才可管理） */
  settingsPath: string
  exists: boolean
  hookCount: number
  /** 当前版本是否确认消费该配置（未验证的标注提示） */
  verified: boolean
  note?: string
}

// ---------- 检查更新 ----------

export interface UpdateInfo {
  /** 当前运行版本 */
  current: string
  /** feed 上的最新版本（拉取失败时缺省） */
  latest?: string
  /** 存在新版本（不考虑"忽略此版本"） */
  updateAvailable?: boolean
  /** 有新版本且用户未忽略该版本 */
  hasUpdate: boolean
  notes?: string
  publishedAt?: string
  downloads?: { macArm?: string; macIntel?: string; win?: string }
  /** 检查失败时的说明（网络不通、feed 未发布等） */
  error?: string
  checkedAt: string
}

// ---------- 成本估算 ----------

export interface ModelPrice {
  /** 匹配键（小写子串匹配，越长越优先），如 "deepseek-chat" */
  model: string
  currency: 'CNY' | 'USD'
  /** 每百万 token 单价 */
  inputPerM: number
  outputPerM: number
  /** 缺省按输入价 10% 计 */
  cacheReadPerM?: number
  /** 缺省按输入价 125% 计 */
  cacheWritePerM?: number
}

export interface PriceConfig {
  /** 美元→人民币换算，用于 USD 定价与上报成本 */
  rateUsdCny: number
  prices: ModelPrice[]
}

// ---------- 安全体检 ----------

export interface SecurityFinding {
  id: string
  severity: 'high' | 'medium' | 'info'
  category: 'plaintext-secret' | 'loose-permissions'
  agentId?: string
  agentName?: string
  /** 命中的文件路径 */
  path: string
  /** 命中行号 */
  line?: number
  /** 疑似密钥类型描述 */
  kind: string
  /** 已脱敏的片段（永不包含完整密钥） */
  snippet: string
  advice: string
}

export interface SecurityScanResult {
  at: string
  /** 实际读取检查的文件数 */
  scannedFiles: number
  findings: SecurityFinding[]
  /** 已检查过的智能体配置文件路径数（含不存在的） */
  checkedPaths: number
}

// ---------- 导出 ----------

export interface ExportSaveOptions {
  /** 建议文件名，如 agent-tower-commits.csv */
  defaultName: string
  content: string
  kind: 'csv' | 'json'
}

export interface ExportSaveResult {
  canceled: boolean
  savedPath?: string
  error?: string
}

/** IPC API（preload 暴露给渲染进程） */
export interface ApiClient {
  scanAgents(): Promise<AgentInfo[]>
  getAgentDetail(id: string): Promise<AgentDetail>
  listSkills(filter?: SkillsFilter): Promise<SkillInfo[]>
  listMcp(agentId?: string): Promise<McpServer[]>
  checkMcpHealth(serverId: string): Promise<McpServer[]>
  checkAllMcp(agentId?: string): Promise<McpServer[]>
  listCommits(filter?: GitFilter): Promise<CommitInfo[]>
  getCommitDetail(commitId: string): Promise<CommitInfo | null>
  tokenStats(dimension: TokenDimension, query?: TokenDetailQuery): Promise<TokenStatsResult>
  tokenRecords(query?: TokenDetailQuery): Promise<TokenRecord[]>
  dashboard(): Promise<DashboardSummary>
  refresh(
    options?: RefreshOptions
  ): Promise<{ ok: boolean; error?: string; scannedAgents: string[]; durationMs: number }>
  lastScan(): Promise<{ at?: string; agents: string[] }>
  listModelProfiles(): Promise<ModelProfileView[]>
  saveModelProfile(profile: ModelProfile): Promise<void>
  deleteModelProfile(id: string): Promise<void>
  listAppliers(): Promise<ApplierInfo[]>
  applyModelProfile(
    profileId: string,
    agentIds: string[],
    options?: ApplyOptions
  ): Promise<ApplyResult[]>
  listHooks(): Promise<HookEntry[]>
  listHookTargets(): Promise<HooksTarget[]>
  createHook(input: HookCreateInput): Promise<{ backupPath?: string }>
  deleteHook(hookId: string): Promise<{ backupPath?: string }>
  listSkillCopyTargets(): Promise<SkillCopyTarget[]>
  copySkill(skillId: string, agentIds: string[], overwrite?: boolean): Promise<SkillCopyResult[]>
  checkUpdate(): Promise<UpdateInfo>
  getPricing(): Promise<PriceConfig>
  savePricing(config: PriceConfig): Promise<void>
  resetPricing(): Promise<void>
  securityScan(): Promise<SecurityScanResult>
  exportSave(options: ExportSaveOptions): Promise<ExportSaveResult>
  /** 通用设置项（白名单键，存缓存库 meta 表） */
  settingGet(key: string): Promise<string | null>
  settingSet(key: string, value: string): Promise<void>
  /** 在系统浏览器打开链接（仅 http/https） */
  openExternal(url: string): Promise<void>
}
