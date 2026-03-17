import crypto from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

const SWEAR_WORDS = ['fuck','shit','bitch','ass','cunt','dick','cock','pussy','bastard','whore','slut','nigger','faggot','twat','wanker','piss','arse','bollocks','damn','crap','fag','retard','dipshit','douchebag','asshole','arsehole','jackass','motherfucker','bellend','tosser','wank','knob','prick'];

function db(path, method = 'GET', body) {
  return fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal'
    },
    body: body ? JSON.stringify(body) : undefined
  }).then(r => r.json().catch(() => ({})));
}

async function checkBanList(type, value) {
  if (!value) return null;
  const rows = await db(`ban_list?type=eq.${type}&value=eq.${encodeURIComponent(value)}&active=eq.true&select=reason&limit=1`);
  return Array.isArray(rows) && rows[0] ? (rows[0].reason || 'Banned') : null;
}

function encodePassword(p) { return Buffer.from(p + ':ppf_salt_2025').toString('base64'); }
function generateToken() { return crypto.randomBytes(32).toString('hex'); }
function validateEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }
function containsSwear(text) {
  const l = (text||'').toLowerCase();
  return SWEAR_WORDS.some(w => l.includes(w));
}
function validateUsername(u) {
  if (u.length < 3) return 'Username must be at least 3 characters';
  if (u.length > 20) return 'Username must be at most 20 characters';
  if (!/^[a-zA-Z0-9_.\-]+$/.test(u)) return 'Username: letters, numbers, _ . - only';
  if (containsSwear(u)) return 'Username contains inappropriate language';
  return null;
}
function getIP(req) {
  return (req.headers['x-forwarded-for']||'').split(',')[0].trim() || req.headers['x-real-ip'] || 'unknown';
}

// Store new device ID if not already recorded for this user
async function storeDevice(userId, deviceId) {
  if (!deviceId || !userId) return;
  try {
    // Check if device already stored
    const existing = await db(`user_devices?user_id=eq.${userId}&device_id=eq.${encodeURIComponent(deviceId)}&select=id&limit=1`);
    if (!Array.isArray(existing) || !existing[0]) {
      await db('user_devices', 'POST', { user_id: userId, device_id: deviceId });
    } else {
      // Update last_seen
      await db(`user_devices?id=eq.${existing[0].id}`, 'PATCH', { last_seen: new Date().toISOString() });
    }
  } catch {}
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { action, email, username, password, identifier, newPassword, token, deviceId } = req.body || {};
  const ip = getIP(req);

  if (action === 'register') {
    if (!email || !username || !password) return res.status(400).json({ error: 'All fields are required' });
    if (!validateEmail(email)) return res.status(400).json({ error: 'Invalid email format' });
    const unErr = validateUsername(username);
    if (unErr) return res.status(400).json({ error: unErr });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const [ipBan, emailBan, userBan, devBan] = await Promise.all([
      checkBanList('ip', ip),
      checkBanList('email', email.toLowerCase().trim()),
      checkBanList('username', username.trim().toLowerCase()),
      deviceId ? checkBanList('device', deviceId) : null
    ]);
    if (ipBan) return res.status(403).json({ error: 'Registration blocked: ' + ipBan });
    if (emailBan) return res.status(403).json({ error: 'This email is banned: ' + emailBan });
    if (userBan) return res.status(403).json({ error: 'This username is banned: ' + userBan });
    if (devBan) return res.status(403).json({ error: 'Device banned: ' + devBan });

    const encoded = encodePassword(password);
    const result = await db('users', 'POST', { email: email.toLowerCase().trim(), username: username.trim(), password_hash: encoded, ip });
    if (result?.code === '23505') {
      return res.status(409).json({ error: result.details?.includes('email') ? 'Email already in use' : 'Username already taken' });
    }
    const user = Array.isArray(result) ? result[0] : result;
    if (!user?.id) return res.status(500).json({ error: 'Registration failed. Please try again.' });

    await storeDevice(user.id, deviceId);
    const tok = generateToken();
    await db('sessions', 'POST', { user_id: user.id, token: tok, expires_at: new Date(Date.now() + 30*24*60*60*1000).toISOString(), ip });
    return res.status(200).json({ token: tok, user: { id: user.id, email: user.email, username: user.username } });
  }

  if (action === 'login') {
    if (!identifier || !password) return res.status(400).json({ error: 'Missing fields' });
    const isEmail = identifier.includes('@');
    const banType = isEmail ? 'email' : 'username';
    const banReason = await checkBanList(banType, identifier.toLowerCase().trim());
    if (banReason) return res.status(403).json({ error: 'Account banned: ' + banReason });

    const encoded = encodePassword(password);
    const field = isEmail ? `email=eq.${encodeURIComponent(identifier.toLowerCase().trim())}` : `username=eq.${encodeURIComponent(identifier.trim())}`;
    const users = await db(`users?${field}&password_hash=eq.${encodeURIComponent(encoded)}`);
    if (!users?.[0]) return res.status(401).json({ error: 'Invalid credentials' });
    const user = users[0];
    if (user.banned) return res.status(403).json({ error: 'This account has been suspended' });

    // Update IP (latest only) and store device
    await db(`users?id=eq.${user.id}`, 'PATCH', { ip, last_seen: new Date().toISOString() });
    await storeDevice(user.id, deviceId);

    const tok = generateToken();
    await db('sessions', 'POST', { user_id: user.id, token: tok, expires_at: new Date(Date.now() + 30*24*60*60*1000).toISOString(), ip });
    return res.status(200).json({ token: tok, user: { id: user.id, email: user.email, username: user.username } });
  }

  if (action === 'verify') {
    if (!token) return res.status(400).json({ error: 'No token' });
    const sessions = await db(`sessions?token=eq.${token}&select=*,users(id,email,username,banned)`);
    if (!sessions?.[0]) return res.status(401).json({ error: 'Invalid session' });
    const sess = sessions[0];
    if (new Date(sess.expires_at) < new Date()) return res.status(401).json({ error: 'Session expired' });
    if (sess.users?.banned) return res.status(403).json({ error: 'Account suspended' });
    if (sess.users?.id) {
      await db(`users?id=eq.${sess.users.id}`, 'PATCH', { ip, last_seen: new Date().toISOString() });
    }
    return res.status(200).json({ user: { id: sess.users.id, email: sess.users.email, username: sess.users.username } });
  }

  if (action === 'logout') {
    if (token) await db(`sessions?token=eq.${token}`, 'DELETE');
    return res.status(200).json({ ok: true });
  }

  if (action === 'change_password') {
    if (!identifier || !password || !newPassword) return res.status(400).json({ error: 'All fields required' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
    const isEmail = identifier.includes('@');
    const field = isEmail ? `email=eq.${encodeURIComponent(identifier.toLowerCase().trim())}` : `username=eq.${encodeURIComponent(identifier.trim())}`;
    const users = await db(`users?${field}&password_hash=eq.${encodeURIComponent(encodePassword(password))}`);
    if (!users?.[0]) return res.status(401).json({ error: 'Invalid credentials' });
    await db(`users?id=eq.${users[0].id}`, 'PATCH', { password_hash: encodePassword(newPassword) });
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
