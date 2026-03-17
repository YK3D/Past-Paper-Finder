const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    if (!SUPABASE_URL) return res.status(200).json({});
    try {
      const r = await fetch(SUPABASE_URL + '/rest/v1/site_config?select=key,value', {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
      });
      const rows = await r.json();
      const cfg = {};
      if (Array.isArray(rows)) rows.forEach(row => { cfg[row.key] = row.value; });
      return res.status(200).json(cfg);
    } catch { return res.status(200).json({}); }
  }

  // POST — update a config value (admin only — no auth for now, protect by keeping URL secret)
  if (req.method === 'POST') {
    const { key, value } = req.body || {};
    if (!key || value === undefined) return res.status(400).json({ error: 'Missing key or value' });
    try {
      await fetch(SUPABASE_URL + '/rest/v1/site_config?key=eq.' + key, {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ value, updated_at: new Date().toISOString() })
      });
      return res.status(200).json({ ok: true });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(405).end();
}
