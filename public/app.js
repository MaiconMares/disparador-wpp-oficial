/* ─── Gestão Fitness Brasil — Disparador WhatsApp — Frontend ───────────────── */

let db = null
let currentUser = null
let appStarted = false

const CREDENTIALS_KEY = 'wa_disparador_credentials'
const EVOLUTION_CREDENTIALS_KEY = 'wa_disparador_evolution_credentials'

// ── Boot ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init)

async function init() {
  loadSavedCredentials()
  loadEvolutionCredentials()
  setupViewSwitcher()
  setupAuthUI()

  try {
    const res = await fetch('/api/config')
    if (!res.ok) throw new Error('Could not reach /api/config')
    const { supabaseUrl, supabaseAnonKey } = await res.json()

    if (!supabaseUrl || !supabaseAnonKey) {
      showAuthError('Variáveis de ambiente do Supabase não configuradas.')
      return
    }

    const { createClient } = window.supabase
    db = createClient(supabaseUrl, supabaseAnonKey)
  } catch (err) {
    showAuthError('Falha ao conectar ao servidor.')
    console.error('init error:', err)
    return
  }

  const { data: { session } } = await db.auth.getSession()
  if (session) {
    await startApp(session.user)
  } else {
    showAuthGate()
  }

  db.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') location.reload()
  })
}

// ── Autenticação ─────────────────────────────────────────────────────────────
function setupAuthUI() {
  document.getElementById('login-form').addEventListener('submit', handleLogin)
  document.getElementById('forgot-password-btn').addEventListener('click', handleForgotPassword)
  document.getElementById('logout-btn').addEventListener('click', async () => {
    try { await db?.auth.signOut() } catch (_) { /* ignore */ }
    location.reload()
  })
}

function setAuthMessage(text, kind) {
  const errEl = document.getElementById('login-error')
  errEl.textContent = text
  errEl.className = text
    ? 'auth-error' + (kind === 'info' ? ' auth-info' : '')
    : 'auth-error hidden'
}

async function handleLogin(e) {
  e.preventDefault()
  if (!db) return

  const email = document.getElementById('login-email').value.trim()
  const password = document.getElementById('login-password').value
  const btn = document.getElementById('login-btn')

  setAuthMessage('')
  btn.disabled = true
  btn.textContent = 'Entrando...'

  try {
    const { data, error } = await db.auth.signInWithPassword({ email, password })
    if (error) {
      setAuthMessage(translateAuthError(error.message))
      return
    }
    await startApp(data.user)
  } catch (err) {
    setAuthMessage('Erro de rede ao entrar. Tente novamente.')
  } finally {
    btn.disabled = false
    btn.textContent = 'Entrar'
  }
}

async function handleForgotPassword() {
  if (!db) return
  const email = document.getElementById('login-email').value.trim()

  if (!email) {
    setAuthMessage('Digite seu e-mail no campo acima para receber o link de redefinição.')
    document.getElementById('login-email').focus()
    return
  }

  try {
    await db.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin })
    setAuthMessage('Se este e-mail tiver uma conta, enviamos um link para redefinir a senha.', 'info')
  } catch (err) {
    setAuthMessage('Não foi possível enviar o link agora. Tente novamente em instantes.')
  }
}

function translateAuthError(msg) {
  if (/invalid login credentials/i.test(msg)) return 'E-mail ou senha incorretos.'
  if (/email not confirmed/i.test(msg))       return 'E-mail ainda não confirmado. Fale com o administrador.'
  if (/rate limit/i.test(msg))                return 'Muitas tentativas. Aguarde alguns minutos.'
  return msg || 'Não foi possível entrar.'
}

function showAuthGate() {
  document.getElementById('auth-gate').classList.remove('hidden')
}

function hideAuthGate() {
  document.getElementById('auth-gate').classList.add('hidden')
}

function showAuthError(msg) {
  showAuthGate()
  setAuthMessage(msg)
}

// Cabeçalhos com o token da sessão para as chamadas às rotas /api/*.
async function authHeaders(extra = {}) {
  const { data } = await db.auth.getSession()
  const token = data?.session?.access_token
  return token ? { ...extra, Authorization: `Bearer ${token}` } : { ...extra }
}

async function startApp(user) {
  currentUser = user
  hideAuthGate()
  document.getElementById('sidebar-user-email').textContent = user?.email || ''

  if (appStarted) return
  appStarted = true

  try {
    await loadInitialData()
    subscribeRealtime()

    await loadEvolutionInitialData()
    subscribeEvolutionRealtime()
  } catch (err) {
    setStatus('error', 'Falha ao conectar')
    console.error('startApp error:', err)
  }

  checkEvolutionStatus()
}

// ── Credentials (Phone Number ID + Bearer Token) ─────────────────────────────
function loadSavedCredentials() {
  try {
    const saved = JSON.parse(localStorage.getItem(CREDENTIALS_KEY) || '{}')
    if (saved.phoneNumberId) document.getElementById('phone-id-input').value = saved.phoneNumberId
    if (saved.token) document.getElementById('token-input').value = saved.token
    if (saved.wabaId) document.getElementById('waba-id-input').value = saved.wabaId
  } catch (err) {
    console.error('Failed to load saved credentials:', err)
  }
}

function saveCredentials(phoneNumberId, token, wabaId) {
  localStorage.setItem(CREDENTIALS_KEY, JSON.stringify({ phoneNumberId, token, wabaId }))
}

// ── Connection Status ────────────────────────────────────────────────────────
function setStatus(state, label) {
  const el = document.getElementById('connection-status')
  el.className = 'connection-badge ' + state
  el.querySelector('.status-text').textContent =
    label ||
    (state === 'connected' ? 'Conectado ao Supabase'
     : state === 'error'   ? 'Falha na conexão'
     :                       'Conectando...')
}

// ── Realtime Subscriptions ──────────────────────────────────────────────────
function subscribeRealtime() {
  db.channel('wa-disparador')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'incoming_messages' }, (p) => {
      clearEmpty('incoming-list')
      prepend('incoming-list', buildIncomingEl(p.new, true))
      bumpStat('stat-received')
      if (chatNumber && p.new.sender_number === chatNumber) {
        appendChatMessage(p.new, 'in')
        chatLastIncomingAt = p.new.received_at
        updateChatWindowStatus()
      }
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'message_status_updates' }, (p) => {
      clearEmpty('status-list')
      prepend('status-list', buildStatusEl(p.new))
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sent_messages' }, (p) => {
      clearEmpty('sent-list')
      prepend('sent-list', buildSentEl(p.new))
      bumpStat('stat-sent')
      if (chatNumber && p.new.recipient_number === chatNumber) {
        appendChatMessage(p.new, 'out')
      }
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'sent_messages' }, (p) => {
      patchSentRow(p.new)
      if (p.new.status === 'delivered') bumpStat('stat-delivered')
      if (p.new.status === 'read')      bumpStat('stat-read')
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED')                          setStatus('connected')
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setStatus('error')
    })
}

// ── Initial Data Load ────────────────────────────────────────────────────────
async function loadInitialData() {
  const [sentRes, incomingRes, statusRes] = await Promise.all([
    db.from('sent_messages').select('*').order('created_at', { ascending: false }).limit(50),
    db.from('incoming_messages').select('*').order('received_at', { ascending: false }).limit(50),
    db.from('message_status_updates').select('*').order('received_at', { ascending: false }).limit(50),
  ])

  if (sentRes.data?.length)     renderList('sent-list', sentRes.data, buildSentEl)
  if (incomingRes.data?.length) renderList('incoming-list', incomingRes.data, (m) => buildIncomingEl(m, true))
  if (statusRes.data?.length)   renderList('status-list', statusRes.data, buildStatusEl)

  await refreshStats()
}

function renderList(listId, rows, builder) {
  const list = document.getElementById(listId)
  list.innerHTML = ''
  rows.forEach(r => list.appendChild(builder(r)))
}

// ── Stats ─────────────────────────────────────────────────────────────────────
async function refreshStats() {
  const [sentRes, receivedRes, deliveredRes, readRes] = await Promise.all([
    db.from('sent_messages').select('*', { count: 'exact', head: true }),
    db.from('incoming_messages').select('*', { count: 'exact', head: true }),
    db.from('sent_messages').select('*', { count: 'exact', head: true }).eq('status', 'delivered'),
    db.from('sent_messages').select('*', { count: 'exact', head: true }).eq('status', 'read'),
  ])
  document.getElementById('stat-sent').textContent      = sentRes.count      ?? 0
  document.getElementById('stat-received').textContent  = receivedRes.count  ?? 0
  document.getElementById('stat-delivered').textContent = deliveredRes.count ?? 0
  document.getElementById('stat-read').textContent      = readRes.count      ?? 0
}

function bumpStat(id) {
  const el = document.getElementById(id)
  const n = parseInt(el.textContent, 10)
  if (!isNaN(n)) el.textContent = n + 1
}

// ── DOM Builders ─────────────────────────────────────────────────────────────
function fmt(dateStr) {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

function statusBadge(status) {
  const labels = { pending: 'Pendente', sent: 'Enviado', delivered: 'Entregue', read: 'Lido', failed: 'Falhou' }
  return `<span class="status-badge status-${status}">${labels[status] || status}</span>`
}

function buildSentEl(msg) {
  const div = document.createElement('div')
  div.className = 'message-item'
  div.dataset.waId = msg.id
  div.innerHTML = `
    <div class="message-header">
      <span class="message-to">${esc(msg.recipient_number)}</span>
      ${statusBadge(msg.status)}
    </div>
    <p class="message-body">${esc(msg.message_body)}</p>
    <span class="message-time">${fmt(msg.created_at)}</span>
  `
  return div
}

function buildIncomingEl(msg, replyable) {
  const div = document.createElement('div')
  div.className = 'message-item incoming'
  div.innerHTML = `
    <div class="message-header">
      <span class="message-from">${esc(msg.sender_number)}</span>
      <span class="message-type">${esc(msg.message_type || 'text')}</span>
    </div>
    <p class="message-body">${esc(msg.message_body || '(mídia sem texto)')}</p>
    <div class="message-footer">
      <span class="message-time">${fmt(msg.received_at)}</span>
      ${replyButtonHtml(replyable, msg.sender_number)}
    </div>
  `
  return div
}

function replyButtonHtml(replyable, senderNumber) {
  if (!replyable || !senderNumber) return ''
  return `<button type="button" class="btn-reply" data-number="${esc(senderNumber)}">Responder</button>`
}

function buildStatusEl(update) {
  const div = document.createElement('div')
  div.className = 'message-item'
  div.innerHTML = `
    <div class="message-header">
      <span class="message-to">${esc(update.recipient_number || '—')}</span>
      ${statusBadge(update.status)}
    </div>
    <p class="message-id">ID: ${esc(update.wa_message_id)}</p>
    <span class="message-time">${fmt(update.received_at)}</span>
  `
  return div
}

// ── DOM Helpers ───────────────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function clearEmpty(listId) {
  const empty = document.querySelector(`#${listId} .empty-state`)
  if (empty) document.getElementById(listId).innerHTML = ''
}

function prepend(listId, el) {
  const list = document.getElementById(listId)
  list.insertBefore(el, list.firstChild)
}

function patchSentRow(msg) {
  const row = document.querySelector(`[data-wa-id="${msg.id}"]`)
  if (!row) return
  const badge = row.querySelector('.status-badge')
  if (badge) {
    badge.className = `status-badge status-${msg.status}`
    const labels = { pending: 'Pendente', sent: 'Enviado', delivered: 'Entregue', read: 'Lido', failed: 'Falhou' }
    badge.textContent = labels[msg.status] || msg.status
  }
}

// ── Form Submission ───────────────────────────────────────────────────────────
document.getElementById('send-form').addEventListener('submit', async (e) => {
  e.preventDefault()

  const phoneNumberId = document.getElementById('phone-id-input').value.trim()
  const token = document.getElementById('token-input').value.trim()
  const wabaId = document.getElementById('waba-id-input').value.trim()
  const numbersRaw = document.getElementById('numbers-input').value
  const numbers = numbersRaw.split(',').map(n => n.trim()).filter(Boolean)

  const isTemplateMode = document.getElementById('mode-template-radio').checked
  const message = isTemplateMode ? '' : document.getElementById('message-input').value.trim()

  if (!phoneNumberId || !token || numbers.length === 0) return
  if (!isTemplateMode && !message) return
  if (isTemplateMode && !selectedTemplate) {
    alert('Selecione um modelo de mensagem antes de enviar.')
    return
  }
  if (isTemplateMode) {
    const emptyVar = Array.from(document.querySelectorAll('.tpl-var-input')).find(el => !el.value.trim())
    if (emptyVar) {
      alert(`Preencha o valor da variável {{${emptyVar.dataset.var}}} do modelo antes de enviar.`)
      emptyVar.focus()
      return
    }
    const header = selectedTemplate.components.find(c => c.type === 'HEADER')
    if (header && header.format && header.format !== 'TEXT' && !document.getElementById('template-header-media-input').value.trim()) {
      alert('Informe a URL da mídia do cabeçalho do modelo antes de enviar.')
      document.getElementById('template-header-media-input').focus()
      return
    }
  }

  saveCredentials(phoneNumberId, token, wabaId)

  const btn = document.getElementById('send-btn')
  const resultsEl = document.getElementById('send-results')

  const payload = { numbers, phoneNumberId, token }

  if (isTemplateMode) {
    payload.template = {
      name: selectedTemplate.name,
      language: { code: selectedTemplate.language },
      components: buildTemplateComponents(),
    }
    payload.message = buildTemplatePreviewText()
  } else {
    payload.message = message
  }

  btn.disabled = true
  btn.textContent = 'Enviando...'
  resultsEl.innerHTML = '<p class="loading">Enviando mensagens, aguarde...</p>'
  resultsEl.classList.remove('hidden')

  try {
    const res = await fetch('/api/send', {
      method: 'POST',
      headers: await authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      resultsEl.innerHTML = `<p class="result-item result-error" style="padding:12px 14px">Erro ${res.status}: ${esc(err.error || 'Resposta inesperada do servidor')}</p>`
      return
    }

    const results = await res.json()

    resultsEl.innerHTML = results.map(r => {
      const isOk = r.status === 'ok'
      const errMsg = !isOk
        ? (r.data?.error?.message || r.data?.error?.error_data?.details || JSON.stringify(r.data))
        : ''
      return `
        <div class="result-item ${isOk ? 'result-ok' : 'result-error'}">
          <div class="result-header">
            <span>${esc(r.to)}</span>
            <span class="status-badge ${isOk ? 'status-sent' : 'status-failed'}">${isOk ? 'Enviado' : 'Erro'}</span>
          </div>
          ${!isOk ? `<p class="result-error-msg">${esc(errMsg)}</p>` : ''}
        </div>
      `
    }).join('')
  } catch (err) {
    resultsEl.innerHTML = `<p class="result-item result-error" style="padding:12px 14px">Erro de rede: ${esc(err.message)}</p>`
  } finally {
    btn.disabled = false
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15">
        <line x1="22" y1="2" x2="11" y2="13"></line>
        <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
      </svg>
      Enviar Mensagem`
  }
})

/* ── Mensagens de Modelo (Template) ────────────────────────────────────────── */
let fetchedTemplates = []
let selectedTemplate = null

document.querySelectorAll('input[name="send-mode"]').forEach(radio => {
  radio.addEventListener('change', () => {
    const isTemplateMode = document.getElementById('mode-template-radio').checked
    document.getElementById('text-mode-fields').classList.toggle('hidden', isTemplateMode)
    document.getElementById('template-mode-fields').classList.toggle('hidden', !isTemplateMode)
    document.getElementById('message-input').required = !isTemplateMode
  })
})

document.getElementById('fetch-templates-btn').addEventListener('click', async () => {
  const token = document.getElementById('token-input').value.trim()
  const wabaId = document.getElementById('waba-id-input').value.trim()
  const statusEl = document.getElementById('templates-fetch-status')
  const select = document.getElementById('template-select')

  if (!token || !wabaId) {
    statusEl.textContent = 'Informe o Bearer Token e o WhatsApp Business Account ID acima.'
    statusEl.style.color = 'var(--status-failed)'
    return
  }

  statusEl.textContent = 'Buscando modelos...'
  statusEl.style.color = ''

  try {
    const res = await fetch('/api/templates', {
      method: 'POST',
      headers: await authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ token, wabaId }),
    })
    const data = await res.json()

    if (!data.ok) {
      statusEl.textContent = data.error || 'Erro ao buscar modelos.'
      statusEl.style.color = 'var(--status-failed)'
      return
    }

    fetchedTemplates = data.templates
    select.innerHTML = '<option value="">Selecione um modelo...</option>' +
      fetchedTemplates.map((t, i) => `<option value="${i}">${esc(t.name)} (${esc(t.language)}) — ${esc(t.status)}</option>`).join('')

    statusEl.textContent = `${fetchedTemplates.length} modelo(s) encontrado(s).`
    statusEl.style.color = 'var(--primary)'
  } catch (err) {
    statusEl.textContent = 'Erro de rede: ' + err.message
    statusEl.style.color = 'var(--status-failed)'
  }
})

document.getElementById('template-select').addEventListener('change', (e) => {
  const idx = e.target.value
  selectedTemplate = idx !== '' ? fetchedTemplates[idx] : null
  document.getElementById('template-header-media-input').value = ''
  renderTemplateFields()
})

document.getElementById('template-header-media-input').addEventListener('input', updateTemplatePreview)
document.getElementById('template-variables').addEventListener('input', updateTemplatePreview)

function extractVariables(text) {
  if (!text) return []
  const seen = new Set()
  const vars = []
  for (const m of text.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
    if (!seen.has(m[1])) { seen.add(m[1]); vars.push(m[1]) }
  }
  return vars
}

function isPositionalVar(name) {
  return /^[0-9]+$/.test(name)
}

function buildParam(name, value) {
  return isPositionalVar(name)
    ? { type: 'text', text: value || '' }
    : { type: 'text', parameter_name: name, text: value || '' }
}

function resolveText(text, values) {
  if (!text) return ''
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => (values[key] ?? `{{${key}}}`))
}

function collectVarValues(section) {
  const values = {}
  document.querySelectorAll(`.tpl-var-input[data-section="${section}"]`).forEach(input => {
    values[input.dataset.var] = input.value
  })
  return values
}

function buildVarInput(section, varName) {
  const div = document.createElement('div')
  div.className = 'form-group template-var-group'
  const label = isPositionalVar(varName)
    ? `Variável {{${varName}}} (${section === 'header' ? 'cabeçalho' : 'corpo'})`
    : varName
  div.innerHTML = `
    <label for="tpl-var-${section}-${esc(varName)}">${esc(label)}</label>
    <input type="text" id="tpl-var-${section}-${esc(varName)}" data-section="${section}" data-var="${esc(varName)}" class="tpl-var-input" placeholder="Valor para {{${esc(varName)}}}" />
  `
  return div
}

function renderTemplateFields() {
  const container = document.getElementById('template-variables')
  const headerMediaGroup = document.getElementById('template-header-media-group')
  container.innerHTML = ''

  if (!selectedTemplate) {
    headerMediaGroup.classList.add('hidden')
    updateTemplatePreview()
    return
  }

  const header = selectedTemplate.components.find(c => c.type === 'HEADER')
  const body = selectedTemplate.components.find(c => c.type === 'BODY')

  headerMediaGroup.classList.toggle('hidden', !(header && header.format && header.format !== 'TEXT'))

  const headerVars = header?.format === 'TEXT' ? extractVariables(header.text) : []
  const bodyVars = body ? extractVariables(body.text) : []

  headerVars.forEach(v => container.appendChild(buildVarInput('header', v)))
  bodyVars.forEach(v => container.appendChild(buildVarInput('body', v)))

  updateTemplatePreview()
}

function updateTemplatePreview() {
  const previewGroup = document.getElementById('template-preview-group')
  const previewEl = document.getElementById('template-preview')

  if (!selectedTemplate) {
    previewGroup.classList.add('hidden')
    return
  }

  previewEl.textContent = buildTemplatePreviewText()
  previewGroup.classList.remove('hidden')
}

function buildTemplatePreviewText() {
  if (!selectedTemplate) return ''

  const header = selectedTemplate.components.find(c => c.type === 'HEADER')
  const body = selectedTemplate.components.find(c => c.type === 'BODY')
  const footer = selectedTemplate.components.find(c => c.type === 'FOOTER')

  let text = ''
  if (header) {
    text += header.format === 'TEXT'
      ? resolveText(header.text, collectVarValues('header')) + '\n\n'
      : `[Cabeçalho: ${header.format}]\n\n`
  }
  if (body) text += resolveText(body.text, collectVarValues('body'))
  if (footer?.text) text += '\n\n' + footer.text

  return text.trim()
}

function buildTemplateComponents() {
  const header = selectedTemplate.components.find(c => c.type === 'HEADER')
  const body = selectedTemplate.components.find(c => c.type === 'BODY')
  const components = []

  if (header) {
    if (header.format === 'TEXT') {
      const vars = extractVariables(header.text)
      if (vars.length) {
        const values = collectVarValues('header')
        components.push({ type: 'header', parameters: vars.map(v => buildParam(v, values[v])) })
      }
    } else {
      const mediaUrl = document.getElementById('template-header-media-input').value.trim()
      if (mediaUrl) {
        const key = header.format.toLowerCase()
        components.push({ type: 'header', parameters: [{ type: key, [key]: { link: mediaUrl } }] })
      }
    }
  }

  if (body) {
    const vars = extractVariables(body.text)
    if (vars.length) {
      const values = collectVarValues('body')
      components.push({ type: 'body', parameters: vars.map(v => buildParam(v, values[v])) })
    }
  }

  return components
}

// ── Sidebar View Switching ───────────────────────────────────────────────────
function setupViewSwitcher() {
  document.querySelectorAll('.nav-item').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault()
      const view = link.dataset.view
      document.querySelectorAll('.nav-item').forEach(l => l.classList.remove('active'))
      link.classList.add('active')
      document.getElementById('view-cloud').classList.toggle('active', view === 'cloud')
      document.getElementById('view-evolution').classList.toggle('active', view === 'evolution')
    })
  })
}

/* ── Chat: Responder cliente (janela de 24h da Cloud API) ─────────────────── */
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000

let chatNumber = null
let chatLastIncomingAt = null

document.getElementById('incoming-list').addEventListener('click', (e) => {
  const btn = e.target.closest('.btn-reply')
  if (!btn) return
  openChat(btn.dataset.number)
})

document.getElementById('chat-close-btn').addEventListener('click', closeChat)

async function openChat(number) {
  chatNumber = number
  document.getElementById('chat-contact-number').textContent = number
  document.getElementById('chat-messages').innerHTML = '<p class="loading">Carregando conversa...</p>'
  document.getElementById('cloud-content-area').classList.add('hidden')
  document.getElementById('chat-view').classList.remove('hidden')

  await loadChatMessages()
  document.getElementById('chat-message-input').focus()
}

function closeChat() {
  chatNumber = null
  chatLastIncomingAt = null
  document.getElementById('chat-view').classList.add('hidden')
  document.getElementById('cloud-content-area').classList.remove('hidden')
}

async function loadChatMessages() {
  const [sentRes, incomingRes] = await Promise.all([
    db.from('sent_messages').select('*').eq('recipient_number', chatNumber).order('created_at', { ascending: true }),
    db.from('incoming_messages').select('*').eq('sender_number', chatNumber).order('received_at', { ascending: true }),
  ])

  const sent = (sentRes.data || []).map(m => ({ ...m, _dir: 'out', _at: m.created_at }))
  const incoming = (incomingRes.data || []).map(m => ({ ...m, _dir: 'in', _at: m.received_at }))
  const merged = [...sent, ...incoming].sort((a, b) => new Date(a._at) - new Date(b._at))

  chatLastIncomingAt = incoming.length ? incoming[incoming.length - 1].received_at : null
  updateChatWindowStatus()

  const list = document.getElementById('chat-messages')
  list.innerHTML = ''
  if (!merged.length) {
    list.innerHTML = '<p class="empty-state-inline">Nenhuma mensagem trocada com este contato ainda.</p>'
  } else {
    merged.forEach(m => list.appendChild(buildChatBubbleEl(m)))
  }
  list.scrollTop = list.scrollHeight
}

function buildChatBubbleEl(m) {
  const div = document.createElement('div')
  div.className = `chat-bubble ${m._dir === 'out' ? 'chat-bubble-out' : 'chat-bubble-in'}`
  div.innerHTML = `
    <p class="chat-bubble-text">${esc(m.message_body || '(mídia sem texto)')}</p>
    <span class="chat-bubble-time">${fmt(m._at)}</span>
  `
  return div
}

function appendChatMessage(msg, dir) {
  const list = document.getElementById('chat-messages')
  const emptyEl = list.querySelector('.empty-state-inline')
  if (emptyEl) list.innerHTML = ''
  const at = dir === 'out' ? msg.created_at : msg.received_at
  list.appendChild(buildChatBubbleEl({ ...msg, _dir: dir, _at: at }))
  list.scrollTop = list.scrollHeight
}

function updateChatWindowStatus() {
  const statusEl = document.getElementById('chat-window-status')
  const banner = document.getElementById('chat-window-closed-banner')
  const sendBtn = document.getElementById('chat-send-btn')
  const input = document.getElementById('chat-message-input')

  const msSinceLastIncoming = chatLastIncomingAt ? Date.now() - new Date(chatLastIncomingAt).getTime() : Infinity
  const withinWindow = msSinceLastIncoming < TWENTY_FOUR_HOURS_MS

  if (withinWindow) {
    const hoursLeft = (TWENTY_FOUR_HOURS_MS - msSinceLastIncoming) / 3600000
    statusEl.textContent = `Janela de 24h aberta — ${hoursLeft.toFixed(1)}h restantes`
    statusEl.style.color = 'var(--primary)'
    banner.classList.add('hidden')
    sendBtn.disabled = false
    input.disabled = false
  } else {
    statusEl.textContent = 'Janela de 24h encerrada'
    statusEl.style.color = 'var(--status-failed)'
    banner.classList.remove('hidden')
    sendBtn.disabled = true
    input.disabled = true
  }
}

document.getElementById('chat-send-form').addEventListener('submit', async (e) => {
  e.preventDefault()

  const input = document.getElementById('chat-message-input')
  const message = input.value.trim()
  if (!message || !chatNumber) return

  const phoneNumberId = document.getElementById('phone-id-input').value.trim()
  const token = document.getElementById('token-input').value.trim()
  if (!phoneNumberId || !token) {
    alert('Configure o Phone Number ID e o Bearer Token no formulário de disparo antes de responder.')
    return
  }

  const sendBtn = document.getElementById('chat-send-btn')
  sendBtn.disabled = true
  input.disabled = true

  try {
    const res = await fetch('/api/send', {
      method: 'POST',
      headers: await authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ numbers: [chatNumber], message, phoneNumberId, token }),
    })
    const results = await res.json().catch(() => null)
    const result = Array.isArray(results) ? results[0] : null

    if (!res.ok || !result || result.status !== 'ok') {
      const errMsg = result?.data?.error?.message || 'Erro ao enviar mensagem.'
      alert(errMsg)
      return
    }

    input.value = ''
    // A linha aparece no chat via INSERT em tempo real de sent_messages.
  } catch (err) {
    alert('Erro de rede: ' + err.message)
  } finally {
    sendBtn.disabled = false
    input.disabled = false
    input.focus()
  }
})

/* ══════════════════════════════════════════════════════════════════════════
   Evolution API (WhatsApp não-oficial)
   ══════════════════════════════════════════════════════════════════════════ */

let evoAbortSend = false

// ── Credentials (baseUrl + apiKey + instanceName + senderNumber + anti-ban) ──
function loadEvolutionCredentials() {
  try {
    const saved = JSON.parse(localStorage.getItem(EVOLUTION_CREDENTIALS_KEY) || '{}')
    if (saved.baseUrl)      document.getElementById('evo-base-url-input').value = saved.baseUrl
    if (saved.apiKey)       document.getElementById('evo-api-key-input').value = saved.apiKey
    if (saved.instanceName) document.getElementById('evo-instance-input').value = saved.instanceName
    if (saved.senderNumber) document.getElementById('evo-sender-input').value = saved.senderNumber
    if (saved.minDelay)     document.getElementById('evo-min-delay-input').value = saved.minDelay
    if (saved.maxDelay)     document.getElementById('evo-max-delay-input').value = saved.maxDelay
    if (typeof saved.shuffle === 'boolean')   document.getElementById('evo-shuffle-checkbox').checked = saved.shuffle
    if (typeof saved.variation === 'boolean') document.getElementById('evo-variation-checkbox').checked = saved.variation
    if (saved.instanceName) document.getElementById('evo-instance-name-display').textContent = saved.instanceName
  } catch (err) {
    console.error('Failed to load saved Evolution credentials:', err)
  }
}

function getEvolutionSettings() {
  return {
    baseUrl: document.getElementById('evo-base-url-input').value.trim(),
    apiKey: document.getElementById('evo-api-key-input').value.trim(),
    instanceName: document.getElementById('evo-instance-input').value.trim(),
    senderNumber: document.getElementById('evo-sender-input').value.trim(),
    minDelay: parseInt(document.getElementById('evo-min-delay-input').value, 10) || 6,
    maxDelay: parseInt(document.getElementById('evo-max-delay-input').value, 10) || 15,
    shuffle: document.getElementById('evo-shuffle-checkbox').checked,
    variation: document.getElementById('evo-variation-checkbox').checked,
  }
}

function saveEvolutionSettings(settings) {
  localStorage.setItem(EVOLUTION_CREDENTIALS_KEY, JSON.stringify(settings))
}

document.getElementById('evo-credentials-form').addEventListener('submit', (e) => {
  e.preventDefault()
  const settings = getEvolutionSettings()
  saveEvolutionSettings(settings)
  document.getElementById('evo-instance-name-display').textContent = settings.instanceName || '—'
  checkEvolutionStatus()
})

// ── Instance Status ──────────────────────────────────────────────────────────
async function checkEvolutionStatus() {
  const { baseUrl, apiKey, instanceName } = getEvolutionSettings()
  const badge = document.getElementById('evo-instance-badge')
  const errorBox = document.getElementById('evo-status-error')

  if (!baseUrl || !apiKey || !instanceName) {
    setEvoBadge('connecting', 'Preencha as credenciais')
    return
  }

  setEvoBadge('connecting', 'Verificando...')
  errorBox.classList.add('hidden')

  try {
    const res = await fetch('/api/evolution-status', {
      method: 'POST',
      headers: await authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ baseUrl, apiKey, instanceName }),
    })
    const data = await res.json()

    document.getElementById('evo-last-check').textContent = new Date().toLocaleTimeString('pt-BR')

    if (!data.ok) {
      setEvoBadge('error', 'Erro ao verificar')
      errorBox.textContent = data.error?.message || 'Não foi possível verificar o status da instância.'
      errorBox.classList.remove('hidden')
      return
    }

    document.getElementById('evo-instance-name-display').textContent = data.instanceName || instanceName

    if (data.state === 'open') {
      setEvoBadge('connected', 'Conectado')
    } else if (data.state === 'connecting') {
      setEvoBadge('connecting', 'Conectando...')
    } else if (data.state === 'close') {
      setEvoBadge('error', 'Desconectado')
    } else {
      // Estado não reconhecido: mostra o valor bruto em vez de assumir "Desconectado" às cegas.
      setEvoBadge('error', `Desconectado (estado: "${data.state}")`)
      errorBox.textContent = `Resposta bruta da Evolution API: ${JSON.stringify(data.raw)}`
      errorBox.classList.remove('hidden')
    }
  } catch (err) {
    setEvoBadge('error', 'Falha na conexão')
    errorBox.textContent = 'Erro de rede ao consultar o status da instância: ' + err.message
    errorBox.classList.remove('hidden')
  }
}

function setEvoBadge(state, label) {
  const el = document.getElementById('evo-instance-badge')
  el.className = 'connection-badge large ' + state
  el.querySelector('.status-text').textContent = label
}

document.getElementById('evo-refresh-status-btn').addEventListener('click', checkEvolutionStatus)

// ── Realtime Subscriptions ───────────────────────────────────────────────────
function subscribeEvolutionRealtime() {
  db.channel('wa-disparador-evolution')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'evolution_incoming_messages' }, (p) => {
      clearEmpty('evo-incoming-list')
      prepend('evo-incoming-list', buildIncomingEl(p.new))
      bumpStat('stat-evo-received')
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'evolution_status_updates' }, (p) => {
      clearEmpty('evo-status-list')
      prepend('evo-status-list', buildStatusEl(p.new))
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'evolution_sent_messages' }, (p) => {
      clearEmpty('evo-sent-list')
      prepend('evo-sent-list', buildEvoSentEl(p.new))
      bumpStat('stat-evo-sent')
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'evolution_sent_messages' }, (p) => {
      patchEvoSentRow(p.new)
      if (p.new.status === 'delivered') bumpStat('stat-evo-delivered')
      if (p.new.status === 'read')      bumpStat('stat-evo-read')
    })
    .subscribe()
}

async function loadEvolutionInitialData() {
  const [sentRes, incomingRes, statusRes] = await Promise.all([
    db.from('evolution_sent_messages').select('*').order('created_at', { ascending: false }).limit(50),
    db.from('evolution_incoming_messages').select('*').order('received_at', { ascending: false }).limit(50),
    db.from('evolution_status_updates').select('*').order('received_at', { ascending: false }).limit(50),
  ])

  if (sentRes.data?.length)     renderList('evo-sent-list', sentRes.data, buildEvoSentEl)
  if (incomingRes.data?.length) renderList('evo-incoming-list', incomingRes.data, buildIncomingEl)
  if (statusRes.data?.length)   renderList('evo-status-list', statusRes.data, buildStatusEl)

  await refreshEvolutionStats()
}

async function refreshEvolutionStats() {
  const [sentRes, receivedRes, deliveredRes, readRes] = await Promise.all([
    db.from('evolution_sent_messages').select('*', { count: 'exact', head: true }),
    db.from('evolution_incoming_messages').select('*', { count: 'exact', head: true }),
    db.from('evolution_sent_messages').select('*', { count: 'exact', head: true }).eq('status', 'delivered'),
    db.from('evolution_sent_messages').select('*', { count: 'exact', head: true }).eq('status', 'read'),
  ])
  document.getElementById('stat-evo-sent').textContent      = sentRes.count      ?? 0
  document.getElementById('stat-evo-received').textContent  = receivedRes.count  ?? 0
  document.getElementById('stat-evo-delivered').textContent = deliveredRes.count ?? 0
  document.getElementById('stat-evo-read').textContent      = readRes.count      ?? 0
}

function buildEvoSentEl(msg) {
  const div = document.createElement('div')
  div.className = 'message-item'
  div.dataset.waId = msg.id
  div.innerHTML = `
    <div class="message-header">
      <span class="message-to">${esc(msg.recipient_number)}</span>
      ${statusBadge(msg.status)}
    </div>
    <p class="message-body">${esc(msg.message_body)}</p>
    <span class="message-time">${fmt(msg.created_at)}</span>
  `
  return div
}

function patchEvoSentRow(msg) {
  const row = document.querySelector(`#evo-sent-list [data-wa-id="${msg.id}"]`)
  if (!row) return
  const badge = row.querySelector('.status-badge')
  if (badge) {
    badge.className = `status-badge status-${msg.status}`
    const labels = { pending: 'Pendente', sent: 'Enviado', delivered: 'Entregue', read: 'Lido', failed: 'Falhou' }
    badge.textContent = labels[msg.status] || msg.status
  }
}

// ── Anti-ban helpers: spintax + variação invisível + embaralhamento ──────────
function resolveSpintax(text) {
  return text.replace(/\{([^{}]+)\}/g, (_, options) => {
    const choices = options.split('|')
    return choices[Math.floor(Math.random() * choices.length)]
  })
}

function applyInvisibleVariation(text) {
  const zeroWidthSpace = '​'
  const words = text.split(' ')
  if (words.length < 2) return text + zeroWidthSpace
  const pos = 1 + Math.floor(Math.random() * (words.length - 1))
  words[pos] = zeroWidthSpace + words[pos]
  return words.join(' ')
}

function shuffleArray(arr) {
  const copy = [...arr]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

function randomDelayMs(minSec, maxSec) {
  const min = Math.min(minSec, maxSec)
  const max = Math.max(minSec, maxSec)
  return (min + Math.random() * (max - min)) * 1000
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── Evolution Send Form ───────────────────────────────────────────────────────
document.getElementById('evo-send-form').addEventListener('submit', async (e) => {
  e.preventDefault()

  const settings = getEvolutionSettings()
  const { baseUrl, apiKey, instanceName, senderNumber, minDelay, maxDelay, shuffle, variation } = settings
  const message = document.getElementById('evo-message-input').value.trim()
  const numbersRaw = document.getElementById('evo-numbers-input').value
  let numbers = numbersRaw.split(',').map(n => n.trim()).filter(Boolean)

  if (!baseUrl || !apiKey || !instanceName || !senderNumber) {
    alert('Preencha as credenciais da Evolution API antes de enviar.')
    return
  }
  if (!message || numbers.length === 0) return

  if (numbers.length > 50) {
    alert('Máximo de 50 números por disparo. Divida sua lista em lotes menores para reduzir o risco de bloqueio.')
    return
  }

  saveEvolutionSettings(settings)

  if (shuffle) numbers = shuffleArray(numbers)

  const btn = document.getElementById('evo-send-btn')
  const stopBtn = document.getElementById('evo-stop-btn')
  const resultsEl = document.getElementById('evo-send-results')
  const progressEl = document.getElementById('evo-send-progress')

  btn.disabled = true
  stopBtn.classList.remove('hidden')
  evoAbortSend = false
  resultsEl.innerHTML = ''
  resultsEl.classList.remove('hidden')
  progressEl.classList.remove('hidden')

  for (let i = 0; i < numbers.length; i++) {
    if (evoAbortSend) {
      progressEl.textContent = `Envio interrompido em ${i} de ${numbers.length}.`
      break
    }

    const number = numbers[i]
    let finalMessage = resolveSpintax(message)
    if (variation) finalMessage = applyInvisibleVariation(finalMessage)
    const typingDelayMs = Math.min(4000, finalMessage.length * 40)

    progressEl.textContent = `Enviando ${i + 1} de ${numbers.length}...`

    try {
      const res = await fetch('/api/evolution-send', {
        method: 'POST',
        headers: await authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          baseUrl, apiKey, instanceName, senderNumber,
          number, message: finalMessage, typingDelayMs,
        }),
      })
      const result = await res.json()
      appendEvoResult(resultsEl, result)
    } catch (err) {
      appendEvoResult(resultsEl, { to: number, status: 'error', error: { message: 'Erro de rede: ' + err.message } })
    }

    if (i < numbers.length - 1 && !evoAbortSend) {
      const delayMs = randomDelayMs(minDelay, maxDelay)
      progressEl.textContent = `Enviado ${i + 1} de ${numbers.length}. Aguardando ${(delayMs / 1000).toFixed(1)}s antes do próximo...`
      await sleep(delayMs)
    }
  }

  if (!evoAbortSend) progressEl.textContent = `Concluído: ${numbers.length} de ${numbers.length} processados.`

  btn.disabled = false
  stopBtn.classList.add('hidden')
})

document.getElementById('evo-stop-btn').addEventListener('click', () => {
  evoAbortSend = true
})

function appendEvoResult(container, r) {
  const isOk = r.status === 'ok'
  const errMsg = !isOk ? (r.error?.message || 'Erro desconhecido ao enviar.') : ''
  const div = document.createElement('div')
  div.className = `result-item ${isOk ? 'result-ok' : 'result-error'}`
  div.innerHTML = `
    <div class="result-header">
      <span>${esc(r.to)}</span>
      <span class="status-badge ${isOk ? 'status-sent' : 'status-failed'}">${isOk ? 'Enviado' : 'Erro'}</span>
    </div>
    ${!isOk ? `<p class="result-error-msg">${esc(errMsg)}</p>` : ''}
  `
  container.appendChild(div)
}
