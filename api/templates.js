// Lista os modelos (templates) de mensagem aprovados na conta Meta WhatsApp Business.
const { requireUser } = require('./_auth')

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const user = await requireUser(req, res)
  if (!user) return

  const { token, wabaId } = req.body || {}

  if (!token || !wabaId) {
    return res.status(400).json({ error: 'token e wabaId (WhatsApp Business Account ID) são obrigatórios' })
  }

  try {
    const metaRes = await fetch(
      `https://graph.facebook.com/v25.0/${wabaId}/message_templates?fields=name,language,category,status,components&limit=200`,
      { headers: { Authorization: `Bearer ${token}` } }
    )

    const data = await metaRes.json()

    if (!metaRes.ok) {
      const rawMsg = data.error?.message || data.error?.error_data?.details || 'Não foi possível buscar os modelos de mensagem.'

      const looksLikeWrongId = data.error?.code === 100 && /message_templates/i.test(rawMsg)
      const error = looksLikeWrongId
        ? `${rawMsg} — Este ID provavelmente não é o WhatsApp Business Account ID (WABA). O "business_id" da URL do Gestor de Modelos é o ID do Business Manager, que é diferente. Pegue o ID correto em developers.facebook.com → seu App → WhatsApp → Configuração da API, no campo "ID da conta comercial do WhatsApp" (ao lado do Phone Number ID).`
        : rawMsg

      return res.status(200).json({ ok: false, error })
    }

    const templates = (data.data || []).map((t) => ({
      name: t.name,
      language: t.language,
      category: t.category,
      status: t.status,
      components: t.components || [],
    }))

    return res.status(200).json({ ok: true, templates })
  } catch (err) {
    return res.status(200).json({ ok: false, error: 'Erro de rede ao buscar modelos: ' + err.message })
  }
}
