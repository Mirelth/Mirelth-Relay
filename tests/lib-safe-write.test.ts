import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConfigWriteError, commitWithVerify, loadForWrite, readJson } from '../src/main/lib/fs'

let home = ''
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'agentmgr-fs-'))
})
afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('loadForWrite：解析失败拒写', () => {
  it('文件不存在 → 返回空对象（允许新建）', () => {
    const p = join(home, 'missing.json')
    expect(loadForWrite(p, (x) => readJson(x))).toEqual({})
  })

  it('文件存在但无法解析 → 抛 ConfigWriteError，不返回空对象', () => {
    const p = join(home, 'broken.json')
    writeFileSync(p, '{ this is not json at all')
    expect(() => loadForWrite(p, (x) => readJson(x))).toThrow(ConfigWriteError)
    expect(() => loadForWrite(p, (x) => readJson(x))).toThrow(/已中止写入/)
    // 原内容原封不动
    expect(readFileSync(p, 'utf8')).toBe('{ this is not json at all')
  })

  it('文件存在且能解析但不是对象（数组/标量）→ 拒写', () => {
    const arr = join(home, 'array.json')
    writeFileSync(arr, '[1,2,3]')
    expect(() => loadForWrite(arr, (x) => readJson(x))).toThrow(ConfigWriteError)
    const scalar = join(home, 'scalar.json')
    writeFileSync(scalar, '"just a string"')
    expect(() => loadForWrite(scalar, (x) => readJson(x))).toThrow(/不是对象结构/)
  })
})

describe('commitWithVerify：备份→写入→校验→失败回滚', () => {
  it('成功路径：写入生效且留下带时间戳的备份', () => {
    const p = join(home, 'ok.json')
    writeFileSync(p, JSON.stringify({ keepMe: 1 }))
    const bak = commitWithVerify(
      p,
      () => writeFileSync(p, JSON.stringify({ keepMe: 1, added: 2 })),
      (x) => readJson(x)
    )
    expect(readFileSync(p, 'utf8')).toContain('added')
    expect(bak).toBeTruthy()
    expect(readFileSync(bak!, 'utf8')).toBe(JSON.stringify({ keepMe: 1 }))
  })

  it('写入产生坏文件 → 自动回滚为原内容', () => {
    const original = JSON.stringify({ untouched: true })
    const p = join(home, 'rollback.json')
    writeFileSync(p, original)
    expect(() =>
      commitWithVerify(
        p,
        () => writeFileSync(p, '{ broken on purpose'),
        (x) => readJson(x)
      )
    ).toThrow(/已自动回滚/)
    expect(readFileSync(p, 'utf8')).toBe(original)
  })

  it('新建文件且校验失败 → 删除刚建的文件，不留半成品', () => {
    const p = join(home, 'newbad.json')
    expect(() =>
      commitWithVerify(
        p,
        () => writeFileSync(p, '[oops'),
        (x) => readJson(x)
      )
    ).toThrow(/撤销本次新建/)
    expect(existsSync(p)).toBe(false)
  })

  it('目录作为目标（写入抛异常）→ 原文件不存在时也不留下', () => {
    const d = join(home, 'adir')
    mkdirSync(d, { recursive: true })
    // 已存在但无法解析为对象 → loadForWrite 层面就会拒写；这里直接测 commit：copyFileSync 目录会抛
    expect(() =>
      commitWithVerify(
        d,
        () => writeFileSync(join(d, 'inner'), 'x'),
        (x) => readJson(x)
      )
    ).toThrow()
    expect(existsSync(join(d, 'inner'))).toBe(false)
    rmSync(d, { recursive: true, force: true })
  })
})
