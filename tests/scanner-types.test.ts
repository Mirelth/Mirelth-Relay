import { describe, expect, it } from 'vitest'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import {
  appPaths,
  computeInstallState,
  detectInstallState,
  emptySnapshot,
  makeSkillId,
  skillsFromDir,
  type ScannerMeta
} from '../src/main/scanner/types'

const baseMeta: ScannerMeta = {
  id: 'test', name: 'Test', kind: 'cli', color: '#000',
  probes: ['/nope']
}

describe('computeInstallState', () => {
  it('无证据 → unknown', () => {
    expect(computeInstallState({ hasEvidence: false, programFound: false, dataFound: false })).toBe('unknown')
    expect(computeInstallState({ hasEvidence: false, programFound: true, dataFound: true })).toBe('unknown')
  })
  it('有程序 → installed', () => {
    expect(computeInstallState({ hasEvidence: true, programFound: true, dataFound: false })).toBe('installed')
    expect(computeInstallState({ hasEvidence: true, programFound: true, dataFound: true })).toBe('installed')
  })
  it('有证据但无程序、有数据 → residual', () => {
    expect(computeInstallState({ hasEvidence: true, programFound: false, dataFound: true })).toBe('residual')
  })
  it('有证据但无程序、无数据 → unknown', () => {
    expect(computeInstallState({ hasEvidence: true, programFound: false, dataFound: false })).toBe('unknown')
  })
})

describe('detectInstallState', () => {
  it('installProbes 路径存在 → installed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmgr-st-'))
    try {
      const meta: ScannerMeta = {
        ...baseMeta,
        installProbes: [dir, join(dir, 'no-such-app')]
      }
      expect(detectInstallState(meta, false)).toBe('installed')
      expect(detectInstallState(meta, true)).toBe('installed')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('installProbes 缺失但 dataFound → residual', () => {
    const meta: ScannerMeta = {
      ...baseMeta,
      installProbes: ['/path/that/does/not/exist/x.app']
    }
    expect(detectInstallState(meta, true)).toBe('residual')
    expect(detectInstallState(meta, false)).toBe('unknown')
  })
  it('installProbeResolver 动态计算也能用', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmgr-st-'))
    try {
      const meta: ScannerMeta = {
        ...baseMeta,
        installProbeResolver: () => [dir]
      }
      expect(detectInstallState(meta, false)).toBe('installed')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('无 installProbes 也无 installBins → unknown', () => {
    expect(detectInstallState(baseMeta, true)).toBe('unknown')
  })
})

describe('appPaths', () => {
  it('同时返回 /Applications 与 ~/Applications', () => {
    const [a, b] = appPaths('X.app')
    expect(a).toContain('/Applications/X.app')
    expect(b).toContain('/Applications/X.app')
    expect(a).not.toBe(b)
  })
  it('多个 app 名展平', () => {
    expect(appPaths('A.app', 'B.app')).toHaveLength(4)
  })
})

describe('emptySnapshot', () => {
  it('detected=false 时所有计数为 0', () => {
    const snap = emptySnapshot(baseMeta, false)
    expect(snap.info).toMatchObject({
      id: 'test', name: 'Test', detected: false,
      installState: 'unknown',
      skillCount: 0, mcpCount: 0, hasUsage: false, projectCount: 0
    })
    expect(snap.skills).toEqual([])
    expect(snap.usage).toEqual([])
    expect(snap.mcpServers).toEqual([])
  })
  it('detected=true 保留 meta 字段', () => {
    const snap = emptySnapshot({ ...baseMeta, vendor: 'Acme', color: '#f00' }, true)
    expect(snap.info.vendor).toBe('Acme')
    expect(snap.info.color).toBe('#f00')
    expect(snap.info.detected).toBe(true)
  })
})

describe('makeSkillId', () => {
  it('同 agent+name 多次调用 id 单调递增', () => {
    const a = makeSkillId('qoder', 'foo')
    const b = makeSkillId('qoder', 'foo')
    const c = makeSkillId('qoder', 'bar')
    expect(a.startsWith('qoder:foo:')).toBe(true)
    expect(b.startsWith('qoder:foo:')).toBe(true)
    expect(c.startsWith('qoder:bar:')).toBe(true)
    // 序列号严格递增
    const aN = Number(a.split(':').pop())
    const bN = Number(b.split(':').pop())
    const cN = Number(c.split(':').pop())
    expect(bN).toBeGreaterThan(aN)
    expect(cN).toBeGreaterThan(bN)
  })
})

describe('skillsFromDir', () => {
  it('空目录 → 空数组', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmgr-sfd-'))
    try {
      expect(skillsFromDir('qoder', dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('子目录无 SKILL.md 时 name 退化用 basename', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmgr-sfd-'))
    try {
      const sub = join(dir, 'plain-skill')
      require('fs').mkdirSync(sub, { recursive: true })
      const list = skillsFromDir('qoder', dir)
      expect(list).toHaveLength(1)
      expect(list[0].name).toBe('plain-skill')
      expect(list[0].agentId).toBe('qoder')
      expect(list[0].builtin).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('opts.builtin=true 透传', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmgr-sfd-'))
    try {
      require('fs').mkdirSync(join(dir, 'x'), { recursive: true })
      const list = skillsFromDir('qoder', dir, { builtin: true })
      expect(list[0].builtin).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
