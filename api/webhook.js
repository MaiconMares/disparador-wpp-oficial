const { createClient } = require('@supabase/supabase-js')

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

module.exports = async (req, res) => {
  // ── GET: Meta webhook verification handshake ──────────────────────────────
  if (req.method === 'GET') {
    const mode = req.query['hub.mode']
    const token = req.query['hub.verify_token']
    const challenge = req.query['hub.challenge']

    if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
      return res.status(200).send(challenge)
    }
    return res.status(403).send('Forbidden')
  }

  // ── POST: Incoming webhook events ─────────────────────────────────────────
  if (req.method === 'POST') {
    // Process inserts, then acknowledge — all wrapped so a DB error never
    // prevents Meta from receiving the 200 it expects within 20 seconds.
    try {
      const value = req.body?.entry?.[0]?.changes?.[0]?.value

      if (value) {
        const supabase = getSupabase()

        // Descobre o dono deste número de negócio (Phone Number ID) para
        // atribuir as mensagens recebidas ao usuário correto.
        const phoneNumberId = value.metadata?.phone_number_id
          ? String(value.metadata.phone_number_id)
          : null
        let ownerId = null
        if (phoneNumberId) {
          try {
            const { data } = await supabase
              .from('whatsapp_numbers')
              .select('user_id')
              .eq('phone_number_id', phoneNumberId)
              .maybeSingle()
            ownerId = data?.user_id || null
          } catch (err) {
            console.error('whatsapp_numbers lookup error:', err.message)
          }
        }

        // Incoming messages from users
        if (value.messages) {
          for (const msg of value.messages) {
            try {
              await supabase.from('incoming_messages').insert({
                user_id: ownerId,
                wa_message_id: msg.id,
                sender_number: msg.from,
                message_type: msg.type,
                message_body:
                  msg.text?.body ||
                  msg.image?.caption ||
                  msg.video?.caption ||
                  msg.document?.caption ||
                  null,
                raw_payload: value,
              })
            } catch (err) {
              console.error('incoming_messages insert error:', err.message)
            }
          }
        }

        // Status callbacks (sent / delivered / read / failed)
        if (value.statuses) {
          for (const status of value.statuses) {
            // A linha enviada já tem dono — herda dele; senão usa o mapa do número.
            let statusOwnerId = ownerId
            try {
              const { data } = await supabase
                .from('sent_messages')
                .select('user_id')
                .eq('wa_message_id', status.id)
                .maybeSingle()
              if (data?.user_id) statusOwnerId = data.user_id
            } catch (err) {
              console.error('sent_messages owner lookup error:', err.message)
            }

            try {
              await supabase.from('message_status_updates').insert({
                user_id: statusOwnerId,
                wa_message_id: status.id,
                recipient_number: status.recipient_id,
                status: status.status,
                raw_payload: value,
              })
            } catch (err) {
              console.error('message_status_updates insert error:', err.message)
            }

            try {
              await supabase
                .from('sent_messages')
                .update({ status: status.status })
                .eq('wa_message_id', status.id)
            } catch (err) {
              console.error('sent_messages update error:', err.message)
            }
          }
        }
      }
    } catch (err) {
      console.error('Webhook processing error:', err.message)
    }

    return res.status(200).json({ status: 'ok' })
  }

  res.status(405).send('Method not allowed')
}
