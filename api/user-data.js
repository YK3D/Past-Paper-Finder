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

// Build leaderboard from paper_views rows + users lookup
async function buildPapersLeaderboard(periodStart) {
  // Get all paper views
  const rows = await db('paper_views?select=user_id,created_at&limit=50000');
  if (!Array.isArray(rows) || !rows.length) return [];

  // Filter by period
  const filtered = rows.filter(r => {
    if (!r.user_id) return false;
    if (periodStart && r.created_at && new Date(r.created_at) < new Date(periodStart)) return false;
    return true;
  });

  // Aggregate counts per user_id
  const counts = {};
  for (const r of filtered) {
    counts[r.user_id] = (counts[r.user_id] || 0) + 1;
  }
  if (!Object.keys(counts).length) return [];

  // Get usernames for those user IDs
  const ids = Object.keys(counts);
  const users = await db(`users?id=in.(${ids.join(',')})&select=id,username`);
  const userMap = {};
  if (Array.isArray(users)) users.forEach(u => { userMap[u.id] = u.username; });

  return Object.entries(counts)
    .map(([id, count]) => ({ id, username: userMap[id] || 'Unknown', count }))
    .sort((a, b) => b.count - a.count);
}

// Build leaderboard from time_sessions
async function buildTimeLeaderboard(periodStart) {
  const rows = await db('time_sessions?select=user_id,seconds,date&limit=100000');
  if (!Array.isArray(rows) || !rows.length) return [];

  const filtered = rows.filter(r => {
    if (!r.user_id) return false;
    if (periodStart && r.date && new Date(r.date) < new Date(periodStart)) return false;
    return true;
  });

  const totals = {};
  for (const r of filtered) {
    totals[r.user_id] = (totals[r.user_id] || 0) + Math.round(r.seconds || 0);
  }
  if (!Object.keys(totals).length) return [];

  const ids = Object.keys(totals);
  const users = await db(`users?id=in.(${ids.join(',')})&select=id,username`);
  const userMap = {};
  if (Array.isArray(users)) users.forEach(u => { userMap[u.id] = u.username; });

  return Object.entries(totals)
    .map(([id, seconds]) => ({ id, username: userMap[id] || 'Unknown', seconds }))
    .sort((a, b) => b.seconds - a.seconds);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-session-token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers['x-session-token'] || req.body?.token;
  const { action, periodStart } = req.method === 'GET' ? req.query : (req.body || {});

  // ── Leaderboard — papers (no auth required) ──
  if (action === 'leaderboard_papers') {
    const entries = await buildPapersLeaderboard(periodStart || null);
    return res.status(200).json(entries);
  }

  // ── Leaderboard — time (no auth required) ──
  if (action === 'leaderboard_time') {
    const entries = await buildTimeLeaderboard(periodStart || null);
    return res.status(200).json(entries);
  }

  // ── Site config (no auth required) ──
  if (action === 'site_config') {
    const rows = await db('site_config?select=key,value');
    const cfg = {};
    if (Array.isArray(rows)) rows.forEach(r => { cfg[r.key] = r.value; });
    return res.status(200).json(cfg);
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
    const favs = await db(`favourites?user_id=eq.${userId}&select=code,name&order=id.desc`);
    return res.status(200).json(Array.isArray(favs) ? favs : []);
  }
  if (action === 'add_fav') {
    const { code, name } = req.body;
    await db('favourites', 'POST', { user_id: userId, code, name });
    return res.status(200).json({ ok: true });
  }
  if (action === 'remove_fav') {
    const { code } = req.body;
    await db(`favourites?user_id=eq.${userId}&code=eq.${code}`, 'DELETE');
    return res.status(200).json({ ok: true });
  }

  // ── Chat history ──
  if (action === 'get_chat') {
    const { paperUrl } = req.body;
    if (!paperUrl) return res.status(400).json({ error: 'No paperUrl' });
    const rows = await db(`chat_history?user_id=eq.${userId}&paper_url=eq.${encodeURIComponent(paperUrl)}&select=messages&limit=1`);
    const messages = Array.isArray(rows) && rows[0] ? JSON.parse(rows[0].messages || '[]') : [];
    return res.status(200).json({ messages });
  }
  if (action === 'save_chat') {
    const { paperUrl, messages } = req.body;
    if (!paperUrl) return res.status(400).json({ error: 'No paperUrl' });
    const existing = await db(`chat_history?user_id=eq.${userId}&paper_url=eq.${encodeURIComponent(paperUrl)}&select=id`);
    if (Array.isArray(existing) && existing[0]) {
      await db(`chat_history?id=eq.${existing[0].id}`, 'PATCH', { messages: JSON.stringify(messages), updated_at: new Date().toISOString() });
    } else {
      await db('chat_history', 'POST', { user_id: userId, paper_url: paperUrl, messages: JSON.stringify(messages) });
    }
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
