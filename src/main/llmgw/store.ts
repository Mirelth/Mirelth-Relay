import * as fs from 'fs'
import * as crypto from 'crypto'
import { join } from 'path'
import type { GwModelConfig, GwGatewayView } from '@shared/types'

/**
 * LLM 聚合网关配置存储（userData/llm-gateway.json，0600 权限）。
 * - 访问密钥：`atgw-` + 32 位 base64url 随机串，首次使用时生成，可重新生成
 * - 网关名称：首次初始化时自动生成 `塔台网关-xxxx`，用户可改
 * - apiKey 明文落盘（与 model-profiles.json 同策略），回显一律脱敏
 */

export const DEFAULT_PORT = 8790

interface StoreShape {
  name: string
  port: number
  key: string
  autoStart: boolean
  models: GwModelConfig[]
}

export function generateGatewayKey(): string {
  return 'atgw-' + crypto.randomBytes(24).toString('base64url')
}

export function generateGatewayName(): string {
  return '塔台网关-' + crypto.randomBytes(2).toString('hex')
}

export function generateModelId(): string {
  return 'gm-' + crypto.randomBytes(6).toString('hex')
}

export function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 12) return '••••••••'
  return key.slice(0, 9) + '••••••••' + key.slice(-4)
}

export class GwStore {
  constructor(private filePath: string) {}

  private load(): StoreShape {
    let data: StoreShape
    let fileExists = true
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<StoreShape>
      data = {
        name: typeof raw.name === 'string' && raw.name ? raw.name : generateGatewayName(),
        port: Number(raw.port) > 0 ? Number(raw.port) : DEFAULT_PORT,
        key:
          typeof raw.key === 'string' && raw.key.startsWith('atgw-')
            ? raw.key
            : generateGatewayKey(),
        autoStart: raw.autoStart === true,
        models: Array.isArray(raw.models) ? raw.models : []
      }
    } catch {
      fileExists = false
      // 首次初始化：名称、密钥由系统生成
      data = {
        name: generateGatewayName(),
        port: DEFAULT_PORT,
        key: generateGatewayKey(),
        autoStart: false,
        models: []
      }
    }
    // 初始化或修正过字段都要立刻落盘：网关每个请求都会重读配置，
    // 不落盘会导致 key/名称每次读取都在变（key 不稳定 = 全部 401）
    if (!fileExists || this.changedOnDisk(data)) this.save(data)
    return data
  }

  /** 磁盘内容与给定配置不一致时返回 true（文件损坏/字段被手改坏） */
  private changedOnDisk(data: StoreShape): boolean {
    try {
      const disk = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<StoreShape>
      return (
        disk.name !== data.name ||
        disk.port !== data.port ||
        disk.key !== data.key ||
        disk.autoStart !== data.autoStart ||
        !Array.isArray(disk.models)
      )
    } catch {
      return true
    }
  }

  private save(data: StoreShape): void {
    fs.mkdirSync(join(this.filePath, '..'), { recursive: true })
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), { mode: 0o600 })
  }

  get(): StoreShape {
    return this.load()
  }

  update(patch: {
    name?: string
    port?: number
    autoStart?: boolean
    models?: GwModelConfig[]
  }): StoreShape {
    const data = this.load()
    if (patch.name != null) {
      const name = patch.name.trim()
      if (name) data.name = name
    }
    if (patch.port != null && Number.isInteger(patch.port) && patch.port > 0 && patch.port < 65536)
      data.port = patch.port
    if (patch.autoStart != null) data.autoStart = patch.autoStart
    if (patch.models != null) {
      // 渲染层视图不含明文 apiKey：同 id 且新值为空时沿用旧 key，避免整表保存丢凭证
      const prev = new Map(data.models.map((m) => [m.id, m]))
      data.models = patch.models.map((m) => ({
        ...m,
        id: m.id || generateModelId(),
        apiKey: m.apiKey || prev.get(m.id)?.apiKey || '',
        updatedAt: new Date().toISOString()
      }))
    }
    this.save(data)
    return data
  }

  regenerateKey(): StoreShape {
    const data = this.load()
    data.key = generateGatewayKey()
    this.save(data)
    return data
  }

  revealKey(): string {
    return this.load().key
  }

  toView(data: StoreShape, running: boolean, endpoint: string): GwGatewayView {
    return {
      name: data.name,
      port: data.port,
      running,
      endpoint,
      keyMasked: maskKey(data.key),
      hasKey: data.key.length > 0,
      autoStart: data.autoStart,
      models: data.models.map((m) => ({
        id: m.id,
        name: m.name,
        kind: m.kind,
        baseURL: m.baseURL,
        model: m.model,
        tier: m.tier,
        enabled: m.enabled,
        updatedAt: m.updatedAt,
        apiKeyMasked: maskKey(m.apiKey),
        hasApiKey: m.apiKey.length > 0
      }))
    }
  }
}
