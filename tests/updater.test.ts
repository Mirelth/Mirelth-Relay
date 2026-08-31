import { describe, expect, it } from 'vitest'
import { isNewer } from '../src/main/updater'

describe('isNewer', () => {
  it('补丁/次版本/主版本升级判定', () => {
    expect(isNewer('1.0.0', '1.0.1')).toBe(true)
    expect(isNewer('1.0.9', '1.1.0')).toBe(true)
    expect(isNewer('1.9.0', '2.0.0')).toBe(true)
  })
  it('数字段按数值比较而非字符串', () => {
    expect(isNewer('1.9.0', '1.10.0')).toBe(true)
    expect(isNewer('1.10.0', '1.9.0')).toBe(false)
  })
  it('相等或回退不算新版本', () => {
    expect(isNewer('1.2.0', '1.2.0')).toBe(false)
    expect(isNewer('1.2.1', '1.2.0')).toBe(false)
  })
  it('段数不等时缺位补 0', () => {
    expect(isNewer('1.0', '1.0.1')).toBe(true)
    expect(isNewer('1.0.1', '1.0')).toBe(false)
  })
})
