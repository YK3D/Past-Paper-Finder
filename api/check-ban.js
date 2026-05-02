const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

const HEADERS = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json'
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
  const text = await r.text();
  return { ok: r.ok, status: r.status, body: text };
}

async function dbPatch(path, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify(body)
  });
  return r.ok;
}

async function dbDelete(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'DELETE',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' }
  });
  return r.ok;
}

async function insertBan(type, value, reason) {
  await dbDelete(`ban_list?type=eq.${type}&value=eq.${encodeURIComponent(value)}`);
  return dbPost('ban_list', { type, value, reason, active: true });
}

async function isActiveBan(type, value) {
  if (!value) return null;
  const rows = await dbGet(
    `ban_list?type=eq.${type}&value=eq.${encodeURIComponent(value)}&active=eq.true&select=reason&limit=1`
  );
  return Array.isArray(rows) && rows[0] ? (rows[0].reason || 'Banned') : null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const body = req.body || {};
  const { action } = body;

  // ── Admin: ban by username ──
  if (action === 'ban') {
    const { username, reason = 'No reason given', type = 'full' } = body;
    if (!username) return res.status(400).json({ error: 'username required' });

    // Step 1: look up user — return full debug info if not found
    const userRows = await dbGet(
      `users?username=eq.${encodeURIComponent(username)}&select=id,ip,email&limit=1`
    );
    console.log('[BAN] userRows for', username, ':', JSON.stringify(userRows));

    if (!Array.isArray(userRows) || !userRows[0]) {
      // Try case-insensitive search to help debug
      const allUsers = await dbGet(`users?select=username,ip,email&limit=20`);
      const usernames = Array.isArray(allUsers) ? allUsers.map(u => u.username) : [];
      return res.status(404).json({
        error: `User "${username}" not found`,
        hint: `Existing usernames (first 20): ${usernames.join(', ')}`
      });
    }

    const user = userRows[0];

    // Step 2: get devices — try both schemas
    let deviceIds = [];
    const ds = await dbGet(
      `device_sessions?username=eq.${encodeURIComponent(username)}&select=device_1,device_2,device_3,device_4,device_5,device_6,device_7,device_8,device_9,device_10&limit=1`
    );
    if (Array.isArray(ds) && ds[0]) {
      deviceIds = Object.values(ds[0]).filter(v => v && typeof v === 'string');
    }
    if (!deviceIds.length && user.id) {
      const ud = await dbGet(`user_devices?user_id=eq.${user.id}&select=device_id`);
      if (Array.isArray(ud)) deviceIds = ud.map(r => r.device_id).filter(Boolean);
    }

    console.log('[BAN] user:', JSON.stringify(user), 'devices:', deviceIds);

    // Step 3: build ban list
    const types = type === 'full' ? ['username', 'email', 'ip', 'device'] : [type];
    const applied = [];
    const skipped = [];
    const errors = [];

    for (const t of types) {
      let value = null;
      if (t === 'username') value = username;
      else if (t === 'email') value = user.email;
      else if (t === 'ip')    value = user.ip;

      if (t === 'device') {
        if (!deviceIds.length) {
          skipped.push('device: no devices on record');
        } else {
          for (const d of deviceIds) {
            const result = await insertBan('device', d, reason);
            if (result.ok) applied.push(`device:${d}`);
            else errors.push(`device:${d} — ${result.body}`);
          }
        }
      } else if (!value) {
        skipped.push(`${t}: not on record for this user`);
      } else {
        const result = await insertBan(t, value, reason);
        if (result.ok) applied.push(`${t}:${value}`);
        else errors.push(`${t}:${value} — ${result.body}`);
      }
    }

    // Step 4: mark user banned
    await dbPatch(`users?id=eq.${user.id}`, { banned: true });

    return res.status(200).json({ ok: true, applied, skipped, errors });
  }

  // ── Admin: unban by username ──
  if (action === 'unban') {
    const { username } = body;
    if (!username) return res.status(400).json({ error: 'username required' });

    const userRows = await dbGet(`users?username=eq.${encodeURIComponent(username)}&select=id,ip,email&limit=1`);
    if (!Array.isArray(userRows) || !userRows[0]) {
      return res.status(404).json({ error: `User "${username}" not found` });
    }
    const user = userRows[0];

    let deviceIds = [];
    const ds = await dbGet(`device_sessions?username=eq.${encodeURIComponent(username)}&select=device_1,device_2,device_3,device_4,device_5,device_6,device_7,device_8,device_9,device_10&limit=1`);
    if (Array.isArray(ds) && ds[0]) deviceIds = Object.values(ds[0]).filter(v => v && typeof v === 'string');
    if (!deviceIds.length && user.id) {
      const ud = await dbGet(`user_devices?user_id=eq.${user.id}&select=device_id`);
      if (Array.isArray(ud)) deviceIds = ud.map(r => r.device_id).filter(Boolean);
    }

    const toUnban = [
      { type: 'username', value: username },
      ...(user.email ? [{ type: 'email',  value: user.email }] : []),
      ...(user.ip    ? [{ type: 'ip',     value: user.ip    }] : []),
      ...deviceIds.map(d => ({ type: 'device', value: d }))
    ];

    await Promise.all(toUnban.map(b =>
      dbPatch(`ban_list?type=eq.${b.type}&value=eq.${encodeURIComponent(b.value)}`, { active: false })
    ));
    await dbPatch(`users?id=eq.${user.id}`, { banned: false });

    return res.status(200).json({ ok: true, unbanned: toUnban.map(b => `${b.type}:${b.value}`) });
  }

  // ── Page load check: IP + device ──
  const { deviceId } = body;
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null;

  const [ipBan, deviceBan] = await Promise.all([
    ip       ? isActiveBan('ip',     ip)       : Promise.resolve(null),
    deviceId ? isActiveBan('device', deviceId) : Promise.resolve(null)
  ]);

  if (ipBan)     return res.status(200).json({ banned: true, type: 'ip',     reason: ipBan });
  if (deviceBan) return res.status(200).json({ banned: true, type: 'device', reason: deviceBan });
  return res.status(200).json({ banned: false });
}
