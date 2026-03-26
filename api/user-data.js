const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

const HEADERS = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

async function dbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: HEADERS });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return []; }
}

async function dbPost(path, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const err = await r.text();
    console.error(`[DB POST ${path}] ${r.status}: ${err}`);
    return { ok: false, error: err };
  }
  return { ok: true };
}

async function dbPatch(path, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const err = await r.text();
    console.error(`[DB PATCH ${path}] ${r.status}: ${err}`);
  }
  return r.ok;
}

async function dbDelete(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'DELETE',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' }
  });
  return r.ok;
}

async function getUsernameFromToken(token) {
  if (!token) return null;
  try {
    const s = await dbGet(`sessions?token=eq.${encodeURIComponent(token)}&select=username,user_id,expires_at&limit=1`);
    if (!Array.isArray(s) || !s[0]) return null;
    if (new Date(s[0].expires_at) < new Date()) return null;
    if (s[0].username) return s[0].username;
    if (s[0].user_id) {
      const u = await dbGet(`users?id=eq.${s[0].user_id}&select=username&limit=1`);
      return Array.isArray(u) && u[0] ? u[0].username : null;
    }
    return null;
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

  // ── Site config ──
  if (action === 'site_config') {
    const rows = await dbGet('site_config?select=key,value');
    const cfg = {};
    if (Array.isArray(rows)) rows.forEach(r => { cfg[r.key] = r.value; });
    return res.status(200).json(cfg);
  }

  // ── Leaderboard — papers viewed ──
  if (action === 'leaderboard_papers') {
    const rows = await dbGet('paper_views?select=username&limit=100000');
    if (!Array.isArray(rows)) return res.status(200).json([]);
    const counts = {};
    for (const r of rows) {
      if (r.username) counts[r.username] = (counts[r.username] || 0) + 1;
    }
    return res.status(200).json(
      Object.entries(counts).map(([username, count]) => ({ username, count }))
        .sort((a, b) => b.count - a.count).slice(0, 100)
    );
  }

  // ── Leaderboard — time on site ──
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
      Object.entries(totals).map(([username, seconds]) => ({ username, seconds }))
        .sort((a, b) => b.seconds - a.seconds).slice(0, 100)
    );
  }

  // ══ AUTHENTICATED ══
  const username = await getUsernameFromToken(token);
  if (!username) return res.status(401).json({ error: 'Not authenticated' });

  // ── Paper view ──
  if (action === 'view_paper') {
    const { url } = body;
    if (!url) return res.status(400).json({ error: 'No URL' });
    const result = await dbPost('paper_views', { username, paper_url: url });
    return res.status(200).json(result.ok ? { ok: true } : { ok: false, error: result.error });
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
      const newSecs = Math.round(Number(existing[0].seconds) || 0) + secs;
      await dbPatch(`time_sessions?id=eq.${existing[0].id}`, { seconds: newSecs });
    } else {
      await dbPost('time_sessions', { username, seconds: secs, date: today });
    }
    return res.status(200).json({ ok: true });
  }

  // ── My stats ──
  if (action === 'my_stats') {
    const [views, time] = await Promise.all([
      dbGet(`paper_views?username=eq.${encodeURIComponent(username)}&select=id`),
      dbGet(`time_sessions?username=eq.${encodeURIComponent(username)}&select=seconds`)
    ]);
    return res.status(200).json({
      views:   Array.isArray(views) ? views.length : 0,
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

  // ── View paper (from viewer) ──
  if (action === 'view_paper') {
    const { url } = body;
    if (!url) return res.status(400).json({ error: 'No URL' });
    const result = await dbPost('paper_views', { username, paper_url: url });
    return res.status(200).json({ ok: result.ok });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
