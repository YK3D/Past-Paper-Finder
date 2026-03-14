// Leaderboard API — uses Vercel KV if available, falls back to in-memory
// To enable persistence: add Vercel KV to your project at vercel.com/dashboard
// then run: vercel env pull

let memStore = {};

async function getKV() {
  try {
    // Try Vercel KV
    const { kv } = await import('@vercel/kv');
    return kv;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const kv = await getKV();

  if (req.method === 'GET') {
    if (kv) {
      const data = await kv.get('leaderboard') || {};
      return res.status(200).json(data);
    }
    return res.status(200).json(memStore);
  }

  if (req.method === 'POST') {
    const { id, name, increment } = req.body || {};
    if (!id || !name) return res.status(400).json({ error: 'Missing id or name' });

    if (kv) {
      const data = await kv.get('leaderboard') || {};
      if (!data[id]) data[id] = { name, count: 0 };
      data[id].name = name;
      if (increment) data[id].count = (data[id].count || 0) + 1;
      await kv.set('leaderboard', data);
      return res.status(200).json(data[id]);
    } else {
      if (!memStore[id]) memStore[id] = { name, count: 0 };
      memStore[id].name = name;
      if (increment) memStore[id].count = (memStore[id].count || 0) + 1;
      return res.status(200).json(memStore[id]);
    }
  }

  res.status(405).end();
}
