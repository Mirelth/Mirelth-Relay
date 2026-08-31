import * as fs from 'fs'
import { join } from 'path'
import type { ModelPrice, PriceConfig } from '@shared/types'

/**
 * 模型单价表：估算 Token 消耗成本。
 * 优先采用智能体上报的真实成本（USD，按汇率折人民币），
 * 否则按本表估算（每百万 token 单价，支持 CNY/USD 两种计价）。
 * 内置价格为各厂商公开标价的近似参考值，可在界面上随时修改。
 */

export const DEFAULT_RATE_USD_CNY = 7.2

export const DEFAULT_PRICES: ModelPrice[] = [
  // —— 人民币计价（每百万 token）——
  { model: 'deepseek-chat', currency: 'CNY', inputPerM: 4, outputPerM: 8, cacheReadPerM: 1 },
  { model: 'deepseek-reasoner', currency: 'CNY', inputPerM: 4, outputPerM: 16, cacheReadPerM: 1 },
  { model: 'deepseek-v3', currency: 'CNY', inputPerM: 4, outputPerM: 8, cacheReadPerM: 1 },
  { model: 'deepseek-r1', currency: 'CNY', inputPerM: 4, outputPerM: 16, cacheReadPerM: 1 },
  { model: 'deepseek', currency: 'CNY', inputPerM: 4, outputPerM: 8, cacheReadPerM: 1 },
  { model: 'glm-4.5-air', currency: 'CNY', inputPerM: 0.8, outputPerM: 4.5 },
  { model: 'glm-4.6', currency: 'CNY', inputPerM: 4, outputPerM: 14 },
  { model: 'glm-4.5', currency: 'CNY', inputPerM: 2, outputPerM: 8 },
  { model: 'glm-4', currency: 'CNY', inputPerM: 1, outputPerM: 1 },
  { model: 'glm', currency: 'CNY', inputPerM: 4, outputPerM: 14 },
  { model: 'qwen3-coder', currency: 'CNY', inputPerM: 4, outputPerM: 16 },
  { model: 'qwen3', currency: 'CNY', inputPerM: 2, outputPerM: 8 },
  { model: 'qwen', currency: 'CNY', inputPerM: 2, outputPerM: 8 },
  { model: 'kimi-k2', currency: 'CNY', inputPerM: 4, outputPerM: 16, cacheReadPerM: 1 },
  { model: 'kimi', currency: 'CNY', inputPerM: 4, outputPerM: 16, cacheReadPerM: 1 },
  { model: 'moonshot', currency: 'CNY', inputPerM: 12, outputPerM: 12 },
  { model: 'minimax', currency: 'CNY', inputPerM: 2.1, outputPerM: 8.4 },
  { model: 'doubao', currency: 'CNY', inputPerM: 0.8, outputPerM: 2 },
  // —— 美元计价（每百万 token，按汇率折人民币）——
  {
    model: 'claude-opus',
    currency: 'USD',
    inputPerM: 15,
    outputPerM: 75,
    cacheReadPerM: 1.5,
    cacheWritePerM: 18.75
  },
  { model: 'claude-haiku', currency: 'USD', inputPerM: 0.8, outputPerM: 4 },
  {
    model: 'claude-sonnet',
    currency: 'USD',
    inputPerM: 3,
    outputPerM: 15,
    cacheReadPerM: 0.3,
    cacheWritePerM: 3.75
  },
  { model: 'claude', currency: 'USD', inputPerM: 3, outputPerM: 15 },
  { model: 'sonnet', currency: 'USD', inputPerM: 3, outputPerM: 15 },
  { model: 'opus', currency: 'USD', inputPerM: 15, outputPerM: 75 },
  { model: 'haiku', currency: 'USD', inputPerM: 0.8, outputPerM: 4 },
  { model: 'gpt', currency: 'USD', inputPerM: 2.5, outputPerM: 10 },
  { model: 'chatgpt', currency: 'USD', inputPerM: 2.5, outputPerM: 10 },
  { model: 'gemini-2.5-pro', currency: 'USD', inputPerM: 1.25, outputPerM: 10 },
  { model: 'gemini-flash', currency: 'USD', inputPerM: 0.3, outputPerM: 2.5 },
  { model: 'gemini', currency: 'USD', inputPerM: 1.25, outputPerM: 10 },
  { model: 'grok', currency: 'USD', inputPerM: 3, outputPerM: 15 }
]

/** 子串匹配，键越长（越具体）优先级越高 */
export function matchPrice(model: string, prices: ModelPrice[]): ModelPrice | null {
  const m = model.toLowerCase()
  let best: ModelPrice | null = null
  for (const p of prices) {
    const k = p.model.toLowerCase().trim()
    if (!k) continue
    if ((m === k || m.includes(k)) && (!best || k.length > best.model.toLowerCase().length))
      best = p
  }
  return best
}

export interface CostRow {
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  total: number
  /** 智能体上报的成本（USD），>0 时优先采用 */
  reportedUsd: number
}

/** 一行用量对应的成本（人民币）：真实上报优先，其次单价表估算，都没有则 0 */
export function rowCostCny(row: CostRow, cfg: PriceConfig): number {
  const rate = cfg.rateUsdCny > 0 ? cfg.rateUsdCny : DEFAULT_RATE_USD_CNY
  if (row.reportedUsd > 0) return row.reportedUsd * rate
  const p = matchPrice(row.model, cfg.prices)
  if (!p) return 0
  const cr = p.cacheReadPerM ?? p.inputPerM * 0.1
  const cw = p.cacheWritePerM ?? p.inputPerM * 1.25
  const native =
    (row.input * p.inputPerM +
      (row.output + row.reasoning) * p.outputPerM +
      row.cacheRead * cr +
      row.cacheWrite * cw) /
    1e6
  return p.currency === 'USD' ? native * rate : native
}

/** 按 group key 汇总行级成本，同时统计定价覆盖情况 */
export function aggregateCost(
  rows: ({ key: string } & CostRow)[],
  cfg: PriceConfig
): {
  byKey: Map<string, number>
  unpricedModels: string[]
  pricedTokens: number
  totalTokens: number
  totalCostCny: number
} {
  const byKey = new Map<string, number>()
  const unpriced = new Set<string>()
  let pricedTokens = 0
  let totalTokens = 0
  let total = 0
  for (const r of rows) {
    totalTokens += r.total
    const covered = r.reportedUsd > 0 || matchPrice(r.model, cfg.prices) != null
    if (covered) pricedTokens += r.total
    else unpriced.add(r.model)
    const c = rowCostCny(r, cfg)
    if (c > 0) byKey.set(r.key, (byKey.get(r.key) || 0) + c)
    total += c
  }
  return {
    byKey,
    unpricedModels: [...unpriced].sort(),
    pricedTokens,
    totalTokens,
    totalCostCny: total
  }
}

export class PricingStore {
  constructor(private filePath: string) {}

  config(): PriceConfig {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as PriceConfig
      if (Array.isArray(raw.prices))
        return {
          rateUsdCny: raw.rateUsdCny > 0 ? raw.rateUsdCny : DEFAULT_RATE_USD_CNY,
          prices: raw.prices
        }
    } catch {
      /* 首次使用走内置价 */
    }
    return { rateUsdCny: DEFAULT_RATE_USD_CNY, prices: DEFAULT_PRICES }
  }

  save(cfg: PriceConfig): void {
    fs.mkdirSync(join(this.filePath, '..'), { recursive: true })
    fs.writeFileSync(
      this.filePath,
      JSON.stringify(
        {
          rateUsdCny: cfg.rateUsdCny > 0 ? cfg.rateUsdCny : DEFAULT_RATE_USD_CNY,
          prices: cfg.prices || []
        },
        null,
        2
      ),
      { mode: 0o600 }
    )
  }
}
