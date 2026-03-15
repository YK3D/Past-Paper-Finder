import crypto from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

function db(path, method='GET', body) {
  return fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : ''
    },
    body: body ? JSON.stringify(body) : undefined
  }).then(r => r.json());
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'ppf_salt_2025').digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { action, email, username, password, identifier } = req.body || {};

  if (action === 'register') {
    if (!email || !username || !password) return res.status(400).json({ error: 'Missing fields' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const hash = hashPassword(password);
    const result = await db('users', 'POST', { email: email.toLowerCase(), username, password_hash: hash });

    if (result.code === '23505') {
      const msg = result.details && result.details.includes('email') ? 'Email already in use' : 'Username already taken';
      return res.status(409).json({ error: msg });
    }
    if (!result[0]) return res.status(500).json({ error: 'Registration failed' });

    const user = result[0];
    const token = generateToken();
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await db('sessions', 'POST', { user_id: user.id, token, expires_at: expires });

    return res.status(200).json({ token, user: { id: user.id, email: user.email, username: user.username } });
  }

  if (action === 'login') {
    if (!identifier || !password) return res.status(400).json({ error: 'Missing fields' });
    const hash = hashPassword(password);
    const isEmail = identifier.includes('@');
    const field = isEmail ? 'email=eq.' + identifier.toLowerCase() : 'username=eq.' + identifier;
    const users = await db('users?' + field + '&password_hash=eq.' + hash);

    if (!users || !users[0]) return res.status(401).json({ error: 'Invalid credentials' });
    const user = users[0];

    const token = generateToken();
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await db('sessions', 'POST', { user_id: user.id, token, expires_at: expires });

    return res.status(200).json({ token, user: { id: user.id, email: user.email, username: user.username } });
  }

  if (action === 'verify') {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'No token' });
    const sessions = await db('sessions?token=eq.' + token + '&select=*,users(id,email,username)');
    if (!sessions || !sessions[0]) return res.status(401).json({ error: 'Invalid session' });
    const sess = sessions[0];
    if (new Date(sess.expires_at) < new Date()) return res.status(401).json({ error: 'Session expired' });
    return res.status(200).json({ user: sess.users });
  }

  if (action === 'logout') {
    const { token } = req.body;
    if (token) await db('sessions?token=eq.' + token, 'DELETE');
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
