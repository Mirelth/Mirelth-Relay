import type { McpTool } from '@shared/types'
import { getStore } from './cache'

/**
 * MCP 连通性探测：
 * - http/sse：发轻量请求，收到任何 HTTP 响应视为在线（404/405 也说明服务在监听）
 * - stdio：检查命令是否存在于磁盘，存在则标记 unverified（不真正拉起进程）
 */

async function probeHttp(url: string): Promise<{ status: 'online' | 'offline'; detail: string }> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 4000)
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agent-manager', version: '1.0.0' } } }),
      signal: controller.signal
    })
    clearTimeout(timer)
    if (res.ok || res.status === 400 || res.status === 401 || res.status === 404 || res.status === 405 || res.status === 406) {
      // 服务有响应即在线；尝试解析 initialize 结果提取工具
      return { status: 'online', detail: `HTTP ${res.status}` }
    }
    return { status: 'offline', detail: `HTTP ${res.status}` }
  } catch (err) {
    return { status: 'offline', detail: err instanceof Error ? err.message : String(err) }
  }
}

async function listHttpTools(url: string): Promise<McpTool[]> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 4000)
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      signal: controller.signal
    })
    clearTimeout(timer)
    const text = await res.text()
    // SSE 或 JSON 都尝试解析出 tools
    const jsonStart = text.indexOf('{')
    if (jsonStart < 0) return []
    const json = JSON.parse(text.slice(jsonStart))
    const tools = json?.result?.tools
    if (!Array.isArray(tools)) return []
    return tools.map((t: { name?: string; description?: string }) => ({
      name: t.name || 'unknown',
      description: t.description?.slice(0, 160)
    }))
  } catch {
    return []
  }
}

function probeStdio(command: string): { status: 'online' | 'unverified'; detail: string } {
  const bin = command.trim().split(/\s+/)[0]
  if (bin.startsWith('/') || bin.startsWith('~')) {
    return { status: 'unverified', detail: existsBin(bin) ? '命令存在（stdio 未连接）' : '命令不存在' }
  }
  return { status: 'unverified', detail: 'stdio 服务未验证连接' }
}

function existsBin(p: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs')
    fs.accessSync(p.replace(/^~/, require('os').homedir()))
    return true
  } catch {
    return false
  }
}

export async function checkMcpHealth(serverId: string): Promise<void> {
  const store = getStore()
  const server = store.listMcp().find((m) => m.id === serverId)
  if (!server) return
  if (!server.enabled) {
    store.updateMcpStatus(serverId, 'disabled', '已在智能体配置中禁用', server.tools)
    return
  }
  if (server.transport === 'http' || server.transport === 'sse') {
    if (!server.endpoint) {
      store.updateMcpStatus(serverId, 'unverified', '无 endpoint', server.tools)
      return
    }
    const probe = await probeHttp(server.endpoint)
    const tools = probe.status === 'online' ? await listHttpTools(server.endpoint) : []
    store.updateMcpStatus(serverId, probe.status, probe.detail, tools.length ? tools : server.tools)
    return
  }
  if (server.transport === 'stdio' && server.endpoint) {
    const probe = probeStdio(server.endpoint)
    store.updateMcpStatus(serverId, probe.status, probe.detail, server.tools)
    return
  }
  store.updateMcpStatus(serverId, 'unverified', '无法识别的传输类型', server.tools)
}

export async function checkAllMcp(agentId?: string): Promise<void> {
  const servers = getStore().listMcp(agentId)
  // 并发受控：每批 6 个
  for (let i = 0; i < servers.length; i += 6) {
    await Promise.all(servers.slice(i, i + 6).map((s) => checkMcpHealth(s.id)))
  }
}
