import { describe, expect, it } from 'vitest'
import { zstdCompressSync } from 'zlib'
import { decompressZstdFrames } from '../src/main/lib/fs'
import { parseDshSessionLines } from '../src/main/scanner/agents/dsh'

describe('decompressZstdFrames', () => {
  it('多帧拼接（追加式日志每段一帧）逐帧解出', () => {
    const f1 = zstdCompressSync(Buffer.from('line1\n'))
    const f2 = zstdCompressSync(Buffer.from('line2\n'))
    expect(decompressZstdFrames(Buffer.concat([f1, f2]))).toBe('line1\nline2\n')
  })
  it('单帧兼容', () => {
    const one = zstdCompressSync(Buffer.from('only\n'))
    expect(decompressZstdFrames(one)).toBe('only\n')
  })
  it('非 zstd 数据返回空串不抛错', () => {
    expect(decompressZstdFrames(Buffer.from('plain text without magic'))).toBe('')
  })
})

/**
 * 桌面版 session.jsonl 解析测试。
 * 真实结构：session 头给 cwd，request/header 给 model，
 * assistant/chunk 且 chunk.type==='usage' 给逐请求 token 用量。
 */

const SAMPLE = [
  JSON.stringify({ type: 'session', id: 's1', cwd: '/Volumes/yangchen/ceshitest', createdAt: 1 }),
  JSON.stringify({ type: 'sandbox/mode', data: { mode: 'off' } }),
  JSON.stringify({ type: 'request/header', data: { header: { config: { model: 'stealth/ox-alpha' } } } }),
  JSON.stringify({
    type: 'assistant/chunk',
    time: 1787751458032,
    data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 6271, outputTokens: 172, cacheReadTokens: 2560 } } }
  }),
  JSON.stringify({ type: 'assistant/chunk', data: { chunk: { type: 'text', text: 'hi' } } }),
  'not-json-garbage-line',
  JSON.stringify({ type: 'request/header', data: { header: { config: { model: 'minimax-m3' } } } }),
  JSON.stringify({
    type: 'assistant/chunk',
    time: 1787751500000,
    data: { chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 5 } } }
  })
].join('\n')

describe('parseDshSessionLines', () => {
  it('从 session 头提取 cwd', () => {
    expect(parseDshSessionLines(SAMPLE).cwd).toBe('/Volumes/yangchen/ceshitest')
  })
  it('每个 usage chunk 产出一条记录，坏行跳过', () => {
    const { usage } = parseDshSessionLines(SAMPLE)
    expect(usage).toHaveLength(2)
  })
  it('按时间顺序用最近的 request/header 模型标注', () => {
    const { usage } = parseDshSessionLines(SAMPLE)
    expect(usage[0].model).toBe('stealth/ox-alpha')
    expect(usage[1].model).toBe('minimax-m3')
  })
  it('字段缺省补 0，ts 取行时间', () => {
    const { usage } = parseDshSessionLines(SAMPLE)
    expect(usage[1]).toMatchObject({
      ts: 1787751500000,
      inputTokens: 100,
      outputTokens: 5,
      cacheReadTokens: 0,
      requests: 1
    })
  })
  it('无 usage 行时返回空数组', () => {
    const { usage } = parseDshSessionLines(JSON.stringify({ type: 'session', cwd: '/x' }))
    expect(usage).toEqual([])
  })
})
