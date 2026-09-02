const { getSupabase, normalizeBaseUrl, describeEvolutionError } = require('./_evolution-lib')
const { requireUser } = require('./_auth')

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const user = await requireUser(req, res)
  if (!user) return

  const {
    baseUrl,
    apiKey,
    instanceName,
    senderNumber,
    number,
    message,
    linkPreview = false,
    typingDelayMs = 0,
  } = req.body || {}

  if (!baseUrl || !apiKey || !instanceName) {
    return res.status(400).json({ error: 'baseUrl, apiKey e instanceName são obrigatórios (informe no painel)' })
  }
  if (!number || !message) {
    return res.status(400).json({ error: 'number e message são obrigatórios' })
  }

  const cleaned = String(number).trim()
  const supabase = getSupabase()
  const url = `${normalizeBaseUrl(baseUrl)}/message/sendText/${encodeURIComponent(instanceName)}`

  // Registra qual usuário é dono desta instância — o webhook usa esse mapa para
  // atribuir as mensagens recebidas ao dono correto.
  try {
    await supabase.from('evolution_instances').upsert(
      { instance_name: instanceName, user_id: user.id, updated_at: new Date().toISOString() },
      { onConflict: 'instance_name' }
    )
  } catch (mapErr) {
    console.error('evolution_instances upsert error:', mapErr)
  }

  try {
    const evoRes = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        number: cleaned,
        text: message,
        delay: Math.max(0, Math.min(4000, Number(typingDelayMs) || 0)),
        linkPreview: !!linkPreview,
      }),
    })

    let data = null
    try { data = await evoRes.json() } catch (_) { /* resposta sem corpo JSON */ }

    const waMessageId = data?.key?.id || null
    const status = evoRes.ok ? 'pending' : 'failed'

    try {
      await supabase.from('evolution_sent_messages').insert({
        user_id: user.id,
        wa_message_id: waMessageId,
        instance_name: instanceName,
        sender_number: senderNumber || null,
        recipient_number: cleaned,
        message_body: message,
        status,
        raw_response: data,
      })
    } catch (dbErr) {
      console.error('Supabase insert error (evolution_sent_messages) for', cleaned, dbErr)
    }

    if (!evoRes.ok) {
      const friendly = await describeEvolutionError(null, { status: evoRes.status, json: async () => data })
      return res.status(200).json({ to: cleaned, status: 'error', error: friendly, data })
    }

    return res.status(200).json({ to: cleaned, status: 'ok', waMessageId, data })
  } catch (err) {
    const friendly = await describeEvolutionError(err)

    try {
      await supabase.from('evolution_sent_messages').insert({
        user_id: user.id,
        instance_name: instanceName,
        sender_number: senderNumber || null,
        recipient_number: cleaned,
        message_body: message,
        status: 'failed',
        raw_response: { error: friendly },
      })
    } catch (dbErr) {
      console.error('Supabase insert error (evolution_sent_messages) for', cleaned, dbErr)
    }

    return res.status(200).json({ to: cleaned, status: 'error', error: friendly })
  }
}

module.exports.config = { maxDuration: 60 }
