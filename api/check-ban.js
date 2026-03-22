const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

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
  return r.ok;
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

// Insert a ban row — delete existing first to avoid constraint conflicts
async function insertBan(type, value, reason) {
  // Delete any existing row for this type+value first (avoids unique constraint issues)
  await dbDelete(`ban_list?type=eq.${type}&value=eq.${encodeURIComponent(value)}`);
  // Insert fresh
  return dbPost('ban_list', { type, value, reason, active: true });
}

async function isActiveBan(type, value) {
  if (!value) return null;
  const rows = await dbGet(
    `ban_list?type=eq.${type}&value=eq.${encodeURIComponent(value)}&active=eq.true&select=reason&limit=1`
  );
  return Array.isArray(rows) && rows[0] ? (rows[0].reason || 'Banned') : null;
}

async function getUser(username) {
  const rows = await dbGet(
    `users?username=eq.${encodeURIComponent(username)}&select=id,ip,email&limit=1`
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function getDeviceIds(username, userId) {
  // Try device_sessions (new schema — username keyed, 10 slots)
  const ds = await dbGet(
    `device_sessions?username=eq.${encodeURIComponent(username)}&select=device_1,device_2,device_3,device_4,device_5,device_6,device_7,device_8,device_9,device_10&limit=1`
  );
  if (Array.isArray(ds) && ds[0]) {
    const ids = Object.values(ds[0]).filter(v => v && typeof v === 'string');
    if (ids.length) return ids;
  }
  // Fallback: user_devices (old schema — user_id keyed)
  if (userId) {
    const ud = await dbGet(`user_devices?user_id=eq.${userId}&select=device_id`);
    if (Array.isArray(ud) && ud.length) {
      return ud.map(r => r.device_id).filter(Boolean);
    }
  }
  return [];
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

    const user = await getUser(username);
    if (!user) return res.status(404).json({ error: `User "${username}" not found in users table` });

    const deviceIds = await getDeviceIds(username, user.id);

    const types = type === 'full' ? ['username', 'email', 'ip', 'device'] : [type];
    const applied = [];
    const skipped = [];

    for (const t of types) {
      if (t === 'username') {
        await insertBan('username', username, reason);
        applied.push(`username:${username}`);
      } else if (t === 'email') {
        if (user.email) {
          await insertBan('email', user.email, reason);
          applied.push(`email:${user.email}`);
        } else {
          skipped.push('email: none on record');
        }
      } else if (t === 'ip') {
        if (user.ip) {
          await insertBan('ip', user.ip, reason);
          applied.push(`ip:${user.ip}`);
        } else {
          skipped.push('ip: none on record');
        }
      } else if (t === 'device') {
        if (deviceIds.length) {
          for (const d of deviceIds) {
            await insertBan('device', d, reason);
            applied.push(`device:${d}`);
          }
        } else {
          skipped.push('device: no devices on record');
        }
      }
    }

    // Mark user.banned = true
    await dbPatch(`users?id=eq.${user.id}`, { banned: true });

    return res.status(200).json({ ok: true, applied, skipped });
  }

  // ── Admin: unban by username ──
  if (action === 'unban') {
    const { username } = body;
    if (!username) return res.status(400).json({ error: 'username required' });

    const user = await getUser(username);
    if (!user) return res.status(404).json({ error: `User "${username}" not found` });

    const deviceIds = await getDeviceIds(username, user.id);
    const toUnban = [
      { type: 'username', value: username },
      ...(user.email ? [{ type: 'email', value: user.email }] : []),
      ...(user.ip    ? [{ type: 'ip',    value: user.ip    }] : []),
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
