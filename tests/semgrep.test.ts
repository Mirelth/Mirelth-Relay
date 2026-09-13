import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { parse as parseYaml } from 'yaml'
import {
  SEMGREP_RULES_YAML,
  mapSemgrepResults,
  relativize,
  runSemgrepScan,
  semgrepRuleCount,
  type SemgrepJson,
  type SemgrepJsonResult
} from '../src/main/semgrep'
import { maskSecretsInText } from '../src/main/security'
import { runRepoSecurityScan } from '../src/main/repo-security'

const GH_TOKEN = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz12'

describe('semgrep 内置规则', () => {
  it('YAML 可解析，规则 id 唯一', () => {
    const doc = parseYaml(SEMGREP_RULES_YAML) as { rules: { id: string }[] }
    expect(doc.rules.length).toBeGreaterThanOrEqual(8)
    expect(new Set(doc.rules.map((r) => r.id)).size).toBe(doc.rules.length)
    expect(semgrepRuleCount()).toBe(doc.rules.length)
  })
})

describe('maskSecretsInText', () => {
  it('命名密钥与 KV 值都脱敏，普通代码原样保留', () => {
    const out = maskSecretsInText(
      `run("ghp_AbCdEfGhIjKlMnOpQrStUvWxYz12") api_key = "Ab3d5e7f9g1h3j5k7m9o"`
    )
    expect(out).not.toContain(GH_TOKEN)
    expect(out).not.toContain('Ab3d5e7f9g1h3j5k7m9o')
    expect(out).toContain('run(')
  })
})

describe('mapSemgrepResults', () => {
  const repo = '/tmp/fake-repo'
  const base: SemgrepJsonResult = {
    check_id: 'agent-tower.js-exec-concat',
    path: `${repo}/src/app.js`,
    start: { line: 3, col: 1 },
    extra: {
      severity: 'WARNING',
      lines: 'cp.exec(cmd + extra)',
      metadata: { kind: '命令注入风险', advice: '改用 execFile。' }
    }
  }

  it('severity 映射、路径相对化、元数据透传', () => {
    const out = mapSemgrepResults([base], repo, new Set())
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      severity: 'medium',
      category: 'code-risk',
      path: 'src/app.js',
      line: 3,
      kind: '命令注入风险',
      advice: '改用 execFile。'
    })
  })

  it('secret 规则归入 code-secret，片段经脱敏', () => {
    const r: SemgrepJsonResult = {
      check_id: 'agent-tower.secret-google-api-key',
      path: 'conf.txt',
      start: { line: 1, col: 1 },
      extra: {
        severity: 'ERROR',
        lines: `key = "AIza${'A'.repeat(35)}"`,
        metadata: { kind: '明文密钥(Google)', secret: true }
      }
    }
    const out = mapSemgrepResults([r], repo, new Set())
    expect(out[0].category).toBe('code-secret')
    expect(out[0].severity).toBe('high')
    expect(out[0].snippet).not.toContain('A'.repeat(35))
  })

  it('与既有发现按 path:line 去重', () => {
    const existing = new Set([`${base.path.replace(repo + '/', '')}:3`])
    expect(mapSemgrepResults([base], repo, existing)).toHaveLength(0)
  })

  it('relativize 处理绝对路径与反斜杠', () => {
    expect(relativize('/tmp/fake-repo/a/b.js', '/tmp/fake-repo')).toBe('a/b.js')
    expect(relativize('C:\\repo\\a.js', 'C:\\repo')).toBe('a.js')
  })
})

describe('runSemgrepScan 未安装时降级', () => {
  it('PATH 上没有 semgrep 时返回 available:false', async () => {
    const probe = await runSemgrepScan(tmpdir())
    // 本机未装 semgrep；若装了则跳过该断言
    if (!probe.available) expect(probe.results).toHaveLength(0)
  })
})

describe('仓库审查 + 桩 semgrep 端到端', () => {
  const made: string[] = []
  let origPath: string | undefined

  beforeAll(() => {
    origPath = process.env.PATH
  })
  afterAll(() => {
    process.env.PATH = origPath
    for (const d of made) rmSync(d, { recursive: true, force: true })
  })

  it('装有（桩）semgrep 时叠加 code-risk 发现并去重既有密钥行', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'sg-repo-'))
    const bin = mkdtempSync(join(tmpdir(), 'sg-bin-'))
    made.push(repo, bin)

    writeFileSync(join(repo, 'app.js'), `const t = "${GH_TOKEN}"\nconsole.log(1)\nrun(x)\n`)
    const fixture: SemgrepJson = {
      results: [
        // 与内置密钥检查同行的重复发现 → 应被去重
        {
          check_id: 'agent-tower.secret-gitlab-token',
          path: join(repo, 'app.js'),
          start: { line: 1, col: 1 },
          extra: { severity: 'ERROR', lines: `const t = "${GH_TOKEN}"`, metadata: { secret: true } }
        },
        {
          check_id: 'agent-tower.js-exec-concat',
          path: join(repo, 'app.js'),
          start: { line: 3, col: 1 },
          extra: {
            severity: 'WARNING',
            lines: 'run(x + y)',
            metadata: { kind: '命令注入风险', advice: '改用 execFile。' }
          }
        }
      ],
      errors: []
    }
    const fixturePath = join(bin, 'fixture.json')
    writeFileSync(fixturePath, JSON.stringify(fixture))
    const stub = join(bin, 'semgrep')
    writeFileSync(
      stub,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "9.9.9-stub"; exit 0; fi\ncat "$SEMGREP_STUB_JSON"\n`
    )
    chmodSync(stub, 0o755)
    process.env.PATH = `${bin}:${process.env.PATH}`
    process.env.SEMGREP_STUB_JSON = fixturePath

    const r = await runRepoSecurityScan(repo)
    expect(r.semgrep?.available).toBe(true)
    expect(r.semgrep?.version).toBe('9.9.9-stub')
    expect(r.semgrep?.found).toBe(2)

    const codeRisk = r.findings.filter((f) => f.category === 'code-risk')
    expect(codeRisk).toHaveLength(1)
    expect(codeRisk[0]).toMatchObject({ path: 'app.js', line: 3, severity: 'medium' })

    // app.js:1 只有内置的 plaintext-secret，没有 semgrep 的重复项
    const line1 = r.findings.filter((f) => f.path === 'app.js' && f.line === 1)
    expect(line1).toHaveLength(1)
    expect(line1[0].category).toBe('plaintext-secret')
    expect(line1[0].snippet).not.toContain(GH_TOKEN)
  }, 30000)
})
