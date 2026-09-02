const { getSupabase, normalizeDeliveryStatus } = require('./_evolution-lib')

// A Evolution API (baseada no Baileys) varia levemente o formato do payload
// entre versões/forks. As funções abaixo tentam múltiplos caminhos comuns e
// nunca lançam erro — o payload bruto é sempre salvo em raw_payload para
// consulta manual, mesmo quando a extração automática não reconhece o formato.

function jidToNumber(jid) {
  if (!jid || typeof jid !== 'string') return null
  return jid.split('@')[0].split(':')[0] || null
}

function extractMessageText(msg) {
  if (!msg) return null
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    msg.buttonsResponseMessage?.selectedDisplayText ||
    msg.listResponseMessage?.title ||
    null
  )
}

function extractMessageType(data) {
  if (data?.messageType) return data.messageType
  const msg = data?.message
  if (!msg) return 'unknown'
  const keys = Object.keys(msg)
  return keys[0] || 'unknown'
}

async function handleUpsert(supabase, instanceName, data, ownerId) {
  const items = Array.isArray(data) ? data : [data]

  for (const item of items) {
    if (!item || item.key?.fromMe) continue // ignora eco de mensagens que a própria instância enviou

    try {
      await supabase.from('evolution_incoming_messages').insert({
        user_id: ownerId,
        wa_message_id: item.key?.id || null,
        instance_name: instanceName || null,
        sender_number: jidToNumber(item.key?.remoteJid) || item.pushName || 'desconhecido',
        message_type: extractMessageType(item),
        message_body: extractMessageText(item.message) || null,
        raw_payload: item,
      })
    } catch (err) {
      console.error('evolution_incoming_messages insert error:', err.message)
    }
  }
}

async function handleUpdate(supabase, instanceName, data, ownerId) {
  const items = Array.isArray(data) ? data : [data]

  for (const item of items) {
    if (!item) continue
    const waMessageId = item.keyId || item.key?.id || item.id
    const recipientNumber = jidToNumber(item.remoteJid || item.key?.remoteJid)
    const rawStatus = item.status ?? item.update?.status
    const status = normalizeDeliveryStatus(rawStatus)

    if (!waMessageId) continue

    // A linha enviada já tem dono — herda dela; senão usa o mapa da instância.
    let statusOwnerId = ownerId
    try {
      const { data: sent } = await supabase
        .from('evolution_sent_messages')
        .select('user_id')
        .eq('wa_message_id', waMessageId)
        .maybeSingle()
      if (sent?.user_id) statusOwnerId = sent.user_id
    } catch (err) {
      console.error('evolution_sent_messages owner lookup error:', err.message)
    }

    try {
      await supabase.from('evolution_status_updates').insert({
        user_id: statusOwnerId,
        wa_message_id: waMessageId,
        instance_name: instanceName || null,
        recipient_number: recipientNumber,
        status,
        raw_payload: item,
      })
    } catch (err) {
      console.error('evolution_status_updates insert error:', err.message)
    }

    try {
      await supabase
        .from('evolution_sent_messages')
        .update({ status })
        .eq('wa_message_id', waMessageId)
    } catch (err) {
      console.error('evolution_sent_messages update error:', err.message)
    }
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed')
  }

  try {
    const body = req.body || {}
    const eventName = String(body.event || body.Event || '').toLowerCase().replace(/[_\s]/g, '.')
    const instanceName = body.instance || body.instanceName || null
    const data = body.data ?? body.Data ?? null

    const supabase = getSupabase()

    // Dono da instância (mapa preenchido pelas rotas /api/evolution-send e
    // /api/evolution-status). Sem dono conhecido, as linhas ficam com user_id
    // nulo e não aparecem para ninguém até o mapa ser preenchido.
    let ownerId = null
    if (instanceName) {
      try {
        const { data: map } = await supabase
          .from('evolution_instances')
          .select('user_id')
          .eq('instance_name', instanceName)
          .maybeSingle()
        ownerId = map?.user_id || null
      } catch (err) {
        console.error('evolution_instances lookup error:', err.message)
      }
    }

    if (eventName.includes('messages.upsert') && data) {
      await handleUpsert(supabase, instanceName, data, ownerId)
    } else if (eventName.includes('messages.update') && data) {
      await handleUpdate(supabase, instanceName, data, ownerId)
    }
    // Outros eventos (connection.update, qrcode.updated, etc.) são ignorados
    // pelo painel por enquanto, mas nunca causam erro de processamento.
  } catch (err) {
    console.error('Evolution webhook processing error:', err.message)
  }

  return res.status(200).json({ status: 'ok' })
}
