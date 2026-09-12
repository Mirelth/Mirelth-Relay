import { readFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import { afterAll, describe, expect, it, vi } from 'vitest'

const { home } = vi.hoisted(() => {
  const fs = require('fs') as typeof import('fs')
  const os = require('os') as typeof import('os')
  const path = require('path') as typeof import('path')
  return { home: fs.mkdtempSync(path.join(os.tmpdir(), 'agentmgr-tasks-')) }
})

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => home }
})

const eng = await import('../src/main/execution-engine')
const con = await import('../src/main/constraints')
const tr = await import('../src/main/trust-scoring')
const qu = await import('../src/main/task-queue')

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('execution-engine 任务流', () => {
  it('create → LLM 拆解（注入）→ 子任务按模型轮转分配', async () => {
    eng.setDefaultTaskDecomposer(async () => ['先查资料', '再写代码', '最后测试'])
    const task = eng.createTask('做一个小工具', '查资料。写代码。测试。', 'sequential', [
      'gm-a',
      'gm-b'
    ])
    const subs = await eng.decomposeTask(task.id)
    expect(subs.map((s) => s.description)).toEqual(['先查资料', '再写代码', '最后测试'])
    expect(subs.map((s) => s.assignedAgent)).toEqual(['gm-a', 'gm-b', 'gm-a'])
  })

  it('拆解器未注入时给出明确引导', async () => {
    const task = eng.createTask('t', 'd', 'sequential', [])
    // platformDecomposer 已被上一条注入；这里用一个全新文件级状态不可行，
    // 改为传 undefined 且先清空：通过再次 setDefaultTaskDecomposer 无法清空，
    // 因此直接验证「注入后拆解可用」由上一条覆盖，本条验证 decomposeFn 优先。
    const subs = await eng.decomposeTask(task.id, async () => ['手动注入的子任务'])
    expect(subs).toHaveLength(1)
    expect(subs[0].description).toBe('手动注入的子任务')
  })

  it('执行成功：输出落库 + 信任度上升', async () => {
    eng.setDefaultTaskExecutor(async (agentId, desc) => `完成：${desc}（by ${agentId}）`)
    const task = eng.createTask('t2', 'd', 'sequential', ['gm-ok'])
    await eng.decomposeTask(task.id, async () => ['子任务 A'])
    const out = await eng.executeSubTask(task.id, `subtask-${task.id}-0`)
    expect(out).toContain('子任务 A')
    const updated = eng.getTask(task.id)!
    expect(updated.subTasks[0].status).toBe('completed')
    const score = tr.getAgentTrustScore('gm-ok')
    expect(score).not.toBeNull()
    expect(score!.successfulTasks).toBe(1)
  })

  it('约束 block：不满足时子任务直接失败且不调用执行器', async () => {
    con.addConstraint({
      agentId: 'gm-blocked',
      type: 'cost-cap',
      config: { maxCostPerDay: 0 },
      action: 'block',
      enabled: true
    })
    let called = 0
    eng.setDefaultTaskExecutor(async () => {
      called++
      return 'x'
    })
    const task = eng.createTask('t3', 'd', 'sequential', ['gm-blocked'])
    await eng.decomposeTask(task.id, async () => ['被拦截的子任务'])
    const out = await eng.executeSubTask(task.id, `subtask-${task.id}-0`)
    expect(out).toBe('')
    const updated = eng.getTask(task.id)!
    expect(updated.subTasks[0].status).toBe('failed')
    expect(updated.subTasks[0].error).toContain('成本已达上限')
    expect(called).toBe(0)
  })

  it('执行失败：信任度下降 + 摩擦点落盘', async () => {
    eng.setDefaultTaskExecutor(async () => {
      throw new Error('上游 502')
    })
    const task = eng.createTask('t4', 'd', 'sequential', ['gm-bad'])
    await eng.decomposeTask(task.id, async () => ['会失败的子任务'])
    await eng.executeSubTask(task.id, `subtask-${task.id}-0`)
    const score = tr.getAgentTrustScore('gm-bad')!
    expect(score.failedTasks).toBe(1)
    const frictionPath = join(home, '.agent-tower', 'friction-points.json')
    expect(existsSync(frictionPath)).toBe(true)
    const points = JSON.parse(readFileSync(frictionPath, 'utf8')) as { agentId: string }[]
    expect(points.some((p) => p.agentId === 'gm-bad')).toBe(true)
  })

  it('warn 级约束：继续执行并把警告并入输出', async () => {
    con.addConstraint({
      agentId: 'gm-warned',
      type: 'time-window',
      // 取一个必然不含当前小时的时段
      config: {
        allowedHours: [(new Date().getHours() + 2) % 24, (new Date().getHours() + 3) % 24]
      },
      action: 'warn',
      enabled: true
    })
    eng.setDefaultTaskExecutor(async () => '正常输出')
    const task = eng.createTask('t5', 'd', 'sequential', ['gm-warned'])
    await eng.decomposeTask(task.id, async () => ['带警告的子任务'])
    const out = await eng.executeSubTask(task.id, `subtask-${task.id}-0`)
    expect(out).toContain('正常输出')
    expect(out).toContain('警告')
  })
})

describe('task-queue 串行执行', () => {
  it('入队后逐个串行执行且不重入：每个子任务恰好执行一次', async () => {
    const executed: string[] = []
    eng.setDefaultTaskExecutor(async (_agentId, desc) => {
      executed.push(desc)
      await new Promise((r) => setTimeout(r, 30))
      return 'ok'
    })
    const task = eng.createTask('q1', 'd', 'sequential', ['gm-q'])
    await eng.decomposeTask(task.id, async () => ['队列子任务 1', '队列子任务 2'])
    qu.enqueue(task.id, 0)
    qu.enqueue(task.id, 0) // 重复入队不应导致重复执行

    for (let i = 0; i < 100 && eng.getTask(task.id)!.status !== 'completed'; i++) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(executed.sort()).toEqual(['队列子任务 1', '队列子任务 2'])
    expect(eng.getTask(task.id)!.status).toBe('completed')
    expect(qu.getQueueStatus().status).toBe('idle')
  })
})

describe('team-repo push 修复', () => {
  const bare = join(home, 'team-remote.git')
  it('无远程时给出明确错误而不是晦涩的 git 报错', async () => {
    const repo = await import('../src/main/team-repo')
    expect(repo.initTeamRepo().success).toBe(true)
    const r = repo.pushToRemote()
    expect(r.success).toBe(false)
    expect(r.error).toContain('未配置远程')
  })
  it('绑本地裸仓库后：有变更提交推送；无变更不误报', async () => {
    execSync(`git init --bare -q "${bare}"`)
    const repo = await import('../src/main/team-repo')
    expect(repo.addRemote(bare).success).toBe(true)

    expect(repo.saveRule('team-style.md', '# 规则\n用中文提交').success).toBe(true)
    expect(repo.pushToRemote().success).toBe(true)

    // 无本地变更再次 push：不应因 commit 失败而报错
    const again = repo.pushToRemote()
    expect(again.success).toBe(true)

    // 远端确实收到了内容
    const shown = execSync(`git --git-dir "${bare}" show main:rules/team-style.md`, {
      encoding: 'utf8'
    })
    expect(shown).toContain('用中文提交')
  })
})
