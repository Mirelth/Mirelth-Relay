import { join } from 'path'
import type { ConfigFileInfo, DataDirInfo } from '@shared/types'
import { HOME, dirSize, exists, listEntries, mtimeIso, readAppBundleVersion, readJson, redact } from '../../lib/fs'
import { emptySnapshot, makeSkillId, type Scanner, type ScannerMeta } from '../types'

const meta: ScannerMeta = {
  id: 'trae-cn',
  name: 'Trae CN',
  vendor: 'ByteDance',
  kind: 'ide',
  color: '#ef4444',
  probes: [join(HOME, '.trae-cn'), '/Applications/Trae CN.app']
}

interface SkillMd {
  name?: string
  description?: string
}

export const traeScanner: Scanner = {
  meta,
  scan() {
    const home = join(HOME, '.trae-cn')
    const detected = exists(home)
    const snap = emptySnapshot(meta, detected)
    if (!detected) return snap

    snap.info.version = readAppBundleVersion('/Applications/Trae CN.app')

    // 配置
    const configPaths = [join(home, 'skill-config.json'), join(home, 'argv.json')]
    snap.configs = configPaths.map((p): ConfigFileInfo => {
      const raw = readJson(p)
      return { path: p, exists: raw != null, summary: raw ? (redact(raw) as Record<string, unknown>) : null }
    })

    // 数据目录
    const dirs: [string, string][] = [
      [join(home, 'builtin_skills'), '内置技能'],
      [join(home, 'extensions'), '扩展'],
      [join(home, 'mcps'), 'MCP 服务'],
      [join(home, 'memory'), '记忆库'],
      [join(HOME, 'Library/Application Support/Trae CN/User'), '编辑器用户数据']
    ]
    snap.dataDirs = dirs
      .filter(([p]) => exists(p))
      .map(([p, label]): DataDirInfo => ({ path: p, label, sizeBytes: dirSize(p) }))

    // 技能：builtin_skills/<name>/SKILL.md
    for (const name of listEntries(join(home, 'builtin_skills'))) {
      if (name.startsWith('_')) continue
      const skillDir = join(home, 'builtin_skills', name)
      const md = readJson<SkillMd>(join(skillDir, 'skill.json')) || {}
      snap.skills.push({
        id: makeSkillId(meta.id, md.name || name),
        agentId: meta.id,
        name: md.name || name,
        description: md.description,
        installedAt: mtimeIso(skillDir),
        source: skillDir,
        builtin: true
      })
    }

    // MCP：mcps/<id>/.../SERVER_METADATA.json + tools/*.json
    const mcpsRoot = join(home, 'mcps')
    for (const serverDir of listEntries(mcpsRoot)) {
      // 在子目录中寻找 SERVER_METADATA.json
      const stack = [join(mcpsRoot, serverDir)]
      let found = false
      while (stack.length && !found) {
        const cur = stack.pop() as string
        for (const entry of listEntries(cur)) {
          const full = join(cur, entry)
          if (entry === 'SERVER_METADATA.json') {
            const md = readJson<{ server_name?: string }>(full)
            const toolsDir = join(cur, 'tools')
            const tools = listEntries(toolsDir).map((t) => {
              const def = readJson<{ name?: string; description?: string }>(join(toolsDir, t))
              return {
                name: def?.name || t.replace(/\.json$/, ''),
                description: def?.description?.slice(0, 120)
              }
            })
            snap.mcpServers.push({
              name: md?.server_name || `${serverDir}/integrated_code_mode`,
              transport: 'stdio',
              endpoint: cur,
              enabled: true,
              tools,
              status: 'unverified',
              statusDetail: '内置服务，仅检测到配置'
            })
            found = true
          } else {
            // 限制深度避免过深遍历
            if (full.split('/').length - mcpsRoot.split('/').length < 5) stack.push(full)
          }
        }
      }
    }

    snap.info.skillCount = snap.skills.length
    snap.info.mcpCount = snap.mcpServers.length
    snap.info.hasUsage = false
    snap.info.projectCount = 0
    return snap
  }
}
