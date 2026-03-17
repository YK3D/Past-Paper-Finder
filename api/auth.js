import crypto from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

const SWEAR_WORDS = ['fuck','shit','bitch','ass','cunt','dick','cock','pussy','bastard','whore','slut','nigger','faggot','twat','wanker','piss','arse','bollocks', 'nigga'];

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

// Base64 encode password (reversible — user is aware of security trade-off)
function encodePassword(password) {
  return Buffer.from(password + ':ppf_salt_2025').toString('base64');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validateUsername(username) {
  if (username.length < 3) return 'Username must be at least 3 characters';
  if (username.length > 20) return 'Username must be at most 20 characters';
  if (!/^[a-zA-Z0-9_.\-]+$/.test(username)) return 'Username: letters, numbers, _ . - only';
  const lower = username.toLowerCase();
  for (const word of SWEAR_WORDS) {
    if (lower.includes(word)) return 'Username contains inappropriate language';
  }
  return null;
}

function getIP(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.headers['x-real-ip']
    || 'unknown';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { action, email, username, password, identifier, newPassword, token } = req.body || {};
  const ip = getIP(req);

  // ── Register ──
  if (action === 'register') {
    if (!email || !username || !password) return res.status(400).json({ error: 'All fields are required' });
    if (!validateEmail(email)) return res.status(400).json({ error: 'Invalid email format' });
    const unErr = validateUsername(username);
    if (unErr) return res.status(400).json({ error: unErr });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const encoded = encodePassword(password);
    const result = await db('users', 'POST', {
      email: email.toLowerCase().trim(),
      username: username.trim(),
      password_hash: encoded,
      ip
    });

    if (result && result.code === '23505') {
      const msg = result.details && result.details.includes('email') ? 'Email already in use' : 'Username already taken';
      return res.status(409).json({ error: msg });
    }
    const user = Array.isArray(result) ? result[0] : result;
    if (!user || !user.id) return res.status(500).json({ error: 'Registration failed. Please try again.' });

    const tok = generateToken();
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await db('sessions', 'POST', { user_id: user.id, token: tok, expires_at: expires, ip });
    return res.status(200).json({ token: tok, user: { id: user.id, email: user.email, username: user.username } });
  }

  // ── Login ──
  if (action === 'login') {
    if (!identifier || !password) return res.status(400).json({ error: 'Missing fields' });
    const encoded = encodePassword(password);
    const isEmail = identifier.includes('@');
    const field = isEmail
      ? 'email=eq.' + encodeURIComponent(identifier.toLowerCase().trim())
      : 'username=eq.' + encodeURIComponent(identifier.trim());
    const users = await db('users?' + field + '&password_hash=eq.' + encodeURIComponent(encoded));
    if (!users || !users[0]) return res.status(401).json({ error: 'Invalid credentials' });
    const user = users[0];
    if (user.banned) return res.status(403).json({ error: 'This account has been suspended' });

    // Update last IP
    await db('users?id=eq.' + user.id, 'PATCH', { ip });

    const tok = generateToken();
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await db('sessions', 'POST', { user_id: user.id, token: tok, expires_at: expires, ip });
    return res.status(200).json({ token: tok, user: { id: user.id, email: user.email, username: user.username } });
  }

  // ── Verify ──
  if (action === 'verify') {
    if (!token) return res.status(400).json({ error: 'No token' });
    const sessions = await db('sessions?token=eq.' + token + '&select=*,users(id,email,username,banned)');
    if (!sessions || !sessions[0]) return res.status(401).json({ error: 'Invalid session' });
    const sess = sessions[0];
    if (new Date(sess.expires_at) < new Date()) return res.status(401).json({ error: 'Session expired' });
    if (sess.users && sess.users.banned) return res.status(403).json({ error: 'Account suspended' });
    // Update IP on verify too
    if (sess.users) {
      await db('users?id=eq.' + sess.users.id, 'PATCH', { ip });
      await db('sessions?token=eq.' + token, 'PATCH', { ip });
    }
    return res.status(200).json({ user: { id: sess.users.id, email: sess.users.email, username: sess.users.username } });
  }

  // ── Logout ──
  if (action === 'logout') {
    if (token) await db('sessions?token=eq.' + token, 'DELETE');
    return res.status(200).json({ ok: true });
  }

  // ── Change password ──
  if (action === 'change_password') {
    if (!identifier || !password || !newPassword) return res.status(400).json({ error: 'All fields required' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
    const oldEncoded = encodePassword(password);
    const isEmail = identifier.includes('@');
    const field = isEmail ? 'email=eq.' + encodeURIComponent(identifier.toLowerCase().trim()) : 'username=eq.' + encodeURIComponent(identifier.trim());
    const users = await db('users?' + field + '&password_hash=eq.' + encodeURIComponent(oldEncoded));
    if (!users || !users[0]) return res.status(401).json({ error: 'Invalid credentials' });
    const newEncoded = encodePassword(newPassword);
    await db('users?id=eq.' + users[0].id, 'PATCH', { password_hash: newEncoded });
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
