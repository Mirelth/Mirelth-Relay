# AgentTower（智能体塔台）

跨平台桌面工具，统一监控和管理电脑上已安装的 AI 编码智能体：检测安装状态、汇总 Skills、监控 MCP 服务、聚合 Git 提交、统计 Token 消耗。基于 **Electron 39 + electron-vite + React 19 + TypeScript + Tailwind 4 + ECharts**。

## 下载

最新发布：**v1.0.0**（[发行版页面](https://cnb.cool/WeiGuangXunTu/AgentTower/-/releases)）

| 平台 | 安装包 |
|---|---|
| macOS（Apple Silicon） | [agent-tower-1.0.0-arm64.dmg](https://cnb.cool/WeiGuangXunTu/AgentTower/-/releases/download/v1.0.0/agent-tower-1.0.0-arm64.dmg) |
| macOS（Intel） | [agent-tower-1.0.0-x64.dmg](https://cnb.cool/WeiGuangXunTu/AgentTower/-/releases/download/v1.0.0/agent-tower-1.0.0-x64.dmg) |
| Windows 10/11（x64） | [agent-tower-1.0.0-setup.exe](https://cnb.cool/WeiGuangXunTu/AgentTower/-/releases/download/v1.0.0/agent-tower-1.0.0-setup.exe) |

> 安装包未做代码签名：macOS 首次打开如遇拦截，右键 App 选「打开」或执行 `xattr -cr /Applications/AgentTower.app`；Windows 如遇 SmartScreen 提示，点「更多信息 → 仍要执行」。

## 功能

| 模块 | 说明 |
|---|---|
| 仪表盘 | 智能体/Skills/MCP/Token 总览卡片，14 天消耗趋势，智能体消耗排行，模型分布 |
| 智能体 | 卡片网格展示所有检测到的智能体（名称/厂商/版本/类型），点击查看配置摘要（凭据自动脱敏）、数据目录及大小、关联项目 |
| Skills | 跨智能体技能汇总表：名称/所属智能体/版本/描述/安装时间，支持搜索与按智能体筛选 |
| MCP 服务 | 按智能体分组，连接状态徽标（在线/离线/未验证/禁用），工具列表，一键检测全部连接（HTTP 型 MCP 走 JSON-RPC 探测并拉取工具清单） |
| Git 提交 | 聚合各智能体关联项目的 git log，按智能体/项目/时间范围/关键字筛选，行展开查看逐文件变更统计 |
| Token 统计 | 按天/按智能体/按模型三个维度，趋势折线图 + 堆叠柱状图 + 模型占比环形图，支持下钻单模型明细 |
| 模型配置 | 维护模型供应商 Profile（协议类型/Base URL/API Key/模型列表），一键下发到支持自动配置的智能体，写入前自动备份原配置 |
| Hooks | 查看/新建/删除各智能体 settings 中的 hooks（事件触发命令），写入前自动备份 |

顶部支持手动刷新（全量重扫）与自动刷新（30 秒/1 分钟/5 分钟），顶栏可切换**亮色/暗色主题**（记忆上次选择）。扫描结果落本地缓存库（`userData/cache.sqlite`），界面读取全部走缓存。

## 已适配的智能体

ZCode、Trae CN（字节）、Qoder（阿里）、CodeBuddy（腾讯）、WorkBuddy（腾讯）、DSH（DeepSeek）、OpenCode、Loomy OpenCode（讯飞）、AgnesCode、ycli、Hub，以及通用探测位：Claude Code、Codex CLI、Gemini CLI、Cursor（装了即自动显示）。

每个智能体是一个独立适配器，能力不完全时自动降级（如无用量数据则该维度留空）。

### 模型自动配置支持情况

| 智能体 | 支持 | 写入位置 |
|---|---|---|
| ZCode | ✅ 完整 | `~/.zcode/v2/config.json` 的 `provider` 表（新增 `agentmgr:<id>` 条目并启用） |
| OpenCode | ✅ 完整 | `~/.config/opencode/opencode.jsonc` 的 `provider` + `model` |
| Loomy OpenCode | ✅ 完整 | `~/.config/loomy-opencode/opencode.json` 的 `provider` + `model`/`small_model` |
| ycli | ✅ 完整 | `~/.ycli/config.yaml`（单供应商，整体替换 provider/model/api_key/base_url） |
| DSH | ⚠️ 部分 | `~/.dsh/settings.yaml` 的 `llm-pi-ai.providers`；API key 走环境变量（`AGENTMGR_<ID>_API_KEY`），写入后需自行设置并重启 DSH |
| 其余 | ❌ | CodeBuddy / Trae / Qoder / WorkBuddy / Agnes 的模型配置存在应用内部数据库或账号体系，无法安全写入，页面中只读展示 |

所有写入均先备份原文件为 `<配置路径>.agentmgr-bak-<时间戳>`，写后回读校验 JSON/YAML 可解析。

### Hooks 管理

读写各智能体 settings 文件顶层的 `hooks` 键（Anthropic 系通用格式，事件如 PreToolUse/PostToolUse/Stop）。目标位置：ZCode `~/.zcode/v2/setting.json`、Claude Code `~/.claude/settings.json`、CodeBuddy/WorkBuddy/Qoder 各自的 settings.json。Claude Code 为官方验证格式；其余智能体的 hooks 消费情况取决于其版本，页面中标注「未验证生效」。

## 开发

```bash
npm install         # 需要时设置 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm run dev         # 开发模式（主进程改动自动重启，渲染进程热更新）
npm run typecheck   # 类型检查
npm test            # 单元测试（vitest：安全写入 / 模型配置写入器 / hooks / 扫描器回归）
npm run build:mac   # 打包 macOS（win/linux 同理：build:win / build:linux）
```

发布相关：代码签名与公证流程见 [docs/SIGNING.md](docs/SIGNING.md)；CNB 发行版上传与发版检查清单见 [docs/RELEASE.md](docs/RELEASE.md)。

调试辅助：`AGENTMGR_SHOT=<目录> npm run dev` —— 启动后自动逐页截图（暗色 + 亮色各一轮）并退出（用于自动化视觉验证）。

## 架构

```
src/
├── shared/types.ts          # 跨进程共享的数据模型与 IPC API 契约
├── main/                    # 主进程（Node 侧）
│   ├── index.ts             # 入口：窗口、初始扫描、截图调试钩子
│   ├── scanner/
│   │   ├── types.ts         # Scanner 接口 / AgentSnapshot / 通用工具
│   │   ├── registry.ts      # 扫描器注册表
│   │   └── agents/*.ts      # 每个智能体一个适配器
│   ├── lib/fs.ts            # JSON/YAML/JSONC 读取、脱敏、SKILL.md 解析、目录大小
│   ├── cache.ts             # 缓存库（better-sqlite3）：agents/skills/mcp/usage/projects
│   ├── engine.ts            # 扫描编排：逐适配器执行，单个失败不影响整体
│   ├── mcp-health.ts        # MCP 连通性探测（HTTP JSON-RPC / stdio 命令检查）
│   ├── models/              # 模型配置：Profile 存储（store.ts）+ 各智能体写入器（appliers.ts）
│   ├── hooks.ts             # Hooks 管理：读写各智能体 settings 的 hooks 键
│   ├── gitlog.ts            # git 聚合（simple-git）：列表用 --shortstat，展开才拉 --numstat
│   └── ipc.ts               # IPC handlers（contextIsolation + preload 白名单）
└── renderer/src/            # 渲染进程（React）
    ├── components/Layout.tsx  # 侧边导航 + 顶栏刷新控制 + RefreshContext
    ├── components/Theme.tsx   # 亮/暗主题：ThemeProvider + 图表调色板（canvas 无法用 CSS 变量）
    ├── components/Chart.tsx   # ECharts 封装（自适应尺寸、随主题重绘）
    └── pages/                 # Dashboard / Agents / Skills / Mcp / GitCommits / Tokens / Models / Hooks
```

数据流：`Scanner.scan() → AgentSnapshot → CacheStore.saveSnapshot() → IPC → React 页面`。
刷新时主进程后台重扫并整体替换对应智能体的缓存行，界面不阻塞。

## 新增一个智能体适配器

1. 在 `src/main/scanner/agents/` 新建文件，实现 `Scanner` 接口（`meta.probes` 决定检测路径，`scan()` 返回 `AgentSnapshot`）；
2. 在 `src/main/scanner/registry.ts` 注册；
3. 完成。检测不到时自动隐藏，无需其他改动。

## 安全说明

- 凭据文件（credentials.json、config.yaml 中的 API key 等）在展示前统一脱敏（`redact()`），界面永不回显完整密钥；
- 渲染进程开启 `contextIsolation`，仅通过 preload 暴露的白名单 IPC 访问主进程；
- MCP 健康检查仅发送轻量 JSON-RPC `initialize`/`tools/list` 请求，不会执行服务端工具。
