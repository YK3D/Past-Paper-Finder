const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { rating, feedback, ts, token } = req.body || {};
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Invalid rating' });

  // Get user_id from token if provided
  let userId = null;
  if (token && SUPABASE_URL) {
    try {
      const r = await fetch(SUPABASE_URL + '/rest/v1/sessions?token=eq.' + token + '&select=user_id,expires_at', {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
      });
      const sessions = await r.json();
      if (sessions && sessions[0] && new Date(sessions[0].expires_at) > new Date()) {
        userId = sessions[0].user_id;
      }
    } catch {}
  }

  // Save to Supabase
  if (SUPABASE_URL) {
    try {
      await fetch(SUPABASE_URL + '/rest/v1/ratings', {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          user_id: userId,
          stars: Number(rating),
          feedback: (feedback || '').slice(0, 150),
          ip: req.headers['x-forwarded-for'] || 'unknown'
        })
      });
    } catch {}
  }

  // Also log to Vercel console
  console.log(JSON.stringify({
    event: 'rating', stars: Number(rating),
    feedback: (feedback || '').slice(0, 150),
    timestamp: new Date(ts || Date.now()).toISOString()
  }));

  return res.status(200).json({ ok: true });
}
