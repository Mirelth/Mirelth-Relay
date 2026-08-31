import { describe, expect, it } from 'vitest'
import { computeInstallState } from '../src/main/scanner/types'

describe('computeInstallState', () => {
  it('无可验证本体位置 → unknown（即便有数据）', () => {
    expect(computeInstallState({ hasEvidence: false, programFound: false, dataFound: true })).toBe('unknown')
    expect(computeInstallState({ hasEvidence: false, programFound: false, dataFound: false })).toBe('unknown')
  })
  it('程序本体存在 → installed', () => {
    expect(computeInstallState({ hasEvidence: true, programFound: true, dataFound: true })).toBe('installed')
    expect(computeInstallState({ hasEvidence: true, programFound: true, dataFound: false })).toBe('installed')
  })
  it('有证据但本体缺失、仅剩数据 → residual', () => {
    expect(computeInstallState({ hasEvidence: true, programFound: false, dataFound: true })).toBe('residual')
  })
  it('有证据、无本体、也无数据 → unknown（不会误报残留）', () => {
    expect(computeInstallState({ hasEvidence: true, programFound: false, dataFound: false })).toBe('unknown')
  })
})
