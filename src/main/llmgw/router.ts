import type { GwModelConfig, GwModelTier, GwSimulationResult } from '@shared/types'

/**
 * 复杂度评估与路由策略（纯函数，便于单测）。
 *
 * 复杂度得分 0-100 = 输入规模(≤30) + 产出长度要求(≤10) + 推理难度信号(≤60)：
 * - 输入规模：全部消息总字符数，分段累进（>80k 字符打满 30）
 * - 产出要求：max_tokens 越大越高（>2048 +5，>8192 +10）
 * - 难度信号：推理关键词(+28，命中即判旗舰)、代码任务(+14)、结构化输出(+10)、
 *   多轮深对话(≥6 条 +8)、粘贴长文(单条 >10k 字符 +6)
 *
 * 档位映射：难度信号 ≥28 或 score ≥55 → heavy（旗舰）；score ≥25 → standard（标准）；否则 light。
 * 路由：优先选同档位已启用模型（轮换分摊）；无同档则先向上升档
 * （旗舰兜底简单任务），再向下降；全无可用 → null（网关回 503）。
 */

const TIER_ORDER: Record<GwModelTier, number> = { light: 0, standard: 1, heavy: 2 }

const REASONING_RE =
  /(推理|思考|证明|推导|数学|逻辑|算法复杂度|逐步分析|step[- ]by[- ]step|let'?s think|prove\b|derive\b|reason(ing)?\b)/i
const CODE_RE =
  /(```|代码|实现|函数|重构|调试|报错|异常|堆栈|编译|write (a |the )?(function|script|class|component)|refactor|debug|stack trace|compile)/i
const STRUCTURED_RE =
  /(json|schema|表格|csv|\bxml\b|结构化输出|字段提取|extract .*fields|as a table)/i

export interface GwIncomingMessage {
  role: string
  content: unknown
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .map((p) =>
        typeof p === 'object' && p !== null && 'text' in p
          ? String((p as { text: unknown }).text)
          : ''
      )
      .join('\n')
  return ''
}

/** 输入规模得分：分段累进，80k 字符打满 30 */
export function lengthScore(chars: number): number {
  if (chars <= 500) return chars <= 0 ? 0 : 4
  if (chars <= 2000) return 8
  if (chars <= 8000) return 14
  if (chars <= 20000) return 20
  if (chars <= 50000) return 25
  if (chars <= 80000) return 28
  return 30
}

export function maxTokensScore(maxTokens: number): number {
  if (maxTokens > 8192) return 10
  if (maxTokens > 2048) return 5
  return 0
}

export interface AssessResult {
  score: number
  tier: GwModelTier
  signals: string[]
  chars: number
}

export function assessComplexity(messages: GwIncomingMessage[], maxTokens = 0): AssessResult {
  const signals: string[] = []
  const texts = messages.map((m) => contentText(m.content))
  const chars = texts.reduce((n, t) => n + t.length, 0)

  const len = lengthScore(chars)
  if (chars > 8000) signals.push(`长输入 ${(chars / 1000).toFixed(1)}k 字符`)
  const out = maxTokensScore(maxTokens)
  if (out > 0) signals.push(`长产出 max_tokens=${maxTokens}`)

  let hard = 0
  if (texts.some((t) => REASONING_RE.test(t))) {
    hard += 28
    signals.push('推理关键词')
  }
  if (texts.some((t) => CODE_RE.test(t))) {
    hard += 14
    signals.push('代码任务')
  }
  if (texts.some((t) => STRUCTURED_RE.test(t))) {
    hard += 10
    signals.push('结构化输出')
  }
  if (messages.length >= 6) {
    hard += 8
    signals.push(`多轮对话 ${messages.length} 条`)
  }
  if (texts.some((t) => t.length > 10000)) {
    hard += 6
    signals.push('粘贴长文')
  }

  const score = Math.min(100, len + out + hard)
  // 难度信号 ≥28（如命中推理关键词）直接判旗舰：明确要求推理的任务不该交给轻量模型
  const tier: GwModelTier = hard >= 28 || score >= 55 ? 'heavy' : score >= 25 ? 'standard' : 'light'
  return { score, tier, signals, chars }
}

export interface PickResult {
  chosen?: PickResultChosen
  reason: string
}

export interface PickResultChosen {
  model: GwModelConfig
  /** 'exact' 同档轮换 | 'up' 升档兜底 | 'down' 降档兜底 */
  via: 'exact' | 'up' | 'down'
}

/**
 * 选模型。candidates 为已启用模型；avoid 用于同档轮换（上次用过的排后）。
 * 升档优先于降档：宁可浪费旗舰也不用轻量硬扛复杂任务。
 */
export function pickModel(
  candidates: GwModelConfig[],
  tier: GwModelTier,
  avoid?: string
): PickResult {
  if (candidates.length === 0) return { reason: '没有已启用的模型' }
  const want = TIER_ORDER[tier]
  const exact = candidates.filter((m) => TIER_ORDER[m.tier] === want)
  if (exact.length > 0) {
    const pool = exact.length > 1 ? exact.filter((m) => m.id !== avoid) : exact
    const chosen = pool[0] ?? exact[0]
    return {
      chosen: { model: chosen, via: 'exact' },
      reason: `复杂度 ${tier} 档，命中同档模型「${chosen.name}」`
    }
  }
  const up = candidates
    .filter((m) => TIER_ORDER[m.tier] > want)
    .sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier])
  if (up.length > 0) {
    const chosen = up[0]
    return {
      chosen: { model: chosen, via: 'up' },
      reason: `复杂度 ${tier} 档但无同档模型，升档由「${chosen.name}」兜底`
    }
  }
  const down = candidates
    .filter((m) => TIER_ORDER[m.tier] < want)
    .sort((a, b) => TIER_ORDER[b.tier] - TIER_ORDER[a.tier])
  if (down.length > 0) {
    const chosen = down[0]
    return {
      chosen: { model: chosen, via: 'down' },
      reason: `复杂度 ${tier} 档但仅有更低档模型，降档由「${chosen.name}」尽力处理`
    }
  }
  return { reason: '没有已启用的模型' }
}

/** 供模拟器使用：给定文本与 max_tokens 预演一次路由 */
export function simulate(
  models: GwModelConfig[],
  text: string,
  maxTokens: number,
  avoid?: string
): GwSimulationResult {
  const a = assessComplexity([{ role: 'user', content: text }], maxTokens)
  const enabled = models.filter((m) => m.enabled)
  const r = pickModel(enabled, a.tier, avoid)
  return {
    complexity: a.score,
    tier: a.tier,
    signals: a.signals,
    chars: a.chars,
    chosen: r.chosen
      ? {
          id: r.chosen.model.id,
          name: r.chosen.model.name,
          model: r.chosen.model.model,
          tier: r.chosen.model.tier
        }
      : undefined,
    reason: r.reason
  }
}
