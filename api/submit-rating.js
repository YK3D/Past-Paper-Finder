const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

const H = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { rating, feedback, ts, token } = req.body || {};
  if (!rating || Number(rating) < 1 || Number(rating) > 5)
    return res.status(400).json({ error: 'Invalid rating' });

  // Look up username from sessions table
  let username = null;
  if (token) {
    try {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/sessions?token=eq.${encodeURIComponent(token)}&select=username,expires_at&limit=1`,
        { headers: H }
      );
      const rows = await r.json();
      if (Array.isArray(rows) && rows[0] && new Date(rows[0].expires_at) > new Date()) {
        username = rows[0].username;
      }
    } catch {}
  }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';

  // Insert into ratings
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/ratings`, {
      method: 'POST',
      headers: { ...H, 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        username:  username || null,
        stars:     Number(rating),
        feedback:  (feedback || '').slice(0, 150),
        ip,
        created_at: new Date().toISOString()
      })
    });
    if (!r.ok) {
      const err = await r.text();
      console.error('[submit-rating] insert failed:', r.status, err);
      return res.status(200).json({ ok: false, error: err });
    }
  } catch (e) {
    console.error('[submit-rating] exception:', e.message);
    return res.status(200).json({ ok: false, error: e.message });
  }

  console.log(JSON.stringify({
    event: 'rating', stars: Number(rating),
    username: username || 'guest',
    feedback: (feedback || '').slice(0, 150),
    timestamp: new Date(ts || Date.now()).toISOString()
  }));

  return res.status(200).json({ ok: true });
}
