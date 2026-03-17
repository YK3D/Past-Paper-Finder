// Handles: paper views, time tracking, favourites, leaderboard 

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

function db(path, method='GET', body) {
  return fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : ''
    },
    body: body ? JSON.stringify(body) : undefined
  }).then(r => r.json());
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
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers['x-session-token'] || req.body?.token;
  const userId = await getUserFromToken(token);
  const { action } = req.method === 'GET' ? req.query : (req.body || {});

  // ── Leaderboard (public, no auth needed) ──
  if (action === 'leaderboard_papers') {
    const rows = await db(
      'paper_views?select=user_id,users!inner(username)&limit=5000'
    );
    // Aggregate
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
    const rows = await db(
      'time_sessions?select=user_id,seconds,users!inner(username)&limit=10000'
    );
    const totals = {};
    if (Array.isArray(rows)) {
      for (const r of rows) {
        const uid = r.user_id;
        if (!totals[uid]) totals[uid] = { username: r.users?.username || 'Unknown', seconds: 0 };
        totals[uid].seconds += r.seconds || 0;
      }
    }
    const sorted = Object.entries(totals)
      .map(([id, v]) => ({ id, username: v.username, seconds: v.seconds }))
      .sort((a, b) => b.seconds - a.seconds);
    return res.status(200).json(sorted);
  }

  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  // ── Paper view ──
  if (action === 'view_paper' && req.method === 'POST') {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'No URL' });
    await db('paper_views', 'POST', { user_id: userId, paper_url: url });
    return res.status(200).json({ ok: true });
  }

  // ── Time tracking ──
  if (action === 'track_time' && req.method === 'POST') {
    const { seconds } = req.body;
    if (!seconds || seconds < 1) return res.status(400).json({ error: 'Invalid seconds' });
    await db('time_sessions', 'POST', { user_id: userId, seconds: Math.floor(seconds) });
    return res.status(200).json({ ok: true });
  }

  // ── Stats for current user ──
  if (action === 'my_stats') {
    const [views, time] = await Promise.all([
      db('paper_views?user_id=eq.' + userId + '&select=id'),
      db('time_sessions?user_id=eq.' + userId + '&select=seconds')
    ]);
    const totalViews = Array.isArray(views) ? views.length : 0;
    const totalSeconds = Array.isArray(time) ? time.reduce((s, r) => s + (r.seconds || 0), 0) : 0;
    return res.status(200).json({ views: totalViews, seconds: totalSeconds });
  }

  // ── Favourites ──
  if (action === 'get_favs') {
    const favs = await db('favourites?user_id=eq.' + userId + '&select=code,name&order=name');
    return res.status(200).json(Array.isArray(favs) ? favs : []);
  }

  if (action === 'add_fav' && req.method === 'POST') {
    const { code, name } = req.body;
    if (!code) return res.status(400).json({ error: 'No code' });
    await db('favourites', 'POST', { user_id: userId, code, name: name || code });
    return res.status(200).json({ ok: true });
  }

  if (action === 'remove_fav' && req.method === 'POST') {
    const { code } = req.body;
    await db('favourites?user_id=eq.' + userId + '&code=eq.' + code, 'DELETE');
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
