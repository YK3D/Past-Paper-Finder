// Stores ratings so they appear in your Vercel dashboard logs
// Each rating is logged as a structured message — visible in:
// Vercel Dashboard → your project → Logs tab

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { rating, ts } = req.body || {};
  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Invalid rating' });
  }

  // Log to Vercel — visible in dashboard Logs tab
  console.log(JSON.stringify({
    event: 'rating',
    stars: Number(rating),
    timestamp: new Date(ts || Date.now()).toISOString(),
    ip: req.headers['x-forwarded-for'] || 'unknown'
  }));

  return res.status(200).json({ ok: true });
}
