# 网关（Go / Wails 侧）

根目录的 Go 程序（`main.go` + Wails 前端 `frontend/`）内置一个仅监听 `127.0.0.1` 的 LLM 网关，
把多个上游账号聚合成一个 OpenAI 兼容端点。本文只描述该网关的路由与容错行为。

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/chat/completions`、`/chat/completions` | OpenAI 兼容补全，`stream: true` 时透传 SSE |
| GET | `/v1/models`、`/models` | 汇总各账号声明的模型（去重） |

鉴权：`Authorization: Bearer <API Key>` 或 `x-api-key`。Key 在「网关」页生成/查看。

响应头：`X-Relay-Request-Id`、`X-Relay-Account`（最终服务该请求的账号名）、
`X-Relay-Attempts`（本次请求实际尝试了几次，>1 表示发生过换账号）。

## 账号池

一个模型可以挂多个账号：同一份 `config.json` 里 `upstreams[]` 的每一条都是一个可路由账号。

```json
{
  "id": "a1", "name": "DeepSeek 主号", "kind": "openai",
  "baseURL": "https://api.deepseek.com/v1", "apiKey": "sk-...",
  "model": "deepseek-chat", "models": ["deepseek-chat", "deepseek-reasoner"],
  "group": "DeepSeek", "weight": 5, "maxConcurrent": 2, "enabled": true
}
```

- `models` 是**权威**声明：写了就只服务这些模型（不再回落到 `model`、`id`、`name`）；留空则回落 `model`，两者都空视为通配。
- `weight` 越大越优先被选中（缺省 1）；`maxConcurrent` 是单账号并发上限（0 表示不限）。
- `group` 只用于面板归类。

旧版扁平配置（无 `schemaVersion` / `models` / `weight`）会在启动时自动升级：
先把原文件逐字节备份成 `config.json.bak-<unix>`，再补默认值写回。升级写盘失败不会丢配置——
沿用已解析的配置启动，并在仪表盘顶部显示黄色提示。

## 路由顺序

`可服务该模型` → `启用中` → `不在冷却` → `权重降序` → `最近服务时间升序`（轮转公平）→ `连续失败次数升序`。

冷却中的账号不会从候选里剔除，只是排到最后并按「最先解冻」排序——即最坏情况下仍然会尝试，
对应「只有把所有账号、密钥与兜底都试过之后才放弃」。

## 失败与冷却

| 上游结果 | 处理 |
|---|---|
| 429 / 408 / 5xx / 连接失败 / 等响应头超时 | 该账号进入冷却，换下一个候选 |
| 401 / 403 | 固定 10 分钟冷却，并标记「鉴权失败」 |
| 404 | 只把「该账号没有这个模型」记 10 分钟，不封账号 |
| 其余 4xx | 判定为调用方自身问题，**不重试**，把上游原话透给客户端（HTTP 502） |

冷却时长：基准 30 秒，按连续失败次数指数翻倍，上限 10 分钟；上游给了 `Retry-After`
（秒数或 HTTP 日期，上限 1 小时）时取两者较大值。成功一次即清零连续失败。

**提交前换账号**：网关只等上游响应头，判定 2xx 后才向客户端写第一个字节。
所以 429/5xx 对调用方完全透明，流式响应也不会漏出失败上游的内容；一旦开始向客户端
发送数据，后续失败不再重试（已发出的字节无法收回）。

单请求预算：最多 3 次尝试或 60 秒；等响应头 45 秒超时；body 不设总超时（避免流式被截断）。
全部账号失败时返回 503，错误信息里带上每个账号最后一次失败原因。

冷却状态持久化在 `state.json`，重启后不会立刻重打已知坏账号。

## 观测

「网关观测」页（侧边栏 → 网关观测）每 5 秒轮询：

- 近 1 小时请求数 / 失败率 / 重试率 / 平均首字延迟；
- 账号面板：可用 / 冷却剩余秒数 / 鉴权失败、近一小时成败数、并发占用、最近服务与最近错误；
- 请求轨迹：点开一行看逐次尝试（账号、状态码、耗时、TTFT、错误、冷却与 Retry-After）。

轨迹写入 `relay.db` 的 `gw_request` / `gw_attempt` 两张表，保留 7 天（写入时最多每 30 分钟裁一次）。
调用方归因依次取 `X-Relay-Agent`、`X-Relay-Source`、`User-Agent` 产品名。

## 相关文件

- `config.go` 配置结构与迁移
- `router.go` 候选排序、冷却记账、单账号并发名额
- `failover.go` 尝试循环、状态码分类、Retry-After 解析
- `trace.go` 轨迹数据结构与调用方归因
- `store.go` `gw_usage` / `gw_request` / `gw_attempt` 三张表
- `frontend/src/pages/Trace.tsx`、`frontend/src/pages/Settings.tsx`

## 本地验证

```bash
export PATH="$PWD/.toolchain/go/bin:$PATH" GOPATH="$PWD/.toolchain/gopath"
go test ./...        # 含 failover 故障注入：503 换号、429 冷却、4xx 不重试、流式提交前不写字节
```

`go test` 里的 `failover_test.go` 用 `httptest` 假上游注入故障，等价于一次本地故障演练。
