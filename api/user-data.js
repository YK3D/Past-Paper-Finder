const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

const H = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

async function dbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return []; }
}

async function dbPost(path, body, prefer = 'return=minimal') {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: { ...H, 'Prefer': prefer },
    body: JSON.stringify(body)
  });
  const t = await r.text();
  if (!r.ok) console.error(`[POST ${path}] ${r.status}: ${t}`);
  return { ok: r.ok, status: r.status, body: t };
}

async function dbPatch(path, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: { ...H, 'Prefer': 'return=minimal' },
    body: JSON.stringify(body)
  });
  if (!r.ok) console.error(`[PATCH ${path}] ${r.status}: ${await r.text()}`);
  return r.ok;
}

async function dbDelete(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'DELETE', headers: { ...H, 'Prefer': 'return=minimal' }
  });
  return r.ok;
}

// Execute raw SQL via Supabase RPC (for upsert with increment)
async function dbRpc(fn, params) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify(params)
  });
  const t = await r.text();
  if (!r.ok) console.error(`[RPC ${fn}] ${r.status}: ${t}`);
  return { ok: r.ok, body: t };
}

async function getUsernameFromToken(token) {
  if (!token) return null;
  try {
    const s = await dbGet(`sessions?token=eq.${encodeURIComponent(token)}&select=username,expires_at&limit=1`);
    if (!Array.isArray(s) || !s[0]) return null;
    if (new Date(s[0].expires_at) < new Date()) return null;
    return s[0].username || null;
  } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-session-token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers['x-session-token'] || req.body?.token;
  const body = req.body || {};
  const { action, periodStart } = body;

  // ── Site config (public) ──
  if (action === 'site_config') {
    const rows = await dbGet('site_config?select=key,value');
    const cfg = {};
    if (Array.isArray(rows)) rows.forEach(r => { cfg[r.key] = r.value; });
    return res.status(200).json(cfg);
  }

  // ── Leaderboard papers (public) — direct count column ──
  if (action === 'leaderboard_papers') {
    const rows = await dbGet('paper_views?select=username,count&order=count.desc&limit=100');
    return res.status(200).json(Array.isArray(rows) ? rows : []);
  }

  // ── Leaderboard time (public) ──
  if (action === 'leaderboard_time') {
    const rows = await dbGet('time_sessions?select=username,seconds,date&limit=200000');
    if (!Array.isArray(rows)) return res.status(200).json([]);
    const totals = {};
    for (const r of rows) {
      if (!r.username) continue;
      if (periodStart && r.date && new Date(r.date) < new Date(periodStart)) continue;
      totals[r.username] = (totals[r.username] || 0) + Math.round(Number(r.seconds) || 0);
    }
    return res.status(200).json(
      Object.entries(totals)
        .map(([username, seconds]) => ({ username, seconds }))
        .sort((a, b) => b.seconds - a.seconds)
        .slice(0, 100)
    );
  }

  // ══ AUTHENTICATED ══
  const username = await getUsernameFromToken(token);
  if (!username) {
    console.error(`[user-data] Auth failed for token: ${token ? token.slice(0,8) : 'none'}`);
    return res.status(401).json({ error: 'Not authenticated' });
  }

  // ── Paper view — increment user's count (upsert) ──
  if (action === 'view_paper') {
    // Check if row exists
    const existing = await dbGet(`paper_views?username=eq.${encodeURIComponent(username)}&select=id,count&limit=1`);
    if (Array.isArray(existing) && existing[0]) {
      await dbPatch(
        `paper_views?username=eq.${encodeURIComponent(username)}`,
        { count: (existing[0].count || 0) + 1, updated_at: new Date().toISOString() }
      );
    } else {
      await dbPost('paper_views', { username, count: 1 });
    }
    return res.status(200).json({ ok: true });
  }

  // ── Time tracking ──
  if (action === 'track_time') {
    const secs = Math.round(Number(body.seconds) || 0);
    if (secs < 1) return res.status(400).json({ error: 'Invalid seconds' });
    const today = new Date().toISOString().slice(0, 10);
    const existing = await dbGet(
      `time_sessions?username=eq.${encodeURIComponent(username)}&date=eq.${today}&select=id,seconds&limit=1`
    );
    if (Array.isArray(existing) && existing[0]) {
      await dbPatch(`time_sessions?id=eq.${existing[0].id}`,
        { seconds: Math.round(Number(existing[0].seconds) || 0) + secs });
    } else {
      await dbPost('time_sessions', { username, seconds: secs, date: today });
    }
    return res.status(200).json({ ok: true });
  }

  // ── My stats ──
  if (action === 'my_stats') {
    const [views, time] = await Promise.all([
      dbGet(`paper_views?username=eq.${encodeURIComponent(username)}&select=count&limit=1`),
      dbGet(`time_sessions?username=eq.${encodeURIComponent(username)}&select=seconds`)
    ]);
    return res.status(200).json({
      views:   Array.isArray(views) && views[0] ? (views[0].count || 0) : 0,
      seconds: Array.isArray(time) ? time.reduce((s, r) => s + Math.round(Number(r.seconds) || 0), 0) : 0
    });
  }

  // ── Favourites ──
  if (action === 'get_favs') {
    const favs = await dbGet(`favourites?username=eq.${encodeURIComponent(username)}&select=code,name&order=id.desc`);
    return res.status(200).json(Array.isArray(favs) ? favs : []);
  }
  if (action === 'add_fav') {
    const { code, name } = body;
    if (!code) return res.status(400).json({ error: 'No code' });
    await dbPost('favourites', { username, code, name });
    return res.status(200).json({ ok: true });
  }
  if (action === 'remove_fav') {
    const { code } = body;
    if (!code) return res.status(400).json({ error: 'No code' });
    await dbDelete(`favourites?username=eq.${encodeURIComponent(username)}&code=eq.${encodeURIComponent(code)}`);
    return res.status(200).json({ ok: true });
  }

  // ── Chat history ──
  if (action === 'get_chat') {
    const { paperUrl } = body;
    if (!paperUrl) return res.status(400).json({ error: 'No paperUrl' });
    const rows = await dbGet(
      `chat_history?username=eq.${encodeURIComponent(username)}&paper_url=eq.${encodeURIComponent(paperUrl)}&select=messages&limit=1`
    );
    const messages = Array.isArray(rows) && rows[0] ? JSON.parse(rows[0].messages || '[]') : [];
    return res.status(200).json({ messages });
  }
  if (action === 'save_chat') {
    const { paperUrl, messages } = body;
    if (!paperUrl) return res.status(400).json({ error: 'No paperUrl' });
    const existing = await dbGet(
      `chat_history?username=eq.${encodeURIComponent(username)}&paper_url=eq.${encodeURIComponent(paperUrl)}&select=id&limit=1`
    );
    if (Array.isArray(existing) && existing[0]) {
      await dbPatch(`chat_history?id=eq.${existing[0].id}`,
        { messages: JSON.stringify(messages), updated_at: new Date().toISOString() });
    } else {
      await dbPost('chat_history',
        { username, paper_url: paperUrl, messages: JSON.stringify(messages) });
    }
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
