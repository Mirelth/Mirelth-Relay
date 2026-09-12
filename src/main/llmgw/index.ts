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
import { GatewayServer, openAiChatUrl, anthropicMessagesUrl } from './server'
import { simulate } from './router'

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

export async function gwTestModel(
  id: string
): Promise<{ ok: boolean; error?: string; latencyMs: number }> {
  const cfg = getStore().get()
  const m = cfg.models.find((x) => x.id === id)
  if (!m) return { ok: false, error: '模型不存在', latencyMs: 0 }
  const started = Date.now()
  try {
    const pingMessages = [{ role: 'user', content: 'ping，请只回复 pong' }]
    const res =
      m.kind === 'anthropic'
        ? await fetch(anthropicMessagesUrl(m.baseURL), {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-api-key': m.apiKey,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
              model: m.model,
              messages: pingMessages,
              max_tokens: 16
            }),
            signal: AbortSignal.timeout(30000)
          })
        : await fetch(openAiChatUrl(m.baseURL), {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${m.apiKey}` },
            body: JSON.stringify({
              model: m.model,
              messages: pingMessages,
              max_tokens: 16,
              stream: false
            }),
            signal: AbortSignal.timeout(30000)
          })
    if (!res.ok) {
      const body = await res.text()
      return {
        ok: false,
        error: `HTTP ${res.status} ${body.slice(0, 200)}`,
        latencyMs: Date.now() - started
      }
    }
    return { ok: true, latencyMs: Date.now() - started }
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
