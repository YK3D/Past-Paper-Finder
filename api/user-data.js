const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

function db(path, method = 'GET', body, extra = {}) {
  return fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal',
      ...extra
    },
    body: body ? JSON.stringify(body) : undefined
  }).then(r => r.json().catch(() => ({})));
}

async function getUserFromToken(token) {
  if (!token) return null;
  const sessions = await db('sessions?token=eq.' + token + '&select=user_id,expires_at');
  if (!sessions || !sessions[0]) return null;
  if (new Date(sessions[0].expires_at) < new Date()) return null;
  return sessions[0].user_id;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-session-token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers['x-session-token'] || req.body?.token;
  const { action } = req.method === 'GET' ? req.query : (req.body || {});

  // ── Public leaderboards ──
  if (action === 'leaderboard_papers') {
    const rows = await db('paper_views?select=user_id,users!inner(username)&limit=10000');
    const counts = {};
    if (Array.isArray(rows)) {
      for (const r of rows) {
        const uid = r.user_id;
        if (!counts[uid]) counts[uid] = { username: r.users?.username || 'Unknown', count: 0 };
        counts[uid].count++;
      }
    }
    const sorted = Object.entries(counts)
      .map(([id, v]) => ({ id, username: v.username, count: v.count }))
      .sort((a, b) => b.count - a.count);
    return res.status(200).json(sorted);
  }

  if (action === 'leaderboard_time') {
    const rows = await db('time_sessions?select=user_id,seconds,users!inner(username)&limit=50000');
    const totals = {};
    if (Array.isArray(rows)) {
      for (const r of rows) {
        const uid = r.user_id;
        if (!totals[uid]) totals[uid] = { username: r.users?.username || 'Unknown', seconds: 0 };
        totals[uid].seconds += Math.round(r.seconds || 0);
      }
    }
    const sorted = Object.entries(totals)
      .map(([id, v]) => ({ id, username: v.username, seconds: v.seconds }))
      .sort((a, b) => b.seconds - a.seconds);
    return res.status(200).json(sorted);
  }

  const userId = await getUserFromToken(token);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  if (action === 'view_paper' && req.method === 'POST') {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'No URL' });
    await db('paper_views', 'POST', { user_id: userId, paper_url: url });
    return res.status(200).json({ ok: true });
  }

  // ── Time tracking — upsert into a single daily row per user to avoid record explosion ──
  if (action === 'track_time' && req.method === 'POST') {
    const { seconds } = req.body;
    const secs = Math.round(seconds || 0);
    if (secs < 1) return res.status(400).json({ error: 'Invalid seconds' });

    // Use today's date as key — upsert to accumulate seconds in one record per user per day
    const today = new Date().toISOString().slice(0, 10); // "2026-03-17"

    // Try to find existing record for today
    const existing = await db('time_sessions?user_id=eq.' + userId + '&date=eq.' + today + '&select=id,seconds');
    if (Array.isArray(existing) && existing[0]) {
      const newTotal = Math.round(existing[0].seconds) + secs;
      await db('time_sessions?id=eq.' + existing[0].id, 'PATCH', { seconds: newTotal });
    } else {
      await db('time_sessions', 'POST', { user_id: userId, seconds: secs, date: today });
    }
    return res.status(200).json({ ok: true });
  }

  if (action === 'my_stats') {
    const [views, time] = await Promise.all([
      db('paper_views?user_id=eq.' + userId + '&select=id'),
      db('time_sessions?user_id=eq.' + userId + '&select=seconds')
    ]);
    const totalViews = Array.isArray(views) ? views.length : 0;
    const totalSeconds = Array.isArray(time) ? time.reduce((s, r) => s + Math.round(r.seconds || 0), 0) : 0;
    return res.status(200).json({ views: totalViews, seconds: totalSeconds });
  }

  if (action === 'get_favs') {
    const favs = await db('favourites?user_id=eq.' + userId + '&select=code,name&order=name');
    return res.status(200).json(Array.isArray(favs) ? favs : []);
  }

  if (action === 'add_fav' && req.method === 'POST') {
    const { code, name } = req.body;
    if (!code) return res.status(400).json({ error: 'No code' });
    await db('favourites', 'POST', { user_id: userId, code, name: name || code }, { 'Prefer': 'return=minimal,resolution=ignore-duplicates' });
    return res.status(200).json({ ok: true });
  }

  if (action === 'remove_fav' && req.method === 'POST') {
    const { code } = req.body;
    await db('favourites?user_id=eq.' + userId + '&code=eq.' + code, 'DELETE');
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
