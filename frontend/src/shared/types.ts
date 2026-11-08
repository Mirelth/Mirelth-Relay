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

// ---------- 仓库安全审查 ----------

export interface RepoSecurityFinding {
  id: string
  severity: 'high' | 'medium' | 'info'
  category: 'plaintext-secret' | 'committed-env' | 'gitignore-missing' | 'code-secret' | 'code-risk'
  /** 相对仓库根的路径 */
  path: string
  line?: number
  kind: string
  /** 已脱敏的片段（永不包含完整密钥） */
  snippet: string
  advice: string
}

/** 可选的本地 Semgrep 引擎状态（未安装时 available:false） */
export interface SemgrepEngineInfo {
  available: boolean
  version?: string
  /** 本次启用的内置本地规则条数 */
  rules?: number
  /** 引擎原始命中条数（去重/限量前） */
  found?: number
  /** 引擎运行出错时的说明（不影响其余检查结果） */
  error?: string
}

export interface RepoSecurityScanResult {
  at: string
  /** 仓库绝对路径 */
  repo: string
  isGitRepo: boolean
  /** 实际做了内容扫描的文本文件数 */
  scannedFiles: number
  /** 文件数超上限、未扫全 */
  truncated: boolean
  semgrep?: SemgrepEngineInfo
  findings: RepoSecurityFinding[]
}

// ---------- LLM 聚合网关 ----------

/** 模型能力档位：路由时按任务复杂度匹配 */
export type GwModelTier = 'light' | 'standard' | 'heavy'

export interface GwModelConfig {
  id: string
  /** 展示名，如 "DeepSeek 快速档" */
  name: string
  kind: 'anthropic' | 'openai-compatible'
  baseURL: string
  apiKey: string
  /** 上游请求时的 model id */
  model: string
  tier: GwModelTier
  enabled: boolean
  updatedAt: string
}

/** 不带回显完整 apiKey 的视图 */
export type GwModelView = Omit<GwModelConfig, 'apiKey'> & {
  apiKeyMasked: string
  hasApiKey: boolean
}

/** 网关本地持久化配置（含明文密钥，仅主进程使用） */
export interface GwGatewayConfig {
  name: string
  port: number
  key: string
  autoStart: boolean
  models: GwModelConfig[]
}

export interface GwGatewayView {
  name: string
  port: number
  running: boolean
  /** 实际监听的访问链接（启动后才有意义） */
  endpoint: string
  keyMasked: string
  hasKey: boolean
  autoStart: boolean
  models: GwModelView[]
}

export interface GwRequestLogEntry {
  id: number
  at: string
  modelId: string
  /** 目标模型展示名 */
  modelName: string
  tier: GwModelTier
  /** 复杂度得分 0-100 */
  complexity: number
  /** 触发的评估信号，如 "推理关键词"、"长输入 12.3k 字符" */
  signals: string[]
  chars: number
  latencyMs: number
  status: 'ok' | 'error' | 'no-model'
  error?: string
}

export interface GwSimulationResult {
  complexity: number
  tier: GwModelTier
  signals: string[]
  chars: number
  chosen?: { id: string; name: string; model: string; tier: GwModelTier }
  /** 路由决策说明 */
  reason: string
}

// ---------- 导出 ----------

export interface ExportSaveOptions {
  /** 建议文件名，如 relay-commits.csv */
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
  /** 从提供方 API 拉取可用模型目录（GET {baseURL}/models） */
  fetchModelCatalog(
    baseURL: string,
    apiKey: string,
    kind: ModelProfile['kind']
  ): Promise<{ models: string[]; error?: string }>
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
  /** 弹系统目录选择框，取消返回 null */
  pickRepoDir(): Promise<string | null>
  repoSecurityScan(repoDir: string): Promise<RepoSecurityScanResult>
  // LLM 聚合网关
  gwGet(): Promise<GwGatewayView>
  gwUpdate(patch: {
    name?: string
    port?: number
    autoStart?: boolean
    models?: GwModelConfig[]
  }): Promise<GwGatewayView>
  gwStart(): Promise<GwGatewayView>
  gwStop(): Promise<GwGatewayView>
  gwRegenerateKey(): Promise<GwGatewayView>
  gwRevealKey(): Promise<string>
  gwLogs(): Promise<GwRequestLogEntry[]>
  gwSimulate(text: string, maxTokens?: number): Promise<GwSimulationResult>
  gwTestModel(id: string): Promise<{ ok: boolean; error?: string; latencyMs: number }>
  exportSave(options: ExportSaveOptions): Promise<ExportSaveResult>
  /** 通用设置项（白名单键，存缓存库 meta 表） */
  settingGet(key: string): Promise<string | null>
  settingSet(key: string, value: string): Promise<void>
  /** 在系统浏览器打开链接（仅 http/https） */
  openExternal(url: string): Promise<void>
  // 团队仓库（配置层）
  teamRepoInit(): Promise<any>
  teamRepoStatus(): Promise<any>
  teamRepoAddRemote(url: string): Promise<any>
  teamRepoPush(): Promise<any>
  teamRepoPull(): Promise<any>
  teamRepoSkills(): Promise<any>
  teamRepoRules(): Promise<any>
  teamRepoGetSkill(name: string): Promise<any>
  teamRepoGetRule(name: string): Promise<any>
  teamRepoSaveSkill(name: string, content: any): Promise<any>
  teamRepoSaveRule(name: string, content: string): Promise<any>
  teamRepoSyncConfig(): Promise<any>
  teamRepoSaveSyncConfig(config: any): Promise<any>
  // 任务管理（执行层）
  tasksList(): Promise<any[]>
  tasksGet(taskId: string): Promise<any>
  tasksCreate(input: any): Promise<any>
  tasksUpdateStatus(taskId: string, status: string): Promise<any>
  tasksDecompose(taskId: string): Promise<any>
  tasksAssignSubTask(taskId: string, subTaskId: string, agentId: string): Promise<any>
  tasksExecuteSubTask(taskId: string, subTaskId: string): Promise<any>
  tasksMonitor(taskId: string): Promise<any>
  tasksCancel(taskId: string): Promise<any>
  tasksReady(): Promise<any[]>
  // 任务队列
  queueStatus(): Promise<any>
  queueEnqueue(taskId: string, priority: number): Promise<any>
  queuePause(): Promise<any>
  queueResume(): Promise<any>
  queueClear(): Promise<any>
  queueTaskIds(): Promise<string[]>
  // 约束管理
  constraintsList(): Promise<any[]>
  constraintsAdd(constraint: any): Promise<any>
  constraintsUpdate(id: string, updates: any): Promise<any>
  constraintsDelete(id: string): Promise<any>
  constraintsAgent(agentId: string): Promise<any[]>
  constraintsValidate(agentId: string, context: any): Promise<any>
  // 信任度评分
  trustScores(): Promise<any[]>
  trustAgent(agentId: string): Promise<any>
  trustUpdate(agentId: string, success: boolean, duration: number): Promise<any>
  trustFrictionStats(agentId?: string): Promise<any>
  trustRank(agentIds: string[]): Promise<any[]>
}
