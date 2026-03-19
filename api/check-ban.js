const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

function dbGet(path) {
return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
headers: {
‘apikey’: SUPABASE_KEY,
‘Authorization’: `Bearer ${SUPABASE_KEY}`,
‘Content-Type’: ‘application/json’
}
}).then(r => r.json().catch(() => []));
}

function dbPost(path, body, prefer = ‘return=minimal’) {
return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
method: ‘POST’,
headers: {
‘apikey’: SUPABASE_KEY,
‘Authorization’: `Bearer ${SUPABASE_KEY}`,
‘Content-Type’: ‘application/json’,
‘Prefer’: prefer
},
body: JSON.stringify(body)
}).then(r => r.json().catch(() => ({})));
}

async function checkActiveBan(type, value) {
if (!value) return null;
const rows = await dbGet(`ban_list?type=eq.${type}&value=eq.${encodeURIComponent(value)}&active=eq.true&select=reason&limit=1`);
return Array.isArray(rows) && rows[0] ? (rows[0].reason || ‘Banned’) : null;
}

// Look up user by username and return their IP + device IDs
async function getUserBanData(username) {
const users = await dbGet(`users?username=eq.${encodeURIComponent(username)}&select=id,ip,email`);
if (!Array.isArray(users) || !users[0]) return null;
const user = users[0];
const devices = await dbGet(`user_devices?user_id=eq.${user.id}&select=device_id`);
return {
userId: user.id,
ip: user.ip,
email: user.email,
deviceIds: Array.isArray(devices) ? devices.map(d => d.device_id) : []
};
}

// Apply all bans for a username (full ban by username)
async function applyFullBan(username, reason) {
const data = await getUserBanData(username);
if (!data) return { ok: false, error: ‘User not found’ };

const bans = [
{ type: ‘username’, value: username },
…(data.email ? [{ type: ‘email’, value: data.email }] : []),
…(data.ip    ? [{ type: ‘ip’,    value: data.ip    }] : []),
…data.deviceIds.map(d => ({ type: ‘device’, value: d }))
];

await Promise.all(bans.map(b =>
dbPost(‘ban_list’, { type: b.type, value: b.value, reason, active: true },
‘return=minimal,resolution=merge-duplicates’)
));

// Set banned flag on user
await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${data.userId}`, {
method: ‘PATCH’,
headers: {
‘apikey’: SUPABASE_KEY,
‘Authorization’: `Bearer ${SUPABASE_KEY}`,
‘Content-Type’: ‘application/json’,
‘Prefer’: ‘return=minimal’
},
body: JSON.stringify({ banned: true })
});

return { ok: true, banned: bans.length };
}

export default async function handler(req, res) {
res.setHeader(‘Access-Control-Allow-Origin’, ‘*’);
res.setHeader(‘Access-Control-Allow-Methods’, ‘POST, GET, OPTIONS’);
if (req.method === ‘OPTIONS’) return res.status(200).end();
if (!SUPABASE_URL) return res.status(200).json({ banned: false });

// ── Admin: apply ban by username ──
// POST { action: ‘ban’, username, reason, type: ‘full’|‘ip’|‘email’|‘username’|‘device’ }
if (req.method === ‘POST’ && req.body?.action === ‘ban’) {
const { username, reason = ‘No reason given’, type = ‘full’ } = req.body;
if (!username) return res.status(400).json({ error: ‘username required’ });

```
if (type === 'full') {
  const result = await applyFullBan(username, reason);
  return res.status(200).json(result);
}

// Single-type ban by username — look up the value automatically
const data = await getUserBanData(username);
if (!data) return res.status(404).json({ error: 'User not found' });

let value;
if (type === 'ip')       value = data.ip;
else if (type === 'email')    value = data.email;
else if (type === 'username') value = username;
else if (type === 'device') {
  // Ban all devices
  await Promise.all(data.deviceIds.map(d =>
    dbPost('ban_list', { type: 'device', value: d, reason, active: true },
      'return=minimal,resolution=merge-duplicates')
  ));
  return res.status(200).json({ ok: true, banned: data.deviceIds.length });
}

if (!value) return res.status(400).json({ error: `No ${type} found for this user` });
await dbPost('ban_list', { type, value, reason, active: true },
  'return=minimal,resolution=merge-duplicates');
return res.status(200).json({ ok: true });
```

}

// ── Admin: remove ban by username ──
if (req.method === ‘POST’ && req.body?.action === ‘unban’) {
const { username } = req.body;
if (!username) return res.status(400).json({ error: ‘username required’ });
const data = await getUserBanData(username);
if (!data) return res.status(404).json({ error: ‘User not found’ });

```
// Deactivate all bans for this user
const values = [username, data.email, data.ip, ...data.deviceIds].filter(Boolean);
await Promise.all(values.map(v =>
  fetch(`${SUPABASE_URL}/rest/v1/ban_list?value=eq.${encodeURIComponent(v)}`, {
    method: 'PATCH',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify({ active: false })
  })
));
await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${data.userId}`, {
  method: 'PATCH',
  headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
  body: JSON.stringify({ banned: false })
});
return res.status(200).json({ ok: true });
```

}

// ── Page load check (IP + device) ──
if (req.method === ‘POST’) {
const { deviceId } = req.body || {};
const ip = (req.headers[‘x-forwarded-for’] || ‘’).split(’,’)[0].trim() || ‘unknown’;

```
if (ip && ip !== 'unknown') {
  const reason = await checkActiveBan('ip', ip);
  if (reason) return res.status(200).json({ banned: true, type: 'ip', reason });
}

if (deviceId) {
  const reason = await checkActiveBan('device', deviceId);
  if (reason) return res.status(200).json({ banned: true, type: 'device', reason });
}

return res.status(200).json({ banned: false });
```

}

return res.status(405).end();
}