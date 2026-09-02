const { normalizeBaseUrl, describeEvolutionError, getSupabase } = require('./_evolution-lib')
const { requireUser } = require('./_auth')

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const user = await requireUser(req, res)
  if (!user) return

  const { baseUrl, apiKey, instanceName } = req.body || {}

  if (!baseUrl || !apiKey || !instanceName) {
    return res.status(400).json({ error: 'baseUrl, apiKey e instanceName são obrigatórios' })
  }

  // Registra o dono da instância já na verificação de status, para que as
  // mensagens recebidas sejam atribuídas mesmo antes do primeiro envio.
  try {
    await getSupabase().from('evolution_instances').upsert(
      { instance_name: instanceName, user_id: user.id, updated_at: new Date().toISOString() },
      { onConflict: 'instance_name' }
    )
  } catch (mapErr) {
    console.error('evolution_instances upsert error:', mapErr)
  }

  const url = `${normalizeBaseUrl(baseUrl)}/instance/connectionState/${encodeURIComponent(instanceName)}`

  try {
    const evoRes = await fetch(url, {
      method: 'GET',
      headers: { apikey: apiKey },
    })

    if (!evoRes.ok) {
      const friendly = await describeEvolutionError(null, evoRes)
      return res.status(200).json({ ok: false, error: friendly })
    }

    const data = await evoRes.json()
    const rawState =
      data?.instance?.state ??
      data?.state ??
      data?.instance?.connectionStatus ??
      data?.connectionStatus ??
      data?.instance?.status ??
      'unknown'
    const state = String(rawState).toLowerCase()

    return res.status(200).json({
      ok: true,
      state,
      instanceName: data?.instance?.instanceName || instanceName,
      raw: data,
    })
  } catch (err) {
    const friendly = await describeEvolutionError(err)
    return res.status(200).json({ ok: false, error: friendly })
  }
}
