const $ = (id) => document.getElementById(id)
const bindings = () => window.go && window.go.main && window.go.main.App

async function call(name, ...args) {
  const api = bindings()
  if (!api || typeof api[name] !== 'function') return null
  try {
    const raw = await api[name](...args)
    if (raw === null || raw === undefined) return null
    return typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch (err) {
    console.error(name, err)
    return null
  }
}

const fmtNum = (n) => {
  n = Number(n || 0)
  if (n >= 1e8) return (n / 1e8).toFixed(2) + '亿'
  if (n >= 1e4) return (n / 1e4).toFixed(2) + '万'
  return n.toLocaleString('zh-CN')
}
const fmtMoney = (n) => '¥' + Number(n || 0).toFixed(2)
const fmtTime = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false })

let config = null
let demoMode = false

function banner(text) {
  const el = $('banner')
  if (!text) return (el.className = 'banner hidden')
  el.textContent = text
  el.className = 'banner'
}

async function loadOverview() {
  const data = (await call('GetOverview')) || {
    todayTokens: 0, weekTokens: 0, totalTokens: 0, totalRequests: 0,
    estCostCny: 0, modelCount: 0, gatewayAddr: '', series: [], topModels: []
  }
  $('statToday').textContent = fmtNum(data.todayTokens)
  $('statWeek').textContent = fmtNum(data.weekTokens)
  $('statRequests').textContent = fmtNum(data.totalRequests)
  $('statCost').textContent = fmtMoney(data.estCostCny)
  $('hintModels').textContent = (data.modelCount || 0) + ' 个模型'
  $('trendTotal').textContent = '累计 ' + fmtNum(data.totalTokens) + ' tokens'
  if (data.startupError) banner(data.startupError)

  const addr = data.gatewayAddr || ''
  $('gwAddr').textContent = addr || '未启动'
  $('gwState').textContent = addr ? '网关运行中' : '网关未运行'
  $('dot').className = 'dot ' + (addr ? 'on' : 'off')
  $('cfgEndpoint').textContent = addr || '—'

  drawChart(data.series || [])
  drawBars(data.topModels || [])
}

function drawChart(series) {
  const el = $('chart')
  if (!series.length) return (el.innerHTML = '<div class="empty">暂无网关用量数据</div>')
  const w = 640, h = 200, padL = 8, padR = 8, padT = 16, padB = 26
  const max = Math.max(...series.map((p) => p.tokens), 1)
  const stepX = (w - padL - padR) / Math.max(series.length - 1, 1)
  const pts = series.map((p, i) => {
    const x = padL + i * stepX
    const y = padT + (h - padT - padB) * (1 - p.tokens / max)
    return { x, y, p }
  })
  const line = pts.map((q, i) => (i ? 'L' : 'M') + q.x.toFixed(1) + ',' + q.y.toFixed(1)).join(' ')
  const area = line + ` L${pts[pts.length - 1].x.toFixed(1)},${h - padB} L${pts[0].x.toFixed(1)},${h - padB} Z`
  const grid = [0, .5, 1].map((r) => {
    const y = padT + (h - padT - padB) * r
    return `<line x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}" stroke="#263041" stroke-dasharray="3 5"/>`
  }).join('')
  const labels = pts.map((q, i) =>
    i % Math.ceil(series.length / 5) === 0 || i === pts.length - 1
      ? `<text x="${q.x}" y="${h - 6}" fill="#64748b" font-size="10" text-anchor="middle">${q.p.key.slice(5)}</text>` : ''
  ).join('')
  const dots = pts.filter((q) => q.p.tokens > 0).map((q) =>
    `<circle cx="${q.x}" cy="${q.y}" r="3" fill="#5eead4"><title>${q.p.key}: ${fmtNum(q.p.tokens)} tokens</title></circle>`
  ).join('')
  el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <defs><linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#5eead4" stop-opacity=".28"/>
      <stop offset="100%" stop-color="#5eead4" stop-opacity="0"/>
    </linearGradient></defs>
    ${grid}<path d="${area}" fill="url(#grad)"/>
    <path d="${line}" fill="none" stroke="#5eead4" stroke-width="2" stroke-linejoin="round"/>
    ${dots}${labels}</svg>`
}

function drawBars(models) {
  const el = $('modelBars')
  if (!models.length) return (el.innerHTML = '<div class="empty">暂无模型数据</div>')
  const max = Math.max(...models.map((m) => m.tokens), 1)
  el.innerHTML = models.map((m) => `<div class="bar-row">
    <div class="bar-name" title="${m.key}">${m.key || '未知'}</div>
    <div class="bar-track"><div class="bar-fill" style="width:${(m.tokens / max * 100).toFixed(1)}%"></div></div>
    <div class="bar-val">${fmtNum(m.tokens)}</div>
  </div>`).join('')
}

async function loadRecords() {
  const dim = $('dim').value
  const days = Number($('days').value)
  const stats = (await call('GetStats', dim, days)) || []
  const rows = (await call('GetRecords', 100)) || []
  $('aggTable').innerHTML = stats.length ? `<table><thead><tr>
    <th>${dim === 'day' ? '日期' : dim === 'model' ? '模型' : '来源'}</th>
    <th class="num">Token</th><th class="num">请求</th><th class="num">估算成本</th>
    </tr></thead><tbody>${stats.map((s) => `<tr><td>${s.key || '未知'}</td>
      <td class="num">${fmtNum(s.tokens)}</td><td class="num">${fmtNum(s.requests)}</td>
      <td class="num">${fmtMoney(s.costCny)}</td></tr>`).join('')}</tbody></table>`
    : '<div class="empty">所选范围内暂无数据</div>'

  $('recordTable').innerHTML = rows.length ? `<table><thead><tr>
    <th>时间</th><th>模型</th><th>来源</th><th class="num">输入</th><th class="num">输出</th>
    <th class="num">缓存读</th><th class="num">合计</th><th class="num">成本</th><th>状态</th>
    </tr></thead><tbody>${rows.map((r) => `<tr>
      <td>${fmtTime(r.ts)}</td><td>${r.model || '—'}</td><td>${r.source || 'http'}</td>
      <td class="num">${fmtNum(r.inputTokens)}</td><td class="num">${fmtNum(r.outputTokens)}</td>
      <td class="num">${fmtNum(r.cacheRead)}</td><td class="num">${fmtNum(
        r.inputTokens + r.outputTokens + r.cacheRead + r.cacheWrite + r.reasoning)}</td>
      <td class="num">${fmtMoney(r.costUsd * (config?.rateUsdCny || 7.2))}</td>
      <td><span class="tag ${r.status && r.status.startsWith('HTTP 2') ? '' : r.estimated ? 'est' : 'err'}">${
        r.estimated ? '估算' : r.status || '—'}</span></td>
    </tr>`).join('')}</tbody></table>`
    : '<div class="empty">还没有经过网关的请求</div>'
}

async function loadConfig() {
  config = await call('GetConfig')
  if (!config) {
    demoMode = true
    banner('当前为浏览器预览（Wails 绑定未注入），显示的是空数据。请在 Wails 窗口中运行。')
    config = { port: 8790, apiKey: '****', upstreams: [], rateUsdCny: 7.2 }
  }
  $('cfgPort').value = config.port || 8790
  $('cfgRate').value = config.rateUsdCny || 7.2
  $('cfgKey').value = config.apiKey || '****'
  renderUpstreams()
}

function renderUpstreams() {
  const list = config.upstreams || []
  $('upstreamList').innerHTML = list.length ? list.map((u, i) => `<div class="up-row">
    <div><div class="u-name">${u.enabled ? '' : '○ '}${u.name || u.model || '未命名'}</div><div class="u-sub">${u.model || '—'}</div></div>
    <div class="u-sub">${u.baseURL || '—'}</div>
    <div class="u-sub">${u.apiKey || '—'}</div>
    <button class="btn danger" data-del="${i}">删除</button>
  </div>`).join('') : '<div class="empty">尚未配置上游模型，添加一个后即可通过网关转发</div>'
  $('upstreamList').querySelectorAll('[data-del]').forEach((btn) => {
    btn.onclick = () => { config.upstreams.splice(Number(btn.dataset.del), 1); renderUpstreams() }
  })
}

async function saveConfig() {
  config.port = Number($('cfgPort').value) || 8790
  config.rateUsdCny = Number($('cfgRate').value) || 7.2
  const res = await call('SaveConfig', JSON.stringify(config))
  if (!res) return banner('保存失败：Wails 绑定不可用')
  if (!res.ok) return banner('保存失败：' + res.error)
  banner('')
  await loadConfig()
  await loadOverview()
}

function route() {
  const name = (location.hash.replace('#/', '') || 'overview').split('?')[0]
  const titles = { overview: ['概览', '只统计经本地网关出去的 Token 消耗'], records: ['Token 明细', '按天 / 模型 / 来源聚合与逐请求记录'], settings: ['网关设置', '本地网关与上游模型配置'] }
  const t = titles[name] || titles.overview
  $('pageTitle').textContent = t[0]
  $('pageSubtitle').textContent = t[1]
  document.querySelectorAll('.nav-item').forEach((a) => a.classList.toggle('active', a.dataset.route === name))
  ;['overview', 'records', 'settings'].forEach((p) => $('page-' + p).classList.toggle('hidden', p !== name))
  if (name === 'overview') loadOverview()
  if (name === 'records') loadRecords()
  if (name === 'settings') loadConfig()
}

$('btnRefresh').onclick = route
$('dim').onchange = loadRecords
$('days').onchange = loadRecords
$('btnSave').onclick = saveConfig
$('btnAddUp').onclick = () => {
  const name = $('upName').value.trim(), model = $('upModel').value.trim()
  const baseURL = $('upBase').value.trim(), apiKey = $('upKey').value.trim()
  if (!model || !baseURL) return banner('模型 ID 与 Base URL 不能为空')
  config.upstreams = config.upstreams || []
  config.upstreams.push({ id: '', name: name || model, model, baseURL, apiKey, enabled: true })
  ;['upName', 'upModel', 'upBase', 'upKey'].forEach((id) => ($(id).value = ''))
  banner('')
  renderUpstreams()
}
$('btnReveal').onclick = async () => {
  const key = await call('RevealKey')
  if (key) $('cfgKey').value = key
}
$('btnCopy').onclick = async () => {
  const key = await call('RevealKey')
  if (key && navigator.clipboard) await navigator.clipboard.writeText(key)
}
$('btnRegen').onclick = async () => {
  const key = await call('RegenerateKey')
  if (key) { $('cfgKey').value = key; await loadConfig() }
}

window.addEventListener('hashchange', route)
route()
setInterval(() => { if (!location.hash || location.hash === '#/overview') loadOverview() }, 15000)
