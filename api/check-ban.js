const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

function db(path, method = ‘GET’, body) {
return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
method,
headers: {
‘apikey’: SUPABASE_KEY,
‘Authorization’: `Bearer ${SUPABASE_KEY}`,
‘Content-Type’: ‘application/json’,
‘Prefer’: method === ‘POST’ ? ‘return=representation’ : ‘return=minimal’
},
body: body ? JSON.stringify(body) : undefined
}).then(r => r.json().catch(() => ({})));
}

async function isActiveBan(type, value) {
if (!value) return null;
const rows = await db(
`ban_list?type=eq.${type}&value=eq.${encodeURIComponent(value)}&active=eq.true&select=reason&limit=1`
);
return Array.isArray(rows) && rows[0] ? (rows[0].reason || ‘Banned’) : null;
}

// Get all ban-relevant data for a username
async function getUserBanData(username) {
const users = await db(
`users?username=eq.${encodeURIComponent(username)}&select=id,ip,email&limit=1`
);
const user = Array.isArray(users) && users[0];
if (!user) return null;

const devices = await db(
`device_sessions?username=eq.${encodeURIComponent(username)}&select=device_1,device_2,device_3,device_4,device_5,device_6,device_7,device_8,device_9,device_10&limit=1`
);
const row = Array.isArray(devices) && devices[0] ? devices[0] : {};
const deviceIds = Object.values(row).filter(Boolean);

return { userId: user.id, ip: user.ip, email: user.email, deviceIds };
}

async function applyBans(username, reason, types) {
const data = await getUserBanData(username);
if (!data) return { ok: false, error: ‘User not found’ };

const bans = [];
if (types.includes(‘username’)) bans.push({ type: ‘username’, value: username });
if (types.includes(‘email’) && data.email) bans.push({ type: ‘email’, value: data.email });
if (types.includes(‘ip’) && data.ip) bans.push({ type: ‘ip’, value: data.ip });
if (types.includes(‘device’)) data.deviceIds.forEach(d => bans.push({ type: ‘device’, value: d }));

await Promise.all(bans.map(b =>
fetch(`${SUPABASE_URL}/rest/v1/ban_list`, {
method: ‘POST’,
headers: {
‘apikey’: SUPABASE_KEY, ‘Authorization’: `Bearer ${SUPABASE_KEY}`,
‘Content-Type’: ‘application/json’, ‘Prefer’: ‘resolution=merge-duplicates,return=minimal’
},
body: JSON.stringify({ type: b.type, value: b.value, reason, active: true })
})
));

await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${data.userId}`, {
method: ‘PATCH’,
headers: {
‘apikey’: SUPABASE_KEY, ‘Authorization’: `Bearer ${SUPABASE_KEY}`,
‘Content-Type’: ‘application/json’, ‘Prefer’: ‘return=minimal’
},
body: JSON.stringify({ banned: true })
});

return { ok: true, banned: bans.length };
}

export default async function handler(req, res) {
res.setHeader(‘Access-Control-Allow-Origin’, ‘*’);
res.setHeader(‘Access-Control-Allow-Methods’, ‘POST, OPTIONS’);
res.setHeader(‘Access-Control-Allow-Headers’, ‘Content-Type’);
if (req.method === ‘OPTIONS’) return res.status(200).end();

const body = req.body || {};

// ── Admin: ban by username ──
if (body.action === ‘ban’) {
const { username, reason = ‘No reason given’, type = ‘full’ } = body;
if (!username) return res.status(400).json({ error: ‘username required’ });

```
const types = type === 'full'
  ? ['username', 'email', 'ip', 'device']
  : [type]; // 'ip', 'email', 'username', or 'device'

const result = await applyBans(username, reason, types);
return res.status(200).json(result);
```

}

// ── Admin: unban by username ──
if (body.action === ‘unban’) {
const { username } = body;
if (!username) return res.status(400).json({ error: ‘username required’ });
const data = await getUserBanData(username);
if (!data) return res.status(404).json({ error: ‘User not found’ });

```
const values = [username, data.email, data.ip, ...data.deviceIds].filter(Boolean);
await Promise.all(values.map(v =>
  fetch(`${SUPABASE_URL}/rest/v1/ban_list?value=eq.${encodeURIComponent(v)}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json', 'Prefer': 'return=minimal'
    },
    body: JSON.stringify({ active: false })
  })
));
await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${data.userId}`, {
  method: 'PATCH',
  headers: {
    'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json', 'Prefer': 'return=minimal'
  },
  body: JSON.stringify({ banned: false })
});
return res.status(200).json({ ok: true });
```

}

// ── Page load check: IP + device ──
if (req.method === ‘POST’) {
const { deviceId } = body;
const ip = (req.headers[‘x-forwarded-for’] || ‘’).split(’,’)[0].trim() || null;

```
const [ipBan, deviceBan] = await Promise.all([
  ip ? isActiveBan('ip', ip) : Promise.resolve(null),
  deviceId ? isActiveBan('device', deviceId) : Promise.resolve(null)
]);

if (ipBan)     return res.status(200).json({ banned: true, type: 'ip',     reason: ipBan });
if (deviceBan) return res.status(200).json({ banned: true, type: 'device', reason: deviceBan });
return res.status(200).json({ banned: false });
```

}

return res.status(405).end();
}