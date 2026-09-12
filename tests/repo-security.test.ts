import { afterAll, describe, expect, it } from 'vitest'
import { execSync } from 'child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runRepoSecurityScan } from '../src/main/repo-security'

let dirs: string[] = []
function makeRepo(): string {
  const d = mkdtempSync(join(tmpdir(), 'repo-sec-'))
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function git(cwd: string, cmd: string): void {
  execSync(`git ${cmd}`, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
}

const SECRET = 'Ab3d5e7f9g1h3j5k7m9o' // 触发 KV 规则的通用密钥形态
const GH_TOKEN = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz12'

describe('runRepoSecurityScan', () => {
  it('非 git 目录：递归扫描并忽略 node_modules', async () => {
    const d = makeRepo()
    writeFileSync(join(d, 'config.js'), `api_key = "${SECRET}"\n`)
    mkdirSync(join(d, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(d, 'node_modules', 'pkg', 'index.js'), `token = "${SECRET}"\n`)

    const r = await runRepoSecurityScan(d)
    expect(r.isGitRepo).toBe(false)
    expect(r.scannedFiles).toBe(1) // node_modules 被跳过
    expect(r.findings.length).toBe(1)
    expect(r.findings[0]).toMatchObject({
      category: 'plaintext-secret',
      severity: 'high',
      path: 'config.js',
      line: 1
    })
    expect(r.findings[0].snippet).not.toContain(SECRET)
  })

  it('git 仓库：已提交的 .env 报高危', async () => {
    const d = makeRepo()
    writeFileSync(join(d, '.env'), `API_KEY=${SECRET}\n`)
    git(d, 'init')
    git(d, 'add .env')
    git(d, 'commit -m init')

    const r = await runRepoSecurityScan(d)
    expect(r.isGitRepo).toBe(true)
    const committed = r.findings.filter((f) => f.category === 'committed-env')
    expect(committed.length).toBe(1)
    expect(committed[0]).toMatchObject({ severity: 'high', path: '.env' })
    // .gitignore 不存在且仓库里有 .env：额外提示补规则
    const gi = r.findings.filter((f) => f.category === 'gitignore-missing')
    expect(gi.length).toBe(1)
    expect(gi[0].path).toBe('.gitignore')
  })

  it('git 仓库：未跟踪且未被 ignore 的 .env 提示 gitignore 缺失', async () => {
    const d = makeRepo()
    git(d, 'init')
    writeFileSync(join(d, 'README.md'), '# hi\n')
    writeFileSync(join(d, '.gitignore'), 'node_modules\n')
    git(d, 'add .')
    git(d, 'commit -m init')
    writeFileSync(join(d, '.env'), 'DB_HOST=localhost\n') // 无真实密钥，避免 plaintext-secret 噪音

    const r = await runRepoSecurityScan(d)
    const missing = r.findings.filter((f) => f.category === 'gitignore-missing')
    expect(missing.length).toBe(2) // 未覆盖的 .env + .gitignore 缺 .env 规则
    expect(missing.every((f) => f.severity === 'medium')).toBe(true)
  })

  it('git 仓库：被 ignore 的 .env 不报 gitignore 问题', async () => {
    const d = makeRepo()
    git(d, 'init')
    writeFileSync(join(d, '.gitignore'), '.env\n')
    writeFileSync(join(d, 'README.md'), '# hi\n')
    git(d, 'add .')
    git(d, 'commit -m init')
    writeFileSync(join(d, '.env'), 'DB_HOST=localhost\n')

    const r = await runRepoSecurityScan(d)
    expect(r.findings.filter((f) => f.category === 'gitignore-missing')).toHaveLength(0)
  })

  it('已跟踪文件里的密钥：建议轮换；未跟踪：建议移除并 ignore', async () => {
    const d = makeRepo()
    git(d, 'init')
    writeFileSync(join(d, 'tracked.js'), `id = "${GH_TOKEN}"\n`)
    git(d, 'add tracked.js')
    git(d, 'commit -m init')
    writeFileSync(join(d, 'local.js'), `id = "${GH_TOKEN}"\n`)

    const r = await runRepoSecurityScan(d)
    const secrets = r.findings.filter((f) => f.category === 'plaintext-secret')
    expect(secrets.length).toBe(2)
    expect(secrets.find((f) => f.path === 'tracked.js')!.advice).toContain('轮换')
    expect(secrets.find((f) => f.path === 'local.js')!.advice).toContain('.gitignore')
  })

  it('.env.example 不算敏感文件，二进制文件跳过', async () => {
    const d = makeRepo()
    writeFileSync(join(d, '.env.example'), 'API_KEY=your_key_here\n')
    writeFileSync(join(d, 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x00, 0x01]))

    const r = await runRepoSecurityScan(d)
    expect(r.findings).toHaveLength(0)
    expect(r.scannedFiles).toBe(1) // .env.example 扫了，png 按二进制跳过
  })

  it('无效路径抛错', async () => {
    await expect(runRepoSecurityScan('/nonexistent/definitely/not/here')).rejects.toThrow()
  })
})
