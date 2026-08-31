import { describe, expect, it } from 'vitest'
import { detectSecrets, maskSecret } from '../src/main/security'

describe('detectSecrets', () => {
  it('识别 OpenAI 风格与 Anthropic 密钥', () => {
    const hits = detectSecrets('export KEY="sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx"')
    expect(hits.length).toBe(1)
    expect(hits[0].kind).toBe('Anthropic 密钥')
    expect(hits[0].line).toBe(1)
  })
  it('识别 GitHub / AWS / 阿里云 token', () => {
    expect(detectSecrets('token: ghp_AbCdEfGhIjKlMnOpQrStUvWxYz12').length).toBe(1)
    expect(detectSecrets('aws_access_key_id = AKIAIOSFODNN7EXAMPLE').length).toBe(1)
    expect(detectSecrets('id LTAIabcdEFGH1234ijkl').length).toBe(1)
  })
  it('key=value 形式且值像真实密钥时命中', () => {
    const hits = detectSecrets('api_key = "Ab3d5e7f9g1h3j5k7m9o"')
    expect(hits).toHaveLength(1)
    expect(hits[0].kind).toContain('api_key')
  })
  it('占位符 / 环境变量引用不误报', () => {
    expect(detectSecrets('api_key = "your_api_key_here_12345678"')).toHaveLength(0)
    expect(detectSecrets('api_key: "xxxxxx1234567890xxxxxx"')).toHaveLength(0)
    expect(detectSecrets('token = "TOKENVALUEWITHOUTDIGITS"')).toHaveLength(0)
    expect(detectSecrets('password = "••••••••"')).toHaveLength(0)
  })
  it('输出永不包含完整密钥', () => {
    const secret = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx'
    const hits = detectSecrets(`KEY="${secret}"`)
    for (const h of hits) expect(h.masked).not.toContain(secret)
    expect(hits[0].masked).toContain('……')
  })
  it('跨行逐行定位', () => {
    const hits = detectSecrets('nothing here\napi_key = "Ab3d5e7f9g1h3j5k7m9o"\nagain nothing\nid ghp_AbCdEfGhIjKlMnOpQrStUvWxYz12')
    expect(hits.map((h) => h.line)).toEqual([2, 4])
  })
})

describe('maskSecret', () => {
  it('短值全遮', () => {
    expect(maskSecret('abc')).toBe('••••••••')
  })
  it('长值保留首尾各 4 位', () => {
    expect(maskSecret('Ab3d5e7f9g1h3j5k7m9o')).toBe('Ab3d……7m9o')
  })
})
