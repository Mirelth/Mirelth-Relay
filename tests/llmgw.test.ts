import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as http from 'http'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { assessComplexity, lengthScore, pickModel } from '../src/main/llmgw/router'
import { GwStore, generateGatewayKey, maskKey } from '../src/main/llmgw/store'
import { GatewayServer } from '../src/main/llmgw/server'
import type { GwModelConfig } from '../src/shared/types'

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'llmgw-'))
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const model = (over: Partial<GwModelConfig>): GwModelConfig => ({
  id: over.id ?? 'm-' + Math.random().toString(36).slice(2, 8),
  name: '测试模型',
  kind: 'openai-compatible',
  baseURL: 'http://127.0.0.1:1',
  apiKey: 'k',
  model: 'test-model',
  tier: 'standard',
  enabled: true,
  updatedAt: '',
  ...over
})

describe('assessComplexity 复杂度评估', () => {
  it('短问候 → light，无信号', () => {
    const r = assessComplexity([{ role: 'user', content: '你好' }])
    expect(r.tier).toBe('light')
    expect(r.score).toBeLessThan(25)
    expect(r.signals).toHaveLength(0)
  })
  it('输入规模分段累进并在 80k 封顶', () => {
    expect(lengthScore(0)).toBe(0)
    expect(lengthScore(1000)).toBeGreaterThan(lengthScore(100))
    expect(lengthScore(20000)).toBeGreaterThan(lengthScore(3000))
    expect(lengthScore(200000)).toBe(30)
  })
  it('推理关键词大幅加分 → heavy', () => {
    const r = assessComplexity([
      {
        role: 'user',
        content: '请逐步分析并证明：任意大于 2 的偶数都能写成两个素数之和，并给出推导过程'
      }
    ])
    expect(r.signals).toContain('推理关键词')
    expect(r.tier).toBe('heavy')
  })
  it('代码 + 结构化输出组合加分', () => {
    const r = assessComplexity([
      { role: 'user', content: '实现一个函数解析这段代码，以 JSON schema 格式输出结果' }
    ])
    expect(r.signals).toEqual(expect.arrayContaining(['代码任务', '结构化输出']))
  })
  it('多轮长对话 + 长产出加分', () => {
    const filler = '这一轮我们继续深入讨论架构设计的取舍。'.repeat(10)
    const msgs = Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: `第 ${i} 轮：${filler}`
    }))
    const r = assessComplexity(msgs, 10000)
    expect(r.signals).toContain('多轮对话 8 条')
    expect(r.signals).toContain('长产出 max_tokens=10000')
    expect(r.tier).toBe('standard')
  })
  it('数组形式 content 也能提取文本', () => {
    const r = assessComplexity([
      { role: 'user', content: [{ type: 'text', text: '证明哥德巴赫猜想并推导' }] }
    ])
    expect(r.signals).toContain('推理关键词')
  })
})

describe('pickModel 路由', () => {
  it('同档精确命中；同档多个时轮换避开上一个', () => {
    const a = model({ name: 'A', tier: 'standard' })
    const b = model({ name: 'B', tier: 'standard' })
    const r1 = pickModel([a, b], 'standard')
    expect(r1.chosen?.via).toBe('exact')
    const first = r1.chosen!.model.id
    const r2 = pickModel([a, b], 'standard', first)
    expect(r2.chosen!.model.id).not.toBe(first)
  })
  it('无同档：升档优先于降档', () => {
    const light = model({ name: 'L', tier: 'light' })
    const heavy = model({ name: 'H', tier: 'heavy' })
    expect(pickModel([light, heavy], 'standard').chosen?.via).toBe('up')
    // 只有更低档可用时只能降档
    expect(pickModel([light], 'heavy').chosen?.via).toBe('down')
    expect(pickModel([light], 'standard').chosen?.via).toBe('down')
  })
  it('升档选最接近的更强档', () => {
    const standard = model({ tier: 'standard' })
    const heavy = model({ tier: 'heavy' })
    expect(pickModel([standard, heavy], 'light').chosen?.model.tier).toBe('standard')
  })
  it('无可用模型返回 null', () => {
    expect(pickModel([], 'light').chosen).toBeUndefined()
  })
})

describe('GwStore 配置存储', () => {
  it('首次初始化自动生成名称与 atgw- 密钥，文件权限 600', () => {
    const file = join(tmp(), 'llm-gateway.json')
    const s = new GwStore(file)
    const cfg = s.get()
    expect(cfg.name).toMatch(/^塔台网关-[0-9a-f]{4}$/)
    expect(cfg.key).toMatch(/^atgw-[A-Za-z0-9_-]{32}$/)
    const st = statSync(file)
    expect(st.mode & 0o777).toBe(0o600)
  })
  it('update 持久化；空 apiKey 沿用旧值；新模型拿到生成的 id', () => {
    const file = join(tmp(), 'llm-gateway.json')
    const s = new GwStore(file)
    s.update({ models: [model({ id: 'm1', apiKey: 'secret-1' })] })
    s.update({ models: [model({ id: 'm1', apiKey: '' }), model({ id: '', name: '新模型' })] })
    const cfg = s.get()
    expect(cfg.models[0].apiKey).toBe('secret-1')
    expect(cfg.models[1].id).toMatch(/^gm-[0-9a-f]{12}$/)
  })
  it('regenerateKey 换新 key；掩码不泄露完整值', () => {
    const s = new GwStore(join(tmp(), 'llm-gateway.json'))
    const k1 = s.get().key
    const k2 = s.regenerateKey().key
    expect(k2).not.toBe(k1)
    expect(maskKey(k2)).not.toContain(k2.slice(9, -4))
    expect(generateGatewayKey()).toMatch(/^atgw-/)
  })
  it('配置文件被手改坏（key 非 atgw-/port 非法）时修正并落盘，后续读取稳定', async () => {
    const file = join(tmp(), 'llm-gateway.json')
    const s = new GwStore(file)
    s.get() // 首次初始化并写入
    const broken = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    broken.key = 'not-a-gateway-key'
    broken.port = 0
    writeFileSync(file, JSON.stringify(broken))

    const first = s.get()
    expect(first.key).toMatch(/^atgw-/)
    expect(first.port).toBeGreaterThan(0)
    // 第二次读取必须拿到同一个 key（网关每请求重读配置，key 不稳定 = 全部 401）
    const second = s.get()
    expect(second.key).toBe(first.key)
    expect(second.port).toBe(first.port)
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { key: string }
    expect(onDisk.key).toBe(first.key)
  })
})

describe('GatewayServer 端到端', () => {
  let upstream: http.Server
  let upstreamKind = 'openai'
  const upstreamHits: { path: string; auth: string; body: Record<string, unknown> }[] = []

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        upstreamHits.push({
          path: req.url || '',
          auth: String(req.headers['x-api-key'] ?? req.headers['authorization'] ?? ''),
          body: JSON.parse(body || '{}')
        })
        if (upstreamKind === 'anthropic') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              id: 'msg_1',
              model: 'claude-x',
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: 'pong-anthropic' }],
              usage: { input_tokens: 9, output_tokens: 3 }
            })
          )
        } else {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              id: 'cmpl-1',
              object: 'chat.completion',
              model: 'test-model',
              choices: [
                { index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }
              ],
              usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 }
            })
          )
        }
      })
    })
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
  })
  afterAll(async () => {
    await new Promise<void>((r) => upstream.close(() => r()))
  })

  const addr = (): number => (upstream.address() as { port: number }).port

  it('OpenAI 兼容端到端：鉴权 → 复杂度路由 → 转发 → 返回', async () => {
    const key = generateGatewayKey()
    const m = model({
      apiKey: 'up-key',
      model: 'test-model',
      baseURL: `http://127.0.0.1:${addr()}`
    })
    const gwLogs: unknown[] = []
    const srv = new GatewayServer(
      () => ({ name: 'g', port: 0, key, autoStart: false, models: [m] }),
      (e) => gwLogs.push(e)
    )
    const { port } = await srv.start()

    const bad = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    })
    expect(bad.status).toBe(401)

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }], max_tokens: 100 })
    })
    expect(res.status).toBe(200)
    const out = (await res.json()) as { choices: { message: { content: string } }[] }
    expect(out.choices[0].message.content).toBe('pong')
    expect(upstreamHits[0].auth).toBe('Bearer up-key')
    expect((upstreamHits[0].body as { model: string }).model).toBe('test-model')
    expect(gwLogs.length).toBe(1)

    await srv.stop()
  })

  it('复杂任务路由到 heavy 档模型', async () => {
    const key = generateGatewayKey()
    const light = model({ name: 'L', tier: 'light', baseURL: `http://127.0.0.1:${addr()}` })
    const heavy = model({ name: 'H', tier: 'heavy', baseURL: `http://127.0.0.1:${addr()}` })
    const srv = new GatewayServer(
      () => ({ name: 'g', port: 0, key, autoStart: false, models: [light, heavy] }),
      () => {}
    )
    const { port } = await srv.start()
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        messages: [{ role: 'user', content: '请逐步分析、推导并证明这个定理，写出完整过程' }]
      })
    })
    expect(res.status).toBe(200)
    expect(upstreamHits.at(-1)!.body.model).toBe(heavy.model)
    await srv.stop()
  })

  it('anthropic 上游：请求转 Messages 格式、响应转回 OpenAI 格式', async () => {
    upstreamKind = 'anthropic'
    const key = generateGatewayKey()
    const m = model({ kind: 'anthropic', model: 'claude-x', baseURL: `http://127.0.0.1:${addr()}` })
    const srv = new GatewayServer(
      () => ({ name: 'g', port: 0, key, autoStart: false, models: [m] }),
      () => {}
    )
    const { port } = await srv.start()
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: '你是助手' },
          { role: 'user', content: 'hi' }
        ],
        max_tokens: 100
      })
    })
    expect(res.status).toBe(200)
    const hit = upstreamHits.at(-1)!
    expect(hit.path).toBe('/v1/messages')
    expect((hit.body as { system?: string }).system).toBe('你是助手')
    expect(hit.auth).not.toBe(`Bearer ${key}`)
    const out = (await res.json()) as {
      choices: { message: { content: string }; finish_reason: string }[]
      usage: Record<string, number>
    }
    expect(out.choices[0].message.content).toBe('pong-anthropic')
    expect(out.choices[0].finish_reason).toBe('stop')
    expect(out.usage.prompt_tokens).toBe(9)
    expect(out.usage.total_tokens).toBe(12)
    await srv.stop()
    upstreamKind = 'openai'
  })

  it('stream:true 返回 SSE（role/content/stop + [DONE]）', async () => {
    const key = generateGatewayKey()
    const m = model({ baseURL: `http://127.0.0.1:${addr()}` })
    const srv = new GatewayServer(
      () => ({ name: 'g', port: 0, key, autoStart: false, models: [m] }),
      () => {}
    )
    const { port } = await srv.start()
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: true })
    })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = await res.text()
    expect(text).toContain('"chat.completion.chunk"')
    expect(text).toContain('"finish_reason":"stop"')
    expect(text.trim().endsWith('data: [DONE]')).toBe(true)
    await srv.stop()
  })

  it('透传 stop/top_p/n/response_format/tools/tool_choice；只传 max_completion_tokens 时按原名转发', async () => {
    const key = generateGatewayKey()
    const m = model({ baseURL: `http://127.0.0.1:${addr()}` })
    const srv = new GatewayServer(
      () => ({ name: 'g', port: 0, key, autoStart: false, models: [m] }),
      () => {}
    )
    const { port } = await srv.start()
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }],
        max_completion_tokens: 500,
        stop: ['END'],
        top_p: 0.9,
        n: 2,
        response_format: { type: 'json_object' },
        tools: [{ type: 'function', function: { name: 'f', parameters: {} } }],
        tool_choice: 'auto'
      })
    })
    expect(res.status).toBe(200)
    const hit = upstreamHits.at(-1)!.body as Record<string, unknown>
    expect(hit.stop).toEqual(['END'])
    expect(hit.top_p).toBe(0.9)
    expect(hit.n).toBe(2)
    expect(hit.response_format).toEqual({ type: 'json_object' })
    expect(hit.tool_choice).toBe('auto')
    expect(hit.max_completion_tokens).toBe(500)
    expect(hit.max_tokens).toBeUndefined()
    expect(Array.isArray(hit.tools)).toBe(true)
    await srv.stop()
  })

  it('anthropic 上游收到 tools 时返回 400 明确报错而不是静默丢弃', async () => {
    upstreamKind = 'anthropic'
    const key = generateGatewayKey()
    const m = model({ kind: 'anthropic', baseURL: `http://127.0.0.1:${addr()}` })
    const srv = new GatewayServer(
      () => ({ name: 'g', port: 0, key, autoStart: false, models: [m] }),
      () => {}
    )
    const { port } = await srv.start()
    const hitsBefore = upstreamHits.length
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'f', parameters: {} } }]
      })
    })
    expect(res.status).toBe(400)
    const err = (await res.json()) as { error: { message: string } }
    expect(err.error.message).toContain('Anthropic')
    expect(upstreamHits.length).toBe(hitsBefore) // 没打到上游
    upstreamKind = 'openai'
  })

  it('max_completion_tokens 参与复杂度评估（触发长产出信号）', async () => {
    const key = generateGatewayKey()
    const m = model({ baseURL: `http://127.0.0.1:${addr()}` })
    const logs: { signals: string[] }[] = []
    const srv = new GatewayServer(
      () => ({ name: 'g', port: 0, key, autoStart: false, models: [m] }),
      (e) => logs.push({ signals: e.signals })
    )
    const { port } = await srv.start()
    await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }],
        max_completion_tokens: 10000
      })
    })
    expect(logs[0].signals).toContain('长产出 max_tokens=10000')
    await srv.stop()
  })

  it('端口被占自动顺延；GET /v1/models 列出已启用模型', async () => {
    const key = generateGatewayKey()
    const blocker = http.createServer()
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r))
    const takenPort = (blocker.address() as { port: number }).port

    const m = model({ enabled: true, baseURL: `http://127.0.0.1:${addr()}` })
    const off = model({ enabled: false, baseURL: `http://127.0.0.1:${addr()}` })
    const srv = new GatewayServer(
      () => ({ name: 'g', port: takenPort, key, autoStart: false, models: [m, off] }),
      () => {}
    )
    const { port } = await srv.start()
    expect(port).toBeGreaterThan(takenPort)
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { authorization: `Bearer ${key}` }
    })
    const out = (await res.json()) as { data: { id: string }[] }
    expect(out.data.map((x) => x.id)).toEqual([m.model])
    await srv.stop()
    await new Promise<void>((r) => blocker.close(() => r()))
  })
})
