import { describe, expect, it } from 'vitest'
import { aggregateCost, matchPrice, rowCostCny, DEFAULT_RATE_USD_CNY } from '../src/main/pricing'
import type { PriceConfig } from '../src/shared/types'

const cfg: PriceConfig = {
  rateUsdCny: 7,
  prices: [
    { model: 'deepseek-chat', currency: 'CNY', inputPerM: 4, outputPerM: 8, cacheReadPerM: 1 },
    { model: 'deepseek', currency: 'CNY', inputPerM: 2, outputPerM: 4 },
    { model: 'claude-sonnet', currency: 'USD', inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 },
    { model: 'claude', currency: 'USD', inputPerM: 3, outputPerM: 15 },
    { model: 'qwen3', currency: 'CNY', inputPerM: 2, outputPerM: 8 }
  ]
}

const row = (over: Partial<Parameters<typeof rowCostCny>[0]> = {}): Parameters<typeof rowCostCny>[0] => ({
  model: 'deepseek-chat',
  input: 1_000_000,
  output: 1_000_000,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  total: 2_000_000,
  reportedUsd: 0,
  ...over
})

describe('matchPrice', () => {
  it('最长匹配键优先', () => {
    expect(matchPrice('deepseek-chat', cfg.prices)?.inputPerM).toBe(4)
    expect(matchPrice('deepseek-v3-tmp', cfg.prices)?.inputPerM).toBe(2)
  })
  it('子串匹配且大小写不敏感', () => {
    expect(matchPrice('DeepSeek-Chat-latest', cfg.prices)?.currency).toBe('CNY')
    expect(matchPrice('claude-3-5-sonnet-20241022', cfg.prices)?.model).toBe('claude')
    expect(matchPrice('claude-sonnet-4-5', cfg.prices)?.model).toBe('claude-sonnet')
  })
  it('无匹配返回 null', () => {
    expect(matchPrice('totally-unknown-xyz', cfg.prices)).toBeNull()
  })
})

describe('rowCostCny', () => {
  it('人民币估算：1M 输入 + 1M 输出', () => {
    expect(rowCostCny(row(), cfg)).toBeCloseTo(4 + 8, 6)
  })
  it('美元定价按汇率折算', () => {
    const r = row({ model: 'claude-sonnet-4-5', input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, total: 4_000_000 })
    // (3 + 15 + 0.3 + 3.75) USD → ×7
    expect(rowCostCny(r, cfg)).toBeCloseTo((3 + 15 + 0.3 + 3.75) * 7, 6)
  })
  it('缓存价留空按输入价 10% / 125% 兜底，推理按输出计价', () => {
    const r = row({ model: 'qwen3-coder', input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 1_000_000, reasoning: 500_000, total: 2_500_000 })
    // 输入价 2（qwen3 键）：cr=0.2 + cw=2.5 + reasoning 输出价 8×0.5=4
    expect(rowCostCny(r, cfg)).toBeCloseTo(0.2 + 2.5 + 4, 6)
  })
  it('上报真实成本优先于单价估算', () => {
    const r = row({ reportedUsd: 1.5 })
    expect(rowCostCny(r, cfg)).toBeCloseTo(1.5 * 7, 6)
  })
  it('未定价模型成本为 0', () => {
    expect(rowCostCny(row({ model: 'mystery-model-9' }), cfg)).toBe(0)
  })
})

describe('aggregateCost', () => {
  it('按 key 分摊并统计覆盖率', () => {
    const res = aggregateCost(
      [
        { key: '2026-08-01', ...row({ input: 1_000_000, output: 1_000_000 }) },
        { key: '2026-08-01', model: 'mystery-x', input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 2_000_000, reportedUsd: 0 },
        { key: '2026-08-02', ...row({ input: 1_000_000, output: 1_000_000 }) }
      ],
      cfg
    )
    expect(res.byKey.get('2026-08-01')).toBeCloseTo(12, 6)
    expect(res.byKey.get('2026-08-02')).toBeCloseTo(12, 6)
    expect(res.unpricedModels).toEqual(['mystery-x'])
    expect(res.totalTokens).toBe(6_000_000)
    expect(res.pricedTokens).toBe(4_000_000)
    expect(res.totalCostCny).toBeCloseTo(24, 6)
  })
})

describe('默认汇率', () => {
  it('内置汇率为正数（人民币口径）', () => {
    expect(DEFAULT_RATE_USD_CNY).toBeGreaterThan(1)
    expect(DEFAULT_RATE_USD_CNY).toBeLessThan(20)
  })
})
