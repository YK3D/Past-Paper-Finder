const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

function db(path) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  }).then(r => r.json().catch(() => []));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { deviceId } = req.body || {};
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';

  if (!SUPABASE_URL) return res.status(200).json({ banned: false });

  // Check IP ban (active only)
  if (ip && ip !== 'unknown') {
    const rows = await db(`ban_list?type=eq.ip&value=eq.${encodeURIComponent(ip)}&active=eq.true&select=reason&limit=1`);
    if (rows?.[0]) return res.status(200).json({ banned: true, type: 'ip', reason: rows[0].reason || 'IP address banned' });
  }

  // Check device ban (active only)
  if (deviceId) {
    const rows = await db(`ban_list?type=eq.device&value=eq.${encodeURIComponent(deviceId)}&active=eq.true&select=reason&limit=1`);
    if (rows?.[0]) return res.status(200).json({ banned: true, type: 'device', reason: rows[0].reason || 'Device banned' });
  }

  return res.status(200).json({ banned: false });
}
