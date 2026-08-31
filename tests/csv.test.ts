import { describe, expect, it } from 'vitest'
import { toCsv } from '../src/shared/csv'

describe('toCsv', () => {
  it('普通行列', () => {
    expect(toCsv(['a', 'b'], [[1, 'x']])).toBe('a,b\r\n1,x')
  })
  it('逗号/引号/换行转义', () => {
    expect(toCsv(['h'], [['a,b', 'c"d', 'e\nf']])).toBe('h\r\n"a,b","c""d","e\nf"')
  })
  it('空值输出为空串', () => {
    expect(toCsv(['a'], [[null, undefined]])).toBe('a\r\n,')
  })
})
