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

async function dbPost(path, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: { ...H, 'Prefer': 'return=minimal' },
    body: JSON.stringify(body)
  });
  const t = await r.text();
  if (!r.ok) console.error(`[POST ${path}] ${r.status}: ${t}`);
  return { ok: r.ok, body: t };
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

async function getUsernameFromToken(token) {
  if (!token) return null;
  try {
    const s = await dbGet(`sessions?token=eq.${encodeURIComponent(token)}&select=username,expires_at&limit=1`);
    if (!Array.isArray(s) || !s[0]) return null;
    if (new Date(s[0].expires_at) < new Date()) return null;
    return s[0].username || null;
  } catch { return null; }
}

// Get or create paper_views row for a user, returns { id, count, seconds }
async function getRow(username) {
  const rows = await dbGet(`paper_views?username=eq.${encodeURIComponent(username)}&select=id,count,seconds&limit=1`);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-session-token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers['x-session-token'] || req.body?.token;
  const body  = req.body || {};
  const { action } = body;

  // ── Site config (public) ──
  if (action === 'site_config') {
    const rows = await dbGet('site_config?select=key,value');
    const cfg = {};
    if (Array.isArray(rows)) rows.forEach(r => { cfg[r.key] = r.value; });
    return res.status(200).json(cfg);
  }

  // ── Leaderboard papers (public) ──
  if (action === 'leaderboard_papers') {
    const rows = await dbGet('paper_views?select=username,count&order=count.desc&limit=100');
    return res.status(200).json(Array.isArray(rows) ? rows : []);
  }

  // ── Leaderboard time (public) ──
  if (action === 'subject_counts') {
    const rows = await dbGet('subject_counts?select=code,count&order=count.desc&limit=100');
    return res.status(200).json({ rows: rows || [] });
  }

  if (action === 'leaderboard_time') {
    const rows = await dbGet('paper_views?select=username,seconds&order=seconds.desc&limit=100');
    return res.status(200).json(
      Array.isArray(rows)
        ? rows.map(r => ({ username: r.username, seconds: r.seconds || 0 }))
        : []
    );
  }

  // ══ AUTHENTICATED ══
  const username = await getUsernameFromToken(token);
  if (!username) {
    console.error(`[user-data] Auth failed — token: ${token ? token.slice(0,8) : 'none'}`);
    return res.status(401).json({ error: 'Not authenticated' });
  }

  // ── Paper generated — increment count ──
  if (action === 'view_paper') {
    const row = await getRow(username);
    if (row) {
      await dbPatch(
        `paper_views?username=eq.${encodeURIComponent(username)}`,
        { count: (row.count || 0) + 1, updated_at: new Date().toISOString() }
      );
    } else {
      await dbPost('paper_views', { username, count: 1, seconds: 0 });
    }

    // Also track per-subject count
    const urlStr = body.url || '';
    const codeMatch = urlStr.match(/\/([0-9]{4})_/);
    const subjectCode = codeMatch ? codeMatch[1] : null;
    if (subjectCode) {
      try {
        const existing = await dbGet(`subject_counts?code=eq.${encodeURIComponent(subjectCode)}&select=count`);
        if (existing && existing.length) {
          await dbPatch(`subject_counts?code=eq.${encodeURIComponent(subjectCode)}`,
            { count: (existing[0].count || 0) + 1, updated_at: new Date().toISOString() });
        } else {
          await dbPost('subject_counts', { code: subjectCode, count: 1 });
        }
      } catch(e) { /* non-critical */ }
    }

    return res.status(200).json({ ok: true });
  }

  // ── Time tracking — add seconds to user's row ──
  if (action === 'track_time') {
    const secs = Math.round(Number(body.seconds) || 0);
    if (secs < 1) return res.status(400).json({ error: 'Invalid seconds' });
    const row = await getRow(username);
    if (row) {
      await dbPatch(
        `paper_views?username=eq.${encodeURIComponent(username)}`,
        { seconds: (row.seconds || 0) + secs, updated_at: new Date().toISOString() }
      );
    } else {
      await dbPost('paper_views', { username, count: 0, seconds: secs });
    }
    return res.status(200).json({ ok: true });
  }

  // ── My stats ──
  if (action === 'my_stats') {
    const row = await getRow(username);
    return res.status(200).json({
      views:   row ? (row.count   || 0) : 0,
      seconds: row ? (row.seconds || 0) : 0
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
      await dbPost('chat_history', { username, paper_url: paperUrl, messages: JSON.stringify(messages) });
    }
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
