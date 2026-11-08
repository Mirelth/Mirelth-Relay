# Relay（智能体中继）

跨平台桌面工具：统一监控和管理电脑上已安装的 AI 编码智能体（检测安装状态、汇总 Skills、监控 MCP 服务、聚合 Git 提交、统计 Token 消耗），并内置一个可路由、可容错的 LLM 聚合网关。

**单运行时**：根目录的 Go 程序 + `frontend/`（Wails 把前端打进同一个可执行文件）。
历史上的 Electron 版本已移除，能力全部迁到 Go（见文末「迁移说明」）。

## 功能

| 模块 | 说明 |
|---|---|
| 仪表盘 | 智能体 / Skills / MCP / Token 总览卡片，用量趋势，智能体与模型排行 |
| 智能体 | 卡片网格展示检测到的智能体（名称 / 厂商 / 版本 / 类型），点击查看配置摘要（凭据自动脱敏）、数据目录及大小、关联项目。基于程序本体证据（应用包 / PATH 上的可执行文件）标注 **已安装 / 已卸载·配置残留 / 状态未知**，可按状态筛选——已卸载智能体的历史消耗仍计入统计 |
| Skills | 跨智能体技能汇总表：名称 / 所属智能体 / 版本 / 描述 / 安装时间，支持搜索与按智能体筛选 |
| MCP 服务 | 按智能体分组，连接状态徽标（在线 / 离线 / 未验证 / 禁用），工具列表，一键检测全部连接（HTTP 型发 `initialize` + `tools/list`，stdio 型只校验命令存在） |
| Git 提交 | 聚合各智能体关联项目的 `git log`，按智能体 / 项目 / 时间范围 / 关键字筛选，行展开查看逐文件变更统计 |
| Token 统计 | 按天 / 按智能体 / 按模型三个维度，趋势图 + 排行 + 模型占比；数据来自各智能体自己的会话与用量库（不是估算） |
| 网关 | OpenAI 兼容端点，支持**账号池 + 失效切换**：同一模型可挂多个账号，429/5xx/超时自动换号重试，失败账号按指数冷却；详见 [docs/GATEWAY.md](docs/GATEWAY.md) |
| 网关观测 | 请求轨迹（候选顺序 + 逐次尝试 + TTFT/耗时/状态）+ 账号面板（冷却倒计时、近一小时成败、并发占用） |
| 模型配置 | 维护模型供应商 Profile（协议 / Base URL / API Key / 模型列表），一键下发到支持的智能体，写入前自动备份、写后回读校验、失败自动回滚 |
| Hooks | 查看 / 新建 / 删除各智能体 settings 中的 hooks（事件触发命令），写入走同一套安全写 |
| 安全体检 | 只读扫描智能体配置与常见凭证文件：明文密钥（脱敏展示）、文件权限过宽、密钥位于 shell rc / 云同步目录等风险，给出处理建议 |
| 仓库审查 | 对一个本地仓库做只读审查：工作区明文密钥、已提交的敏感文件、未被 `.gitignore` 覆盖的敏感文件；本机装有 Semgrep 时叠加 8 条内置规则（离线运行），未安装则明确降级 |
| 成本估算 | 内置主流模型参考单价（每百万 token，可编辑），按维度估算人民币成本 |
| 团队仓库 | `~/.relay/team-repo` 是个 git 仓库，用来共享 skills / rules；支持初始化、远端、推送、拉取与自动同步配置 |
| 任务 | 任务 / 子任务数据模型、依赖与就绪判定、优先级队列；拆解与执行通过**本机网关**真实调用模型，执行前做约束校验、执行后回写信任度、失败记摩擦点 |
| 约束与信任度 | 四类约束（Token 上限 / 模型白名单 / 成本上限 / 允许时段）× 三种动作（block / warn / log）；信任度 = 成功率×0.7 + 速度因子×0.3 |
| 检查更新 | 拉取发行版 `latest.json`，新版本提示并给出对应平台安装包 |

## 已适配的智能体

ZCode、Trae CN（字节）、Qoder（阿里）、CodeBuddy（腾讯）、WorkBuddy（腾讯）、DSH Web 与 DSH Desktop（DeepSeek，两种分发形态独立统计）、OpenCode、Loomy OpenCode（讯飞）、AgnesCode、ycli、Hub，以及通用探测位：Claude Code、Codex CLI、Gemini CLI、Cursor（装了即自动显示）。

每个智能体是一个独立适配器（`scanner_*.go`），能力不完全时自动降级（如无用量数据则该维度留空）。
用量优先读各自的原生数据库 / 会话日志（ZCode 的 `model_usage`、Agnes 的 `usage_ledger`、OpenCode 的 `session`、DSH 的 `session.jsonl.zstd` 等），读不到就不显示，不做估算。

### 安装状态判定

适配器的 `Meta()` 可选声明 `InstallProbes`（应用包 / 本体路径）、`InstallBins`（PATH 上的命令名，含 `~/.local/bin`、`~/go/bin`、`~/.cargo/bin` 等常见目录）与 `InstallProbeResolver`（运行时计算，如绿色分发 app 在 `/Volumes` 浅层搜索）。扫描后统一判定：**本体在 = 已安装**；**本体不在但有配置数据 = 已卸载·配置残留**；**未声明本体位置（如 DSH Web）= 状态未知**，宁缺毋滥。

### 模型自动配置支持情况

| 智能体 | 支持 | 写入位置 |
|---|---|---|
| ZCode | ✅ 完整 | `~/.zcode/v2/config.json` 的 `provider` 表（新增 `agentmgr:<id>` 条目并启用） |
| OpenCode | ✅ 完整 | `~/.config/opencode/opencode.jsonc` 的 `provider` + `model` |
| Loomy OpenCode | ✅ 完整 | `~/.config/loomy-opencode/opencode.json` 的 `provider` + `model` |
| ycli | ✅ 完整 | `~/.ycli/config.yaml`（单供应商，整体替换 provider/model/api_key/base_url） |
| DSH Web | ⚠️ 部分 | `~/.dsh/settings.yaml` 的 `llm-pi-ai.providers`；API key 走环境变量 `AGENTMGR_<ID>_API_KEY`，写入后需自行设置并重启 |
| DSH Desktop | ⚠️ 部分 | `~/.dsh-desktop/settings.yaml`，同上（两个实体独立下发） |
| 其余 | ❌ | Trae / CodeBuddy / Qoder / WorkBuddy / Agnes 的模型配置在应用内部数据库或账号体系里，无法安全写入，页面中只读展示 |

所有写入先备份为 `<配置路径>.agentmgr-bak-<时间戳>`，写后回读校验 JSON/YAML 可解析；校验失败自动从备份回滚。

### Hooks 管理

读写各智能体 settings 文件顶层的 `hooks` 键（Anthropic 系通用格式，事件如 PreToolUse / PostToolUse / Stop）。
目标位置：ZCode `~/.zcode/v2/setting.json`、Claude Code `~/.claude/settings.json`、CodeBuddy / WorkBuddy / Qoder 各自的 settings.json。
Claude Code 为官方验证格式；其余智能体的 hooks 消费情况取决于其版本，页面中标注「未验证生效」。

## 开发

```bash
# 后端（Go）
go vet ./...          # 静态检查
go test ./...         # 单元测试：扫描器 / 网关容错 / 安全体检 / 写入器 / 任务 / 团队仓库
go build .            # 只编二进制

# 前端（frontend/）
cd frontend && npm install
./node_modules/.bin/tsc --noEmit -p tsconfig.json
./node_modules/.bin/vite build

# 一体运行（需要 Wails CLI）
wails dev                 # 热更新开发
./scripts/build-wails.sh  # 打可执行文件
```

发布流程见 [docs/RELEASE.md](docs/RELEASE.md)，网关行为见 [docs/GATEWAY.md](docs/GATEWAY.md)。

## 架构

单运行时：Go 后端 + Wails 前端。前端只有一棵树（`frontend/src`），页面通过
`window.go.main.App.*` 调用 Go 绑定；旧页面的 `window.api` 通道由 `frontend/src/api.ts`
适配到同一个 `App.Invoke` 入口。

```
frontend/
├── index.html               # Wails 入口
└── src/
    ├── main.tsx             # 安装 window.api 适配层
    ├── App.tsx              # 路由（Overview / Usage / Settings / Trace + 其余页面）
    ├── relay.ts api.ts      # 绑定调用与旧通道适配
    ├── shared/              # 跨层数据模型与 CSV 导出
    ├── components/          # Layout（导航 / 刷新 / 更新）/ Theme / Chart
    ├── pages/               # Overview Usage Settings Trace Agents Skills Mcp
    │                        # GitCommits Models Hooks Security TeamRepo Rules Tasks
    └── i18n/ lib/ assets/

*.go                       # Go 后端（按职责拆文件，平铺在根目录）
├── main.go app.go          # Wails 入口、生命周期、启动扫描
├── gateway.go failover.go router.go trace.go     # 网关：入口 / 换号循环 / 候选排序 / 轨迹
├── store.go cache.go agents.go                   # relay.db：网关用量 + 扫描缓存 + 查询绑定
├── scanner*.go             # 16 个智能体适配器 + 通用件
├── security.go semgrep.go reposecurity.go        # 安全体检 / Semgrep / 仓库审查
├── hooks.go models.go                            # settings 写入（备份 + 回读校验 + 回滚）
├── gitlog.go tasks.go constraints.go teamrepo.go # Git 聚合 / 任务队列 / 约束与信任度 / 团队仓库
├── mcphealth.go fsutil.go config.go              # MCP 探测 / 文件与脱敏 / 配置与迁移
└── notify.go invoke.go                           # 系统通知 / 旧 IPC 通道适配
```

数据流：

- 扫描：`scanAll() → AgentSnapshot → Store.SaveSnapshot() → Go 绑定 → 页面`
- 网关：`请求 → dispatch（候选 + 冷却 + failover）→ 上游 → gw_usage / gw_request 落库 → 观测页`

## 新增一个智能体适配器

1. 新建 `scanner_<name>.go`，实现 `Scanner` 接口（`Meta()` 声明 `Probes` / `InstallProbes` / `InstallBins`，`Scan()` 返回 `AgentSnapshot`）；
2. 在 `scanner_registry.go` 的 `allScanners()` 里注册；
3. 完成。检测不到时自动隐藏；`installState` 由框架按「本体证据 + 数据是否存在」统一判定，不用自己写。

通用件（`skillsFromDir` / `dataDirs` / `configFiles` / `mcpFromMap` / `finalize` / `openSQLiteRO`）见 `scanner.go`。

## 迁移说明

原 Electron 主进程的能力已全部迁到 Go，Electron 运行时、打包配置与 CI 中的 electron 任务已移除：

| 批次 | 内容 | 状态 |
|---|---|---|
| 0 | 前端合并为 `frontend/src` 一棵树 | ✅ |
| 1 | 网关：账号池 / 冷却 / failover / 观测页 | ✅ |
| 2 | 智能体扫描（16 个扫描器）+ 扫描缓存 + MCP 连通性探测 | ✅ |
| 3 | 安全体检 + 仓库审查（含可选 Semgrep 引擎） | ✅ |
| 4 | Hooks 与模型配置下发（写前备份 / 回读校验 / 失败回滚） | ✅ |
| 5 | Git 聚合、任务队列、约束、信任度、团队仓库 | ✅ |
| 6 | 删除 Electron 运行时、打包链路与 electron CI 任务 | ✅ |

## 安全说明

- 凭据文件（credentials.json、config.yaml 中的 API key 等）在展示前统一脱敏，界面永不回显完整密钥；
- 安全体检与仓库审查的命中片段同样只显示首尾各 4 位，Semgrep 返回的片段也会再脱敏一次；
- 前端只能通过 Wails 绑定访问后端：`App.Invoke` 是唯一入口，没有 Node / 文件系统直通；
- MCP 健康检查只发轻量 JSON-RPC `initialize` / `tools/list`，不会执行服务端工具；stdio 型只检查命令是否存在，不拉起子进程；
- 所有配置写入都先备份、写后回读校验，失败自动回滚；解析不了的原配置一律拒写，绝不静默覆盖。
