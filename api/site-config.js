import { timingSafeEqual } from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
// Admin actions need the ADMIN_SECRET env var, sent as the x-admin-key header.
function isAdmin(req) {
  const secret = process.env.ADMIN_SECRET;
  const given = req.headers['x-admin-key'];
  if (!secret || typeof given !== 'string') return false;
  const a = Buffer.from(secret), b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    if (!SUPABASE_URL) return res.status(200).json({});
    try {
      const r = await fetch(SUPABASE_URL + '/rest/v1/site_config?select=key,value,enabled', {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
      });
      const rows = await r.json();
      const cfg = {};
      // Only include rows where enabled = true
      if (Array.isArray(rows)) rows.forEach(row => {
        if (row.enabled !== false) cfg[row.key] = row.value;
      });
      return res.status(200).json(cfg);
    } catch { return res.status(200).json({}); }
  }

  // POST — update a config value or toggle enabled
  if (req.method === 'POST') {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
    const { key, value, enabled } = req.body || {};
    if (!key) return res.status(400).json({ error: 'Missing key' });
    const patch = { updated_at: new Date().toISOString() };
    if (value !== undefined) patch.value = value;
    if (enabled !== undefined) patch.enabled = enabled;
    try {
      const r = await fetch(SUPABASE_URL + '/rest/v1/site_config?key=eq.' + encodeURIComponent(key), {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify(patch)
      });
      if (!r.ok) return res.status(502).json({ error: 'Update failed: ' + r.status });
      return res.status(200).json({ ok: true });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(405).end();
}
