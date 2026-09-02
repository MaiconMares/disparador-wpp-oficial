const { createClient } = require('@supabase/supabase-js')
const { requireUser } = require('./_auth')

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const user = await requireUser(req, res)
  if (!user) return

  const { message, template, numbers, token: tokenOverride, phoneNumberId: phoneNumberIdOverride } = req.body || {}

  if (!Array.isArray(numbers) || numbers.length === 0 || (!message && !template)) {
    return res.status(400).json({ error: 'numbers (string[]) e message ou template são obrigatórios' })
  }

  const token = tokenOverride || process.env.WHATSAPP_TOKEN
  const phoneNumberId = phoneNumberIdOverride || process.env.PHONE_NUMBER_ID

  if (!token || !phoneNumberId) {
    return res.status(400).json({ error: 'Bearer token e Phone Number ID são obrigatórios (informe no painel ou configure WHATSAPP_TOKEN/PHONE_NUMBER_ID)' })
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )

  // Registra qual usuário é dono deste Phone Number ID — os webhooks usam esse
  // mapa para atribuir as mensagens recebidas ao dono correto.
  try {
    await supabase.from('whatsapp_numbers').upsert(
      { phone_number_id: String(phoneNumberId), user_id: user.id, updated_at: new Date().toISOString() },
      { onConflict: 'phone_number_id' }
    )
  } catch (mapErr) {
    console.error('whatsapp_numbers upsert error:', mapErr)
  }

  const isTemplate = !!template
  const displayBody = message || `[Modelo: ${template?.name}]`

  const sendToNumber = async (to) => {
    const cleaned = to.trim()
    try {
      const metaRes = await fetch(
        `https://graph.facebook.com/v25.0/${phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(
            isTemplate
              ? { messaging_product: 'whatsapp', to: cleaned, type: 'template', template }
              : { messaging_product: 'whatsapp', to: cleaned, type: 'text', text: { body: message } }
          ),
        }
      )

      const data = await metaRes.json()
      const waMessageId = data.messages?.[0]?.id || null

      try {
        await supabase.from('sent_messages').insert({
          user_id: user.id,
          wa_message_id: waMessageId,
          recipient_number: cleaned,
          message_body: displayBody,
          status: metaRes.ok ? 'pending' : 'failed',
          raw_response: data,
        })
      } catch (dbErr) {
        console.error('Supabase insert error for', cleaned, dbErr)
      }

      return {
        to: cleaned,
        status: metaRes.ok ? 'ok' : 'error',
        data,
      }
    } catch (err) {
      return {
        to: cleaned,
        status: 'error',
        data: { error: { message: err.message } },
      }
    }
  }

  const results = await Promise.all(numbers.map(sendToNumber))
  res.status(200).json(results)
}
