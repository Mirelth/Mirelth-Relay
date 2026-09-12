import { app } from 'electron'
import { join } from 'path'
import type {
  GwGatewayConfig,
  GwGatewayView,
  GwModelConfig,
  GwRequestLogEntry,
  GwSimulationResult
} from '@shared/types'
import { GwStore } from './store'
import { GatewayServer, callUpstreamText } from './server'
import { simulate, assessComplexity, pickModel } from './router'

/**
 * 网关装配层：单例 store + server + 最近请求环形日志（内存，100 条）。
 * 模型/名称等配置改动即时热生效（server 每次请求重取配置）；
 * 改端口则在运行中自动重启。
 */

const LOG_LIMIT = 100

let store: GwStore | null = null
let server: GatewayServer | null = null
let logs: GwRequestLogEntry[] = []
let endpoint = ''

function getStore(): GwStore {
  if (!store) store = new GwStore(join(app.getPath('userData'), 'llm-gateway.json'))
  return store
}

function getServer(): GatewayServer {
  if (!server) {
    server = new GatewayServer(
      () => getStore().get() as GwGatewayConfig,
      (entry) => {
        logs = [entry, ...logs].slice(0, LOG_LIMIT)
      }
    )
  }
  return server
}

function view(): GwGatewayView {
  const s = getStore()
  return s.toView(s.get(), getServer().running, endpoint)
}

export function gwView(): GwGatewayView {
  return view()
}

export async function gwUpdate(patch: {
  name?: string
  port?: number
  autoStart?: boolean
  models?: GwModelConfig[]
}): Promise<GwGatewayView> {
  const prevPort = getStore().get().port
  getStore().update(patch)
  // 运行中改端口：自动重启，保证访问链接与新端口一致
  if (getServer().running && patch.port != null && patch.port !== prevPort) {
    await getServer().stop()
    endpoint = ''
    await gwStart()
  }
  return view()
}

export async function gwStart(): Promise<GwGatewayView> {
  const { port } = await getServer().start()
  endpoint = getServer().endpoint
  // 端口被占自动顺延时，把实际端口写回配置
  if (port !== getStore().get().port) getStore().update({ port })
  return view()
}

export async function gwStop(): Promise<GwGatewayView> {
  await getServer().stop()
  endpoint = ''
  return view()
}

export function gwRegenerateKey(): GwGatewayView {
  getStore().regenerateKey()
  return view()
}

export function gwRevealKey(): string {
  return getStore().revealKey()
}

export function gwLogs(): GwRequestLogEntry[] {
  return logs
}

export function gwSimulate(text: string, maxTokens = 0): GwSimulationResult {
  const cfg = getStore().get()
  return simulate(cfg.models, text.slice(0, 200000), maxTokens)
}

// ---------- 任务系统执行器（供 execution-engine 调用） ----------

export interface GatewayExecResult {
  output: string
  modelId: string
  modelName: string
  latencyMs: number
}

/**
 * 用网关模型执行一段任务提示。modelId 为空时按复杂度自动路由。
 * 网关没有已启用模型时抛出带引导信息的错误。
 */
export async function gatewayTaskExecutor(
  agentId: string,
  prompt: string,
  opts: { maxTokens?: number; temperature?: number } = {}
): Promise<GatewayExecResult> {
  const cfg = getStore().get()
  const enabled = cfg.models.filter((m) => m.enabled)
  let target = agentId ? enabled.find((m) => m.id === agentId) : undefined
  if (!target && agentId) {
    // 指定的模型不存在/未启用：明确报错而不是悄悄换模型
    throw new Error(`指定的执行模型不存在或未启用：${agentId}`)
  }
  if (!target) {
    const tier = assessComplexity([{ role: 'user', content: prompt }]).tier
    target = pickModel(enabled, tier).chosen?.model
  }
  if (!target) throw new Error('LLM 网关没有已启用的模型，请先在「LLM 网关」页添加')

  const started = Date.now()
  const output = await callUpstreamText(target, [{ role: 'user', content: prompt }], {
    maxTokens: opts.maxTokens,
    temperature: opts.temperature
  })
  return { output, modelId: target.id, modelName: target.name, latencyMs: Date.now() - started }
}

/** 用网关模型把任务描述拆解为子任务描述列表（LLM 拆解，非启发式） */
export async function gatewayDecomposer(description: string): Promise<string[]> {
  const prompt = [
    '把下面的任务拆解为 2-5 个可以直接执行的子任务。',
    '只输出一个 JSON 字符串数组，不要输出其他内容。',
    '任务描述：',
    description.slice(0, 4000)
  ].join('\n')
  const { output } = await gatewayTaskExecutor('', prompt, { temperature: 0.2 })
  const match = output.match(/\[[\s\S]*\]/)
  if (!match) throw new Error(`拆解结果不是 JSON 数组：${output.slice(0, 120)}`)
  let arr: unknown
  try {
    arr = JSON.parse(match[0])
  } catch {
    throw new Error(`拆解结果 JSON 解析失败：${match[0].slice(0, 120)}`)
  }
  if (!Array.isArray(arr) || arr.length === 0 || arr.some((x) => typeof x !== 'string'))
    throw new Error('拆解结果格式不符合预期')
  return (arr as string[]).slice(0, 8)
}

export async function gwTestModel(
  id: string
): Promise<{ ok: boolean; error?: string; latencyMs: number }> {
  const cfg = getStore().get()
  const m = cfg.models.find((x) => x.id === id)
  if (!m) return { ok: false, error: '模型不存在', latencyMs: 0 }
  const started = Date.now()
  try {
    const pingMessages = [{ role: 'user', content: 'ping，请只回复 pong' }]
    const output = await callUpstreamText(m, pingMessages, { maxTokens: 16 })
    return { ok: output.length > 0, latencyMs: Date.now() - started }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - started
    }
  }
}

/** app ready 后调用：autoStart 开启时自动拉起网关（失败不影响主流程） */
export async function initGateway(): Promise<void> {
  try {
    const cfg = getStore().get()
    if (cfg.autoStart) await gwStart()
  } catch (err) {
    logs = [
      {
        id: 0,
        at: new Date().toISOString(),
        modelId: '',
        modelName: '',
        tier: 'standard' as const,
        complexity: 0,
        signals: [] as string[],
        chars: 0,
        latencyMs: 0,
        status: 'error' as const,
        error: `自动启动失败：${err instanceof Error ? err.message : String(err)}`
      },
      ...logs
    ].slice(0, LOG_LIMIT)
  }
}
