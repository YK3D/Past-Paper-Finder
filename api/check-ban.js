const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

function dbGet(path) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json'
    }
  }).then(r => r.json().catch(() => []));
}

function dbPatch(path, body) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(body)
  });
}

// Upsert into ban_list — POST with ON CONFLICT DO UPDATE via Prefer header
function insertBan(type, value, reason) {
  return fetch(`${SUPABASE_URL}/rest/v1/ban_list`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal,resolution=merge-duplicates'
    },
    body: JSON.stringify({ type, value, reason, active: true })
  });
}

async function isActiveBan(type, value) {
  if (!value) return null;
  const rows = await dbGet(
    `ban_list?type=eq.${type}&value=eq.${encodeURIComponent(value)}&active=eq.true&select=reason&limit=1`
  );
  return Array.isArray(rows) && rows[0] ? (rows[0].reason || 'Banned') : null;
}

// Look up user by username — returns id, ip, email
async function getUser(username) {
  const rows = await dbGet(
    `users?username=eq.${encodeURIComponent(username)}&select=id,ip,email&limit=1`
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

// Get all device IDs for a username from device_sessions
// Falls back to user_devices table if device_sessions doesn't exist yet
async function getDeviceIds(username, userId) {
  // Try device_sessions first (new schema)
  const ds = await dbGet(
    `device_sessions?username=eq.${encodeURIComponent(username)}&select=device_1,device_2,device_3,device_4,device_5,device_6,device_7,device_8,device_9,device_10&limit=1`
  );
  if (Array.isArray(ds) && ds[0]) {
    return Object.values(ds[0]).filter(Boolean);
  }
  // Fallback: user_devices (old schema)
  if (userId) {
    const ud = await dbGet(
      `user_devices?user_id=eq.${userId}&select=device_id`
    );
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

  const body = req.body || {};

  // ── Admin: ban by username ──
  if (body.action === 'ban') {
    const { username, reason = 'No reason given', type = 'full' } = body;
    if (!username) return res.status(400).json({ error: 'username required' });

    // Look up user
    const user = await getUser(username);
    if (!user) return res.status(404).json({ error: 'User not found: ' + username });

    const deviceIds = await getDeviceIds(username, user.id);

    // Decide which ban types to apply
    const applyTypes = type === 'full'
      ? ['username', 'email', 'ip', 'device']
      : [type];

    const bans = [];

    for (const t of applyTypes) {
      if (t === 'username') {
        bans.push({ type: 'username', value: username });
      } else if (t === 'email' && user.email) {
        bans.push({ type: 'email', value: user.email });
      } else if (t === 'ip' && user.ip) {
        bans.push({ type: 'ip', value: user.ip });
      } else if (t === 'device') {
        for (const d of deviceIds) {
          bans.push({ type: 'device', value: d });
        }
      }
    }

    if (!bans.length) {
      return res.status(400).json({
        error: `No data found to ban by type "${type}" for user "${username}". IP: ${user.ip || 'none'}, devices: ${deviceIds.length}`
      });
    }

    // Insert all bans
    await Promise.all(bans.map(b => insertBan(b.type, b.value, reason)));

    // Mark user as banned
    await dbPatch(`users?id=eq.${user.id}`, { banned: true });

    return res.status(200).json({
      ok: true,
      username,
      applied: bans.map(b => `${b.type}:${b.value}`)
    });
  }

  // ── Admin: unban by username ──
  if (body.action === 'unban') {
    const { username } = body;
    if (!username) return res.status(400).json({ error: 'username required' });

    const user = await getUser(username);
    if (!user) return res.status(404).json({ error: 'User not found: ' + username });

    const deviceIds = await getDeviceIds(username, user.id);
    const values = [username, user.email, user.ip, ...deviceIds].filter(Boolean);

    await Promise.all(values.map(v =>
      dbPatch(`ban_list?value=eq.${encodeURIComponent(v)}`, { active: false })
    ));
    await dbPatch(`users?id=eq.${user.id}`, { banned: false });

    return res.status(200).json({ ok: true, unbanned: values });
  }

  // ── Page load check: IP + device ──
  if (req.method === 'POST') {
    const { deviceId } = body;
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null;

    const [ipBan, deviceBan] = await Promise.all([
      ip     ? isActiveBan('ip',     ip)       : Promise.resolve(null),
      deviceId ? isActiveBan('device', deviceId) : Promise.resolve(null)
    ]);

    if (ipBan)     return res.status(200).json({ banned: true, type: 'ip',     reason: ipBan });
    if (deviceBan) return res.status(200).json({ banned: true, type: 'device', reason: deviceBan });
    return res.status(200).json({ banned: false });
  }

  return res.status(405).end();
}
