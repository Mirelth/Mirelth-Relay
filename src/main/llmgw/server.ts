import * as http from 'http'
import * as crypto from 'crypto'
import type { GwModelConfig, GwGatewayConfig, GwRequestLogEntry } from '@shared/types'
import { assessComplexity, pickModel } from './router'

/**
 * 聚合网关本地 HTTP 服务：对外暴露 OpenAI 兼容接口，
 * 按复杂度路由到配置的模型。只绑定 127.0.0.1，不落任何请求内容。
 *
 * - 鉴权：Authorization: Bearer <key> 或 x-api-key: <key>（常量时间比较）
 * - GET  /v1/models            → 已启用模型列表
 * - POST /v1/chat/completions  → 评估复杂度 → 选档 → 调上游 → 返回 OpenAI 格式
 *   （anthropic 上游自动做请求/响应格式转换；stream:true 用单块 SSE 模拟）
 */

const UPSTREAM_TIMEOUT_MS = 120_000
const MAX_BODY_BYTES = 32 * 1024 * 1024

interface IncomingChatRequest {
  model?: string
  messages?: { role: string; content: unknown }[]
  max_tokens?: number
  /** 新版 OpenAI 参数，与 max_tokens 等价 */
  max_completion_tokens?: number
  temperature?: number
  stream?: boolean
  /** 以下参数对 openai-compatible 上游原样透传 */
  stop?: unknown
  top_p?: number
  n?: number
  response_format?: unknown
  tools?: unknown
  tool_choice?: unknown
}

/** anthropic 上游暂不支持、需要明确拒绝的透传参数 */
const ANTHROPIC_UNSUPPORTED_KEYS = ['tools', 'tool_choice', 'response_format'] as const

export function openAiChatUrl(baseURL: string): string {
  const base = baseURL.replace(/\/+$/, '')
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`
}

export function anthropicMessagesUrl(baseURL: string): string {
  const base = baseURL.replace(/\/+$/, '')
  return base.endsWith('/v1/messages') ? base : `${base}/v1/messages`
}

// ---------- 共享上游调用（HTTP 服务与任务执行器共用） ----------

async function postOpenAI(
  target: GwModelConfig,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const res = await fetch(openAiChatUrl(target.baseURL), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${target.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`)
  return JSON.parse(text) as Record<string, unknown>
}

async function postAnthropic(
  target: GwModelConfig,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const res = await fetch(anthropicMessagesUrl(target.baseURL), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': target.apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`)
  return JSON.parse(text) as Record<string, unknown>
}

/** 任务执行器用的精简调用：发一段对话，拿回文本输出 */
export async function callUpstreamText(
  target: GwModelConfig,
  messages: { role: string; content: unknown }[],
  opts: { maxTokens?: number; temperature?: number } = {}
): Promise<string> {
  if (target.kind === 'anthropic') {
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .filter(Boolean)
      .join('\n')
    const raw = await postAnthropic(target, {
      model: target.model,
      max_tokens: opts.maxTokens && opts.maxTokens > 0 ? opts.maxTokens : 4096,
      ...(system ? { system } : {}),
      ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
      messages: messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, content: m.content }))
    })
    const content = Array.isArray(raw.content) ? raw.content : []
    return content
      .map((c) =>
        typeof c === 'object' && c !== null && 'text' in c
          ? String((c as { text: unknown }).text)
          : ''
      )
      .join('')
  }
  const raw = await postOpenAI(target, {
    model: target.model,
    messages,
    ...(opts.maxTokens != null ? { max_tokens: opts.maxTokens } : {}),
    ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
    stream: false
  })
  const choice = (raw.choices as { message?: { content?: string } }[] | undefined)?.[0]
  return choice?.message?.content ?? ''
}

export class GatewayServer {
  private server: http.Server | null = null
  private _port = 0
  private lastUsedId: string | undefined
  private logSeq = 0

  constructor(
    private getConfig: () => GwGatewayConfig,
    private onLog: (entry: GwRequestLogEntry) => void
  ) {}

  get running(): boolean {
    return this.server != null
  }

  get port(): number {
    return this._port
  }

  get endpoint(): string {
    return this.running ? `http://127.0.0.1:${this._port}/v1` : ''
  }

  start(): Promise<{ port: number }> {
    if (this.server) return Promise.resolve({ port: this._port })
    const cfg = this.getConfig()
    const wanted = cfg.port > 0 ? cfg.port : 8790
    return new Promise((resolve, reject) => {
      let settled = false
      const tryListen = (port: number, attemptsLeft: number): void => {
        const srv = http.createServer((req, res) => void this.handle(req, res))
        srv.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
            // 配置端口被占：依次向后试探 10 个
            tryListen(port + 1, attemptsLeft - 1)
          } else if (!settled) {
            settled = true
            reject(err)
          }
        })
        srv.listen(port, '127.0.0.1', () => {
          if (!settled) {
            settled = true
            this.server = srv
            this._port = port
            resolve({ port })
          }
        })
      }
      tryListen(wanted, 10)
    })
  }

  async stop(): Promise<void> {
    const srv = this.server
    if (!srv) return
    this.server = null
    await new Promise<void>((r) => srv.close(() => r()))
  }

  private authorized(req: http.IncomingMessage, key: string): boolean {
    const header = req.headers['authorization']
    const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : ''
    const xkey =
      typeof req.headers['x-api-key'] === 'string' ? (req.headers['x-api-key'] as string) : ''
    const presented = bearer || xkey
    if (!presented || !key) return false
    const a = Buffer.from(presented)
    const b = Buffer.from(key)
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    const buf = Buffer.from(JSON.stringify(body))
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': buf.length
    })
    res.end(buf)
  }

  private async readBody(req: http.IncomingMessage): Promise<string> {
    return await new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', (c: Buffer) => {
        size += c.length
        if (size > MAX_BODY_BYTES) {
          reject(new Error('请求体过大'))
          req.destroy()
          return
        }
        chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  private log(e: Omit<GwRequestLogEntry, 'id' | 'at'>): void {
    this.onLog({ ...e, id: ++this.logSeq, at: new Date().toISOString() })
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // 允许浏览器端（如 Web 客户端、本应用页面）跨域调用
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader(
      'access-control-allow-headers',
      'authorization, x-api-key, content-type, anthropic-version'
    )
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
    const cfg = this.getConfig()
    if (!this.authorized(req, cfg.key)) {
      this.json(res, 401, { error: { message: '无效的 API Key', type: 'auth_error' } })
      return
    }
    const url = (req.url || '').split('?')[0]
    if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
      this.json(res, 200, {
        object: 'list',
        data: cfg.models
          .filter((m) => m.enabled)
          .map((m) => ({ id: m.model, object: 'model', owned_by: cfg.name }))
      })
      return
    }
    if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/chat/completions')) {
      await this.handleChat(req, res, cfg)
      return
    }
    this.json(res, 404, { error: { message: `未知路径 ${req.method} ${url}`, type: 'not_found' } })
  }

  private async handleChat(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    cfg: GwGatewayConfig
  ): Promise<void> {
    const started = Date.now()
    let body: IncomingChatRequest
    try {
      body = JSON.parse(await this.readBody(req)) as IncomingChatRequest
    } catch (err) {
      this.json(res, 400, {
        error: { message: `请求体不是合法 JSON：${String(err)}`, type: 'invalid_request' }
      })
      return
    }
    const messages = Array.isArray(body.messages) ? body.messages : []
    if (messages.length === 0) {
      this.json(res, 400, { error: { message: 'messages 不能为空', type: 'invalid_request' } })
      return
    }

    const effectiveMaxTokens = body.max_tokens ?? body.max_completion_tokens ?? 0
    const assess = assessComplexity(messages, effectiveMaxTokens)
    const enabled = cfg.models.filter((m) => m.enabled)
    const picked = pickModel(enabled, assess.tier, this.lastUsedId)
    if (!picked.chosen) {
      this.log({
        modelId: '',
        modelName: '',
        tier: assess.tier,
        complexity: assess.score,
        signals: assess.signals,
        chars: assess.chars,
        latencyMs: Date.now() - started,
        status: 'no-model',
        error: picked.reason
      })
      this.json(res, 503, { error: { message: picked.reason, type: 'no_model_available' } })
      return
    }
    const target = picked.chosen.model
    this.lastUsedId = target.id

    if (
      target.kind === 'anthropic' &&
      ANTHROPIC_UNSUPPORTED_KEYS.some((k) => (body as Record<string, unknown>)[k] != null)
    ) {
      this.json(res, 400, {
        error: {
          message:
            '该模型为 Anthropic 兼容上游，网关暂不支持透传 tools/tool_choice/response_format 参数；请改用 OpenAI 兼容上游或移除这些参数。',
          type: 'invalid_request'
        }
      })
      return
    }

    try {
      const out =
        target.kind === 'anthropic'
          ? await this.callAnthropic(target, body)
          : await this.callOpenAI(target, body)
      this.log({
        modelId: target.id,
        modelName: target.name,
        tier: assess.tier,
        complexity: assess.score,
        signals: assess.signals,
        chars: assess.chars,
        latencyMs: Date.now() - started,
        status: 'ok'
      })
      if (body.stream) this.sendSse(res, out, target.model)
      else this.json(res, 200, out)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.log({
        modelId: target.id,
        modelName: target.name,
        tier: assess.tier,
        complexity: assess.score,
        signals: assess.signals,
        chars: assess.chars,
        latencyMs: Date.now() - started,
        status: 'error',
        error: msg
      })
      this.json(res, 502, { error: { message: `上游调用失败：${msg}`, type: 'upstream_error' } })
    }
  }

  // ---------- 上游调用 ----------

  private toAnthropicBody(
    target: GwModelConfig,
    body: IncomingChatRequest
  ): Record<string, unknown> {
    const messages = body.messages ?? []
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .filter(Boolean)
      .join('\n')
    const mt = body.max_tokens ?? body.max_completion_tokens ?? 0
    return {
      model: target.model,
      max_tokens: mt > 0 ? mt : 4096,
      ...(system ? { system } : {}),
      ...(body.temperature != null ? { temperature: body.temperature } : {}),
      messages: messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, content: m.content }))
    }
  }

  private fromAnthropicResponse(
    raw: Record<string, unknown>,
    fallbackModel: string
  ): Record<string, unknown> {
    const content = Array.isArray(raw.content) ? raw.content : []
    const text = content
      .map((c) =>
        typeof c === 'object' && c !== null && 'text' in c
          ? String((c as { text: unknown }).text)
          : ''
      )
      .join('')
    const usage = (raw.usage ?? {}) as { input_tokens?: number; output_tokens?: number }
    const stop = raw.stop_reason === 'max_tokens' ? 'length' : 'stop'
    return {
      id: typeof raw.id === 'string' ? raw.id : 'chatcmpl-anthropic',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: typeof raw.model === 'string' ? raw.model : fallbackModel,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: stop }],
      usage: {
        prompt_tokens: usage.input_tokens ?? 0,
        completion_tokens: usage.output_tokens ?? 0,
        total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
      }
    }
  }

  private async callOpenAI(
    target: GwModelConfig,
    body: IncomingChatRequest
  ): Promise<Record<string, unknown>> {
    // 新版 OpenAI 参数：客户端只传了 max_completion_tokens 时沿用该字段名
    const useCompletion = body.max_tokens == null && body.max_completion_tokens != null
    return await postOpenAI(target, {
      model: target.model,
      messages: body.messages,
      ...(body.max_tokens != null ? { max_tokens: body.max_tokens } : {}),
      ...(useCompletion ? { max_completion_tokens: body.max_completion_tokens } : {}),
      ...(body.temperature != null ? { temperature: body.temperature } : {}),
      // 无副作用的采样/输出控制参数原样透传
      ...(body.stop != null ? { stop: body.stop } : {}),
      ...(body.top_p != null ? { top_p: body.top_p } : {}),
      ...(body.n != null ? { n: body.n } : {}),
      ...(body.response_format != null ? { response_format: body.response_format } : {}),
      ...(body.tools != null ? { tools: body.tools } : {}),
      ...(body.tool_choice != null ? { tool_choice: body.tool_choice } : {}),
      stream: false
    })
  }

  private async callAnthropic(
    target: GwModelConfig,
    body: IncomingChatRequest
  ): Promise<Record<string, unknown>> {
    const raw = await postAnthropic(target, this.toAnthropicBody(target, body))
    return this.fromAnthropicResponse(raw, target.model)
  }

  /** stream:true 的单块 SSE 模拟：role → content → finish → [DONE] */
  private sendSse(res: http.ServerResponse, out: Record<string, unknown>, model: string): void {
    const choice = (out.choices as { message?: { content?: string } }[] | undefined)?.[0]
    const content = choice?.message?.content ?? ''
    const usage = out.usage as Record<string, number> | undefined
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    const chunk = (delta: Record<string, unknown>, finish?: string): string =>
      `data: ${JSON.stringify({
        id: out.id,
        object: 'chat.completion.chunk',
        created: out.created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish ?? null }],
        ...(usage && finish ? { usage } : {})
      })}\n\n`
    res.write(chunk({ role: 'assistant' }))
    res.write(chunk({ content }))
    res.write(chunk({}, 'stop'))
    res.write('data: [DONE]\n\n')
    res.end()
  }
}
