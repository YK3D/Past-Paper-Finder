const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

function db(path, method = 'GET', body, extraHeaders = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal',
      ...extraHeaders
    },
    body: body ? JSON.stringify(body) : undefined
  }).then(r => r.json().catch(() => ({})));
}

async function getUserFromToken(token) {
  if (!token) return null;
  const s = await db(`sessions?token=eq.${token}&select=user_id,expires_at`);
  if (!s?.[0]) return null;
  if (new Date(s[0].expires_at) < new Date()) return null;
  return s[0].user_id;
}

// Build leaderboard from raw rows, applying an optional period filter
function buildLeaderboard(rows, field, periodStart) {
  const agg = {};
  for (const r of rows) {
    if (!r.user_id || !r.users) continue;
    if (periodStart && r.created_at && new Date(r.created_at) < new Date(periodStart)) continue;
    // For time_sessions, use the date column for period filtering
    if (periodStart && r.date && new Date(r.date) < new Date(periodStart)) continue;
    const uid = r.user_id;
    if (!agg[uid]) agg[uid] = { username: r.users.username || 'Unknown', value: 0 };
    agg[uid].value += field === 'seconds' ? Math.round(r.seconds || 0) : 1;
  }
  return Object.entries(agg)
    .map(([id, v]) => ({ id, username: v.username, value: v.value }))
    .sort((a, b) => b.value - a.value);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-session-token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers['x-session-token'] || req.body?.token;
  const { action, periodStart } = req.method === 'GET' ? req.query : (req.body || {});

  // ── Leaderboard — papers ──
  if (action === 'leaderboard_papers') {
    const rows = await db('paper_views?select=user_id,created_at,users!inner(username)&limit=20000');
    const sorted = buildLeaderboard(Array.isArray(rows) ? rows : [], 'count', periodStart);
    return res.status(200).json(sorted.map(e => ({ ...e, count: e.value })));
  }

  // ── Leaderboard — time ──
  if (action === 'leaderboard_time') {
    const rows = await db('time_sessions?select=user_id,seconds,date,users!inner(username)&limit=50000');
    const sorted = buildLeaderboard(Array.isArray(rows) ? rows : [], 'seconds', periodStart);
    return res.status(200).json(sorted.map(e => ({ ...e, seconds: e.value })));
  }

  const userId = await getUserFromToken(token);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  // ── Paper view ──
  if (action === 'view_paper' && req.method === 'POST') {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'No URL' });
    await db('paper_views', 'POST', { user_id: userId, paper_url: url });
    return res.status(200).json({ ok: true });
  }

  // ── Time tracking — upsert one record per user per day ──
  if (action === 'track_time' && req.method === 'POST') {
    const secs = Math.round(req.body?.seconds || 0);
    if (secs < 1) return res.status(400).json({ error: 'Invalid seconds' });
    const today = new Date().toISOString().slice(0, 10);
    const existing = await db(`time_sessions?user_id=eq.${userId}&date=eq.${today}&select=id,seconds`);
    if (Array.isArray(existing) && existing[0]) {
      await db(`time_sessions?id=eq.${existing[0].id}`, 'PATCH', { seconds: Math.round(existing[0].seconds) + secs });
    } else {
      await db('time_sessions', 'POST', { user_id: userId, seconds: secs, date: today });
    }
    return res.status(200).json({ ok: true });
  }

  // ── My stats ──
  if (action === 'my_stats') {
    const [views, time] = await Promise.all([
      db(`paper_views?user_id=eq.${userId}&select=id`),
      db(`time_sessions?user_id=eq.${userId}&select=seconds`)
    ]);
    return res.status(200).json({
      views: Array.isArray(views) ? views.length : 0,
      seconds: Array.isArray(time) ? time.reduce((s, r) => s + Math.round(r.seconds || 0), 0) : 0
    });
  }

  // ── Favourites ──
  if (action === 'get_favs') {
    const favs = await db(`favourites?user_id=eq.${userId}&select=code,name&order=name`);
    return res.status(200).json(Array.isArray(favs) ? favs : []);
  }
  if (action === 'add_fav' && req.method === 'POST') {
    const { code, name } = req.body;
    if (!code) return res.status(400).json({ error: 'No code' });
    await db('favourites', 'POST', { user_id: userId, code, name: name || code },
      { 'Prefer': 'return=minimal,resolution=ignore-duplicates' });
    return res.status(200).json({ ok: true });
  }
  if (action === 'remove_fav' && req.method === 'POST') {
    const { code } = req.body;
    await db(`favourites?user_id=eq.${userId}&code=eq.${code}`, 'DELETE');
    return res.status(200).json({ ok: true });
  }

  // ── AI Chat history ──
  if (action === 'get_chat' && req.method === 'POST') {
    const { paperUrl } = req.body;
    if (!paperUrl) return res.status(400).json({ error: 'No paperUrl' });
    const rows = await db(`chat_history?user_id=eq.${userId}&paper_url=eq.${encodeURIComponent(paperUrl)}&select=messages&limit=1`);
    return res.status(200).json(rows?.[0] || { messages: [] });
  }
  if (action === 'save_chat' && req.method === 'POST') {
    const { paperUrl, messages } = req.body;
    if (!paperUrl || !messages) return res.status(400).json({ error: 'Missing fields' });
    const existing = await db(`chat_history?user_id=eq.${userId}&paper_url=eq.${encodeURIComponent(paperUrl)}&select=id`);
    if (existing?.[0]) {
      await db(`chat_history?id=eq.${existing[0].id}`, 'PATCH', { messages: JSON.stringify(messages), updated_at: new Date().toISOString() });
    } else {
      await db('chat_history', 'POST', { user_id: userId, paper_url: paperUrl, messages: JSON.stringify(messages) });
    }
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
