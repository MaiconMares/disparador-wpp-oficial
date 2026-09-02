// Funções compartilhadas pelas rotas /api/evolution-*.
// Prefixo "_" impede que a Vercel trate este arquivo como uma rota.
const { createClient } = require('@supabase/supabase-js')

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

// Remove barra final para evitar URLs tipo "https://host//message/..."
function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '')
}

// Traduz erros de rede/HTTP em mensagens claras para o painel.
async function describeEvolutionError(err, response) {
  if (response) {
    const status = response.status
    let body = null
    try { body = await response.json() } catch (_) { /* corpo não é JSON */ }
    const rawMsg = body?.response?.message ?? body?.message ?? body?.error?.message ?? null
    const apiMsg = Array.isArray(rawMsg) ? rawMsg.join(', ') : rawMsg

    if (status === 401) return { code: 'unauthorized', message: 'API Key inválida ou ausente. Verifique a credencial informada.' }
    if (status === 403) return { code: 'forbidden', message: 'Permissão negada pela Evolution API para esta ação.' }
    if (status === 404) return { code: 'not_found', message: `Instância não encontrada. Confira o nome da instância e a URL base.${apiMsg ? ' (' + apiMsg + ')' : ''}` }
    if (status === 400) return { code: 'bad_request', message: `Requisição inválida.${apiMsg ? ' ' + apiMsg : ' Confira os campos preenchidos.'}` }
    if (status >= 500) return { code: 'server_error', message: 'A Evolution API retornou um erro interno. Tente novamente em instantes.' }
    return { code: 'http_error', message: apiMsg || `A Evolution API respondeu com status ${status}.`, raw: body }
  }

  if (err?.cause?.code === 'ECONNREFUSED' || err?.code === 'ECONNREFUSED') {
    return { code: 'connection_refused', message: 'Conexão recusada. Verifique se a URL base da Evolution API está correta e acessível.' }
  }
  if (err?.name === 'AbortError' || err?.code === 'ETIMEDOUT') {
    return { code: 'timeout', message: 'A Evolution API demorou demais para responder (timeout).' }
  }
  if (err instanceof TypeError) {
    return { code: 'network_error', message: 'Não foi possível conectar à URL base informada. Confira o endereço (http/https) e sua disponibilidade.' }
  }
  return { code: 'unknown_error', message: err?.message || 'Erro desconhecido ao falar com a Evolution API.' }
}

// Normaliza status de entrega (numérico do Baileys ou string da Evolution API)
// para o vocabulário usado no painel: pending | sent | delivered | read | failed
function normalizeDeliveryStatus(raw) {
  if (raw === null || raw === undefined) return 'pending'
  const map = {
    0: 'failed', 1: 'pending', 2: 'sent', 3: 'delivered', 4: 'read', 5: 'read',
    ERROR: 'failed',
    PENDING: 'pending',
    SERVER_ACK: 'sent',
    DELIVERY_ACK: 'delivered',
    READ: 'read',
    PLAYED: 'read',
  }
  const key = typeof raw === 'string' ? raw.toUpperCase() : raw
  return map[key] || 'pending'
}

module.exports = { getSupabase, normalizeBaseUrl, describeEvolutionError, normalizeDeliveryStatus }
