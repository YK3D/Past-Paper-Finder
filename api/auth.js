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

function hashPass(p) {
  return Buffer.from(p + ':ppf_salt_2025').toString('base64');
}

// Add device_id to device_sessions (username-keyed, 10 slots, no repeats)
async function trackDevice(username, deviceId) {
  if (!username || !deviceId) return;
  try {
    const rows = await db(
      `device_sessions?username=eq.${encodeURIComponent(username)}&select=*&limit=1`
    );
    const row = Array.isArray(rows) && rows[0] ? rows[0] : null;

    if (!row) {
      // New row — put device in slot 1
      await db('device_sessions', 'POST', {
        username,
        device_1: deviceId,
        first_seen: new Date().toISOString(),
        last_seen: new Date().toISOString()
      });
      return;
    }

    // Check if device already in a slot — if so just update last_seen
    const slots = ['device_1','device_2','device_3','device_4','device_5',
                   'device_6','device_7','device_8','device_9','device_10'];
    if (slots.some(s => row[s] === deviceId)) {
      await db(
        `device_sessions?username=eq.${encodeURIComponent(username)}`,
        'PATCH', { last_seen: new Date().toISOString() }
      );
      return;
    }

    // Find first empty slot and fill it
    const emptySlot = slots.find(s => !row[s]);
    if (emptySlot) {
      await db(
        `device_sessions?username=eq.${encodeURIComponent(username)}`,
        'PATCH', { [emptySlot]: deviceId, last_seen: new Date().toISOString() }
      );
    }
    // If all 10 slots full, do nothing (device limit reached)
  } catch {}
}

const SWEAR_WORDS = ['fuck','shit','bitch','ass','cunt','dick','cock','pussy','bastard',
  'whore','slut','nigger','faggot','twat','wanker','piss','arse','bollocks','crap',
  'fag','retard','dipshit','douchebag','asshole','arsehole','jackass','motherfucker',
  'bellend','tosser','wank','knob','prick'];

function containsSwear(t) {
  const l = (t || '').toLowerCase();
  return SWEAR_WORDS.some(w => l.includes(w));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { action, email, username, password, identifier,
          newPassword, token, deviceId } = req.body || {};

  // ── Register ──
  if (action === 'register') {
    if (!email || !username || !password)
      return res.status(400).json({ error: 'All fields required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'Invalid email address' });
    if (username.length < 3 || username.length > 20)
      return res.status(400).json({ error: 'Username must be 3–20 characters' });
    if (containsSwear(username))
      return res.status(400).json({ error: 'Username contains inappropriate language' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters' });

    // Check for ban
    const [banEmail, banUser] = await Promise.all([
      db(`ban_list?type=eq.email&value=eq.${encodeURIComponent(email)}&active=eq.true&select=id&limit=1`),
      db(`ban_list?type=eq.username&value=eq.${encodeURIComponent(username)}&active=eq.true&select=id&limit=1`)
    ]);
    if ((Array.isArray(banEmail) && banEmail[0]) || (Array.isArray(banUser) && banUser[0]))
      return res.status(403).json({ error: 'This account is banned' });

    // Check existing
    const [existEmail, existUser] = await Promise.all([
      db(`users?email=eq.${encodeURIComponent(email)}&select=id&limit=1`),
      db(`users?username=eq.${encodeURIComponent(username)}&select=id&limit=1`)
    ]);
    if (Array.isArray(existEmail) && existEmail[0])
      return res.status(400).json({ error: 'Email already registered' });
    if (Array.isArray(existUser) && existUser[0])
      return res.status(400).json({ error: 'Username already taken' });

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null;
    const { phone } = req.body || {};
    const created = await db('users', 'POST',
      { email, username, password_hash: hashPass(password), ip, phone: phone || null, last_seen: new Date().toISOString() });
    if (!Array.isArray(created) || !created[0])
      return res.status(500).json({ error: 'Registration failed' });

    const user = created[0];
    const tokenVal = crypto.randomUUID();
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await db('sessions', 'POST',
      { username: user.username, token: tokenVal, ip, expires_at: expires });
    if (deviceId) trackDevice(user.username, deviceId);
    return res.status(200).json({
      token: tokenVal,
      user: { id: user.id, username: user.username, email: user.email }
    });
  }

  // ── Login ──
  if (action === 'login') {
    if (!identifier || !password)
      return res.status(400).json({ error: 'All fields required' });

    const isEmail = identifier.includes('@');
    const field   = isEmail ? 'email' : 'username';
    const users   = await db(
      `users?${field}=eq.${encodeURIComponent(identifier)}&select=id,username,email,password_hash,banned&limit=1`
    );
    const user = Array.isArray(users) && users[0];
    if (!user || user.password_hash !== hashPass(password))
      return res.status(401).json({ error: 'Invalid credentials' });
    if (user.banned)
      return res.status(403).json({ error: 'This account has been banned' });

    // Check bans
    const [banUser, banEmail] = await Promise.all([
      db(`ban_list?type=eq.username&value=eq.${encodeURIComponent(user.username)}&active=eq.true&select=id&limit=1`),
      db(`ban_list?type=eq.email&value=eq.${encodeURIComponent(user.email)}&active=eq.true&select=id&limit=1`)
    ]);
    if ((Array.isArray(banUser) && banUser[0]) || (Array.isArray(banEmail) && banEmail[0]))
      return res.status(403).json({ error: 'This account has been banned' });

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null;
    const tokenVal = crypto.randomUUID();
    const expires  = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await Promise.all([
      db('sessions', 'POST', { username: user.username, token: tokenVal, ip, expires_at: expires }),
      db(`users?id=eq.${user.id}`, 'PATCH', { last_seen: new Date().toISOString(), ip })
    ]);
    if (deviceId) trackDevice(user.username, deviceId);
    return res.status(200).json({
      token: tokenVal,
      user: { id: user.id, username: user.username, email: user.email }
    });
  }

  // ── Logout ──
  if (action === 'logout') {
    if (token) await db(`sessions?token=eq.${encodeURIComponent(token)}`, 'DELETE');
    return res.status(200).json({ ok: true });
  }

  // ── Verify token ──
  if (action === 'verify') {
    if (!token) return res.status(401).json({ error: 'No token' });
    const s = await db(
      `sessions?token=eq.${encodeURIComponent(token)}&select=username,expires_at&limit=1`
    );
    if (!Array.isArray(s) || !s[0] || new Date(s[0].expires_at) < new Date())
      return res.status(401).json({ error: 'Invalid or expired token' });

    const users = await db(
      `users?username=eq.${encodeURIComponent(s[0].username)}&select=id,username,email,banned&limit=1`
    );
    const user = Array.isArray(users) && users[0];
    if (!user || user.banned)
      return res.status(401).json({ error: 'User not found or banned' });

    await db(`users?id=eq.${user.id}`, 'PATCH', { last_seen: new Date().toISOString() });
    return res.status(200).json({ user: { id: user.id, username: user.username, email: user.email } });
  }

  // ── Change password ──
  if (action === 'change_password') {
    if (!identifier || !password || !newPassword)
      return res.status(400).json({ error: 'All fields required' });
    if (newPassword.length < 8)
      return res.status(400).json({ error: 'New password must be at least 8 characters' });

    const isEmail = identifier.includes('@');
    const field   = isEmail ? 'email' : 'username';
    const users   = await db(
      `users?${field}=eq.${encodeURIComponent(identifier)}&select=id,password_hash&limit=1`
    );
    const user = Array.isArray(users) && users[0];
    if (!user || user.password_hash !== hashPass(password))
      return res.status(401).json({ error: 'Invalid credentials' });

    await db(`users?id=eq.${user.id}`, 'PATCH', { password_hash: hashPass(newPassword) });
    return res.status(200).json({ ok: true });
  }

  // ── Update phone ──
  if (action === 'update_phone') {
    const { token, phone } = req.body || {};
    if (!token || !phone) return res.status(400).json({ error: 'token and phone required' });
    const s = await db(`sessions?token=eq.${encodeURIComponent(token)}&select=username,expires_at&limit=1`);
    if (!Array.isArray(s) || !s[0] || new Date(s[0].expires_at) < new Date())
      return res.status(401).json({ error: 'Invalid token' });
    await db(`users?username=eq.${encodeURIComponent(s[0].username)}`, 'PATCH', { phone });
    // Update cached user so popup doesn't show again
    const u = await db(`users?username=eq.${encodeURIComponent(s[0].username)}&select=id,username,email,phone&limit=1`);
    return res.status(200).json({ ok: true, user: Array.isArray(u) && u[0] ? u[0] : null });
  }

  // ── Update phone ──
  if (action === 'update_phone') {
    const { token: tok, phone: newPhone } = req.body;
    if (!tok || !newPhone) return res.status(400).json({ error: 'Missing fields' });
    const s = await db(`sessions?token=eq.${encodeURIComponent(tok)}&select=username,expires_at&limit=1`);
    if (!Array.isArray(s) || !s[0] || new Date(s[0].expires_at) < new Date())
      return res.status(401).json({ error: 'Invalid token' });
    await db(`users?username=eq.${encodeURIComponent(s[0].username)}`, 'PATCH', { phone: newPhone });
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
