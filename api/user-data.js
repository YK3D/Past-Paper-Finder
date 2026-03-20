const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

function db(path, method = ‘GET’, body, extraHeaders = {}) {
return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
method,
headers: {
‘apikey’: SUPABASE_KEY,
‘Authorization’: `Bearer ${SUPABASE_KEY}`,
‘Content-Type’: ‘application/json’,
‘Prefer’: method === ‘POST’ ? ‘return=representation’ : ‘return=minimal’,
…extraHeaders
},
body: body ? JSON.stringify(body) : undefined
}).then(r => r.json().catch(() => ({})));
}

async function getUsernameFromToken(token) {
if (!token) return null;
const s = await db(`sessions?token=eq.${encodeURIComponent(token)}&select=username,expires_at&limit=1`);
if (!Array.isArray(s) || !s[0]) return null;
if (new Date(s[0].expires_at) < new Date()) return null;
return s[0].username;
}

export default async function handler(req, res) {
res.setHeader(‘Access-Control-Allow-Origin’, ‘*’);
res.setHeader(‘Access-Control-Allow-Methods’, ‘GET, POST, DELETE, OPTIONS’);
res.setHeader(‘Access-Control-Allow-Headers’, ‘Content-Type, x-session-token’);
if (req.method === ‘OPTIONS’) return res.status(200).end();

const token = req.headers[‘x-session-token’] || req.body?.token;
const body = req.body || {};
const { action, periodStart } = body;

// ════════════════════════════════════════════
// PUBLIC — no auth required
// ════════════════════════════════════════════

// ── Site config ──
if (action === ‘site_config’) {
const rows = await db(‘site_config?select=key,value’);
const cfg = {};
if (Array.isArray(rows)) rows.forEach(r => { cfg[r.key] = r.value; });
return res.status(200).json(cfg);
}

// ── Leaderboard — papers ──
if (action === ‘leaderboard_papers’) {
const rows = await db(‘paper_views?select=username,viewed_at&limit=50000’);
if (!Array.isArray(rows) || !rows.length) return res.status(200).json([]);

```
const counts = {};
for (const r of rows) {
  if (!r.username) continue;
  if (periodStart && r.viewed_at && new Date(r.viewed_at) < new Date(periodStart)) continue;
  counts[r.username] = (counts[r.username] || 0) + 1;
}

const result = Object.entries(counts)
  .map(([username, count]) => ({ username, count }))
  .sort((a, b) => b.count - a.count);

return res.status(200).json(result);
```

}

// ── Leaderboard — time ──
if (action === ‘leaderboard_time’) {
const rows = await db(‘time_sessions?select=username,seconds,date&limit=100000’);
if (!Array.isArray(rows) || !rows.length) return res.status(200).json([]);

```
const totals = {};
for (const r of rows) {
  if (!r.username) continue;
  if (periodStart && r.date && new Date(r.date) < new Date(periodStart)) continue;
  totals[r.username] = (totals[r.username] || 0) + Math.round(r.seconds || 0);
}

const result = Object.entries(totals)
  .map(([username, seconds]) => ({ username, seconds }))
  .sort((a, b) => b.seconds - a.seconds);

return res.status(200).json(result);
```

}

// ════════════════════════════════════════════
// AUTHENTICATED — token required
// ════════════════════════════════════════════

const username = await getUsernameFromToken(token);
if (!username) return res.status(401).json({ error: ‘Not authenticated’ });

// ── Paper view ──
if (action === ‘view_paper’) {
const { url } = body;
if (!url) return res.status(400).json({ error: ‘No URL’ });
// Avoid duplicate views of the same URL on the same day
const today = new Date().toISOString().slice(0, 10);
const existing = await db(
`paper_views?username=eq.${encodeURIComponent(username)}&paper_url=eq.${encodeURIComponent(url)}&viewed_at=gte.${today}&select=id&limit=1`
);
if (!Array.isArray(existing) || !existing.length) {
await db(‘paper_views’, ‘POST’, { username, paper_url: url, viewed_at: new Date().toISOString() });
}
return res.status(200).json({ ok: true });
}

// ── Time tracking — upsert one record per username per day ──
if (action === ‘track_time’) {
const secs = Math.round(body.seconds || 0);
if (secs < 1) return res.status(400).json({ error: ‘Invalid seconds’ });
const today = new Date().toISOString().slice(0, 10);
const existing = await db(
`time_sessions?username=eq.${encodeURIComponent(username)}&date=eq.${today}&select=id,seconds&limit=1`
);
if (Array.isArray(existing) && existing[0]) {
await db(`time_sessions?id=eq.${existing[0].id}`, ‘PATCH’,
{ seconds: Math.round(existing[0].seconds) + secs });
} else {
await db(‘time_sessions’, ‘POST’, { username, seconds: secs, date: today });
}
return res.status(200).json({ ok: true });
}

// ── My stats ──
if (action === ‘my_stats’) {
const [views, time] = await Promise.all([
db(`paper_views?username=eq.${encodeURIComponent(username)}&select=id`),
db(`time_sessions?username=eq.${encodeURIComponent(username)}&select=seconds`)
]);
return res.status(200).json({
views:   Array.isArray(views) ? views.length : 0,
seconds: Array.isArray(time) ? time.reduce((s, r) => s + Math.round(r.seconds || 0), 0) : 0
});
}

// ── Favourites ──
if (action === ‘get_favs’) {
const favs = await db(`favourites?username=eq.${encodeURIComponent(username)}&select=code,name&order=id.desc`);
return res.status(200).json(Array.isArray(favs) ? favs : []);
}
if (action === ‘add_fav’) {
const { code, name } = body;
if (!code) return res.status(400).json({ error: ‘No code’ });
await db(‘favourites’, ‘POST’, { username, code, name });
return res.status(200).json({ ok: true });
}
if (action === ‘remove_fav’) {
const { code } = body;
if (!code) return res.status(400).json({ error: ‘No code’ });
await db(`favourites?username=eq.${encodeURIComponent(username)}&code=eq.${encodeURIComponent(code)}`, ‘DELETE’);
return res.status(200).json({ ok: true });
}

// ── Chat history ──
if (action === ‘get_chat’) {
const { paperUrl } = body;
if (!paperUrl) return res.status(400).json({ error: ‘No paperUrl’ });
const rows = await db(
`chat_history?username=eq.${encodeURIComponent(username)}&paper_url=eq.${encodeURIComponent(paperUrl)}&select=messages&limit=1`
);
const messages = Array.isArray(rows) && rows[0] ? JSON.parse(rows[0].messages || ‘[]’) : [];
return res.status(200).json({ messages });
}
if (action === ‘save_chat’) {
const { paperUrl, messages } = body;
if (!paperUrl) return res.status(400).json({ error: ‘No paperUrl’ });
const existing = await db(
`chat_history?username=eq.${encodeURIComponent(username)}&paper_url=eq.${encodeURIComponent(paperUrl)}&select=id&limit=1`
);
if (Array.isArray(existing) && existing[0]) {
await db(`chat_history?id=eq.${existing[0].id}`, ‘PATCH’,
{ messages: JSON.stringify(messages), updated_at: new Date().toISOString() });
} else {
await db(‘chat_history’, ‘POST’,
{ username, paper_url: paperUrl, messages: JSON.stringify(messages) });
}
return res.status(200).json({ ok: true });
}

return res.status(400).json({ error: ‘Unknown action’ });
}