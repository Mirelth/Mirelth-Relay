import { useEffect, useState } from 'react'
import { call, callRaw } from '../relay'
import { Card, Empty, btnStyle, inputStyle, primaryBtnStyle } from './ui'

type Upstream = {
  id: string; name: string; baseURL: string; apiKey: string
  model: string; kind: string; enabled: boolean
  // 账号池字段：一个模型可以挂多条上游，靠 weight / maxConcurrent / models 决定怎么路由。
  models?: string[]
  group?: string
  weight?: number
  maxConcurrent?: number
}

const emptyDraft = {
  name: '', model: '', baseURL: '', apiKey: '', kind: 'openai',
  models: '', group: '', weight: '', maxConcurrent: ''
}

const parseModels = (s: string): string[] =>
  s.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean)

export default function Settings() {
  const [config, setConfig] = useState<any>(null)
  const [draft, setDraft] = useState({ ...emptyDraft })
  const [message, setMessage] = useState('')

  const load = () => call('GetConfig').then((c) => setConfig(c || { port: 8790, apiKey: '****', upstreams: [], rateUsdCny: 7.2 }))
  useEffect(() => { load() }, [])

  const updateUpstreams = (list: Upstream[]) => setConfig({ ...config, upstreams: list })
  const patch = (index: number, key: keyof Upstream, value: any) =>
    updateUpstreams((config.upstreams || []).map((u: Upstream, j: number) => (j === index ? { ...u, [key]: value } : u)))

  const add = () => {
    if (!draft.model.trim() || !draft.baseURL.trim()) {
      setMessage('模型 ID 与 Base URL 不能为空')
      return
    }
    updateUpstreams([...(config.upstreams || []), {
      id: '', name: draft.name.trim() || draft.model.trim(), model: draft.model.trim(),
      baseURL: draft.baseURL.trim(), apiKey: draft.apiKey.trim(), kind: draft.kind, enabled: true,
      models: parseModels(draft.models), group: draft.group.trim(),
      weight: Number(draft.weight) || 0, maxConcurrent: Number(draft.maxConcurrent) || 0
    }])
    setDraft({ ...emptyDraft })
    setMessage('')
  }

  const save = async () => {
    const next = {
      ...config,
      port: Number(config.port) || 8790,
      rateUsdCny: Number(config.rateUsdCny) || 7.2
    }
    const res = await call<any>('SaveConfig', JSON.stringify(next))
    setMessage(res?.ok ? '已保存，网关已按新配置运行' : `保存失败：${res?.error || 'Wails 绑定不可用'}`)
    await load()
  }

  if (!config) return <Empty>加载中…</Empty>
  const ups: Upstream[] = config.upstreams || []

  return (
    <div>
      <Card title="网关" extra="OpenAI 兼容 · 仅监听 127.0.0.1">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <label style={{ fontSize: 12, color: 'var(--muted)' }}>端口
            <input type="number" style={{ ...inputStyle, marginTop: 6 }} value={config.port}
              onChange={(e) => setConfig({ ...config, port: Number(e.target.value) })} />
          </label>
          <label style={{ fontSize: 12, color: 'var(--muted)' }}>汇率 (CNY/USD)
            <input type="number" step="0.01" style={{ ...inputStyle, marginTop: 6 }} value={config.rateUsdCny}
              onChange={(e) => setConfig({ ...config, rateUsdCny: Number(e.target.value) })} />
          </label>
          <label style={{ gridColumn: '1 / -1', fontSize: 12, color: 'var(--muted)' }}>API Key
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <input readOnly style={inputStyle} value={config.apiKey} />
              <button style={btnStyle} onClick={async () => {
                const key = await callRaw('RevealKey')
                if (key) setConfig({ ...config, apiKey: key })
              }}>显示</button>
              <button style={btnStyle} onClick={async () => {
                const key = await callRaw('RevealKey')
                if (key && navigator.clipboard) await navigator.clipboard.writeText(key)
              }}>复制</button>
              <button style={btnStyle} onClick={async () => {
                const key = await callRaw('RegenerateKey')
                if (key) setConfig({ ...config, apiKey: key })
              }}>重新生成</button>
            </div>
          </label>
        </div>
        <div style={{ background: 'var(--panel-2)', borderRadius: 8, padding: '10px 12px', marginTop: 14, fontSize: 11.5, color: 'var(--muted)' }}>
          客户端 Base URL 设为 <code style={{ color: 'var(--accent)' }}>http://127.0.0.1:{config.port}/v1</code>，
          Authorization 使用上面的 Key。切换端口会重启网关；<code style={{ color: 'var(--accent)' }}>kind=anthropic</code> 的上游会自动做 Messages 协议转换。
        </div>
      </Card>

      <Card title="上游账号池" extra="同一模型可挂多个账号，429/5xx 自动换号重试">
        {ups.length ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
            {ups.map((u, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '1.4fr 1.8fr 1fr 0.7fr 0.7fr auto', gap: 10,
                alignItems: 'center', background: 'var(--panel-2)', border: '1px solid var(--border)',
                borderRadius: 9, padding: '10px 12px', fontSize: 12 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>{u.name || u.model}</div>
                  <div style={{ color: 'var(--muted)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {u.model || '通配'} · {u.kind || 'openai'}
                  </div>
                  <div style={{ color: 'var(--muted)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={u.baseURL}>
                    {u.baseURL}
                  </div>
                </div>
                <input
                  style={{ ...inputStyle, fontSize: 11.5 }}
                  placeholder="模型列表（逗号分隔，留空用上面的模型）"
                  value={(u.models || []).join(', ')}
                  onChange={(e) => patch(i, 'models', parseModels(e.target.value))}
                />
                <input
                  style={{ ...inputStyle, fontSize: 11.5 }}
                  placeholder="分组"
                  value={u.group || ''}
                  onChange={(e) => patch(i, 'group', e.target.value)}
                />
                <input
                  type="number"
                  title="权重：越大越优先"
                  style={{ ...inputStyle, fontSize: 11.5 }}
                  placeholder="权重"
                  value={u.weight || ''}
                  onChange={(e) => patch(i, 'weight', Number(e.target.value) || 0)}
                />
                <input
                  type="number"
                  title="并发上限：0 表示不限"
                  style={{ ...inputStyle, fontSize: 11.5 }}
                  placeholder="并发"
                  value={u.maxConcurrent || ''}
                  onChange={(e) => patch(i, 'maxConcurrent', Number(e.target.value) || 0)}
                />
                <button style={{ ...btnStyle, color: 'var(--bad)' }}
                  onClick={() => updateUpstreams(ups.filter((_, j) => j !== i))}>删除</button>
              </div>
            ))}
          </div>
        ) : <Empty>尚未配置上游模型，添加后即可通过网关转发</Empty>}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14,
          borderTop: '1px solid var(--border)', paddingTop: 16 }}>
          <label style={{ fontSize: 12, color: 'var(--muted)' }}>名称
            <input style={{ ...inputStyle, marginTop: 6 }} placeholder="例如 DeepSeek" value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label style={{ fontSize: 12, color: 'var(--muted)' }}>模型 ID
            <input style={{ ...inputStyle, marginTop: 6 }} placeholder="deepseek-chat" value={draft.model}
              onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
          </label>
          <label style={{ gridColumn: '1 / -1', fontSize: 12, color: 'var(--muted)' }}>协议
            <select style={{ ...inputStyle, marginTop: 6 }} value={draft.kind}
              onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
              <option value="openai">OpenAI 兼容（/chat/completions）</option>
              <option value="anthropic">Anthropic（/messages）</option>
            </select>
          </label>
          <label style={{ gridColumn: '1 / -1', fontSize: 12, color: 'var(--muted)' }}>Base URL
            <input style={{ ...inputStyle, marginTop: 6 }} placeholder="https://api.example.com/v1" value={draft.baseURL}
              onChange={(e) => setDraft({ ...draft, baseURL: e.target.value })} />
          </label>
          <label style={{ gridColumn: '1 / -1', fontSize: 12, color: 'var(--muted)' }}>API Key
            <input type="password" style={{ ...inputStyle, marginTop: 6 }} placeholder="sk-..." value={draft.apiKey}
              onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} />
          </label>
          <label style={{ gridColumn: '1 / -1', fontSize: 12, color: 'var(--muted)' }}>可服务模型（留空则只服务上面的模型 ID；多个用逗号分隔）
            <input style={{ ...inputStyle, marginTop: 6 }} placeholder="deepseek-chat, deepseek-reasoner" value={draft.models}
              onChange={(e) => setDraft({ ...draft, models: e.target.value })} />
          </label>
          <label style={{ fontSize: 12, color: 'var(--muted)' }}>分组
            <input style={{ ...inputStyle, marginTop: 6 }} placeholder="例如 DeepSeek" value={draft.group}
              onChange={(e) => setDraft({ ...draft, group: e.target.value })} />
          </label>
          <label style={{ fontSize: 12, color: 'var(--muted)' }}>权重 / 并发上限
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <input type="number" title="权重越大越优先" style={inputStyle} placeholder="权重" value={draft.weight}
                onChange={(e) => setDraft({ ...draft, weight: e.target.value })} />
              <input type="number" title="0 表示不限" style={inputStyle} placeholder="并发" value={draft.maxConcurrent}
                onChange={(e) => setDraft({ ...draft, maxConcurrent: e.target.value })} />
            </div>
          </label>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
          {message && <span style={{ color: message.startsWith('已保存') ? 'var(--ok)' : 'var(--bad)', fontSize: 12, alignSelf: 'center' }}>{message}</span>}
          <button style={btnStyle} onClick={add}>添加上游</button>
          <button style={primaryBtnStyle} onClick={save}>保存设置</button>
        </div>
      </Card>
    </div>
  )
}
