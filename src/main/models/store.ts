import * as fs from 'fs'
import { join } from 'path'
import type { ModelProfile, ModelProfileView } from '@shared/types'

/**
 * 模型 Profile 本地存储（userData/model-profiles.json，0600 权限）。
 * apiKey 仅保存在本地，返回给渲染进程时脱敏。
 */

interface StoreShape {
  profiles: ModelProfile[]
}

export class ModelStore {
  constructor(private filePath: string) {}

  private load(): StoreShape {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as StoreShape
      return { profiles: Array.isArray(raw.profiles) ? raw.profiles : [] }
    } catch {
      return { profiles: [] }
    }
  }

  private save(data: StoreShape): void {
    fs.mkdirSync(join(this.filePath, '..'), { recursive: true })
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), { mode: 0o600 })
  }

  list(): ModelProfile[] {
    return this.load().profiles.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  }

  get(id: string): ModelProfile | undefined {
    return this.load().profiles.find((p) => p.id === id)
  }

  upsert(profile: ModelProfile): void {
    const data = this.load()
    const idx = data.profiles.findIndex((p) => p.id === profile.id)
    profile.updatedAt = new Date().toISOString()
    if (idx >= 0) data.profiles[idx] = profile
    else data.profiles.push(profile)
    this.save(data)
  }

  remove(id: string): void {
    const data = this.load()
    data.profiles = data.profiles.filter((p) => p.id !== id)
    this.save(data)
  }
}

function mask(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '••••••••'
  return key.slice(0, 4) + '••••••••' + key.slice(-4)
}

export function toView(p: ModelProfile): ModelProfileView {
  const { apiKey, ...rest } = p
  return { ...rest, apiKeyMasked: mask(apiKey), hasApiKey: apiKey.length > 0 }
}
