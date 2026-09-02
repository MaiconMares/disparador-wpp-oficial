// Returns public Supabase credentials to the frontend.
// SUPABASE_URL and SUPABASE_ANON_KEY are intentionally public (protected by RLS).
// Private keys (WHATSAPP_TOKEN, SUPABASE_SERVICE_ROLE_KEY) are never returned here.
module.exports = (req, res) => {
  res.status(200).json({
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  })
}
