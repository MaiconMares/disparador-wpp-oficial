// Verificação de sessão para as rotas /api/*.
// O frontend manda o access_token do Supabase no header Authorization: Bearer <jwt>.
// Prefixo "_" impede que a Vercel trate este arquivo como uma rota.
const { createClient } = require('@supabase/supabase-js')

function serviceClient() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

// Retorna o usuário autenticado ou null.
async function getUser(req) {
  const header = req.headers.authorization || req.headers.Authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null
  if (!token) return null

  try {
    const { data, error } = await serviceClient().auth.getUser(token)
    if (error || !data?.user) return null
    return data.user
  } catch (_) {
    return null
  }
}

// Helper de rota: garante sessão válida, senão responde 401 e retorna null.
async function requireUser(req, res) {
  const user = await getUser(req)
  if (!user) {
    res.status(401).json({ error: 'Não autenticado. Faça login novamente.' })
    return null
  }
  return user
}

module.exports = { getUser, requireUser, serviceClient }
