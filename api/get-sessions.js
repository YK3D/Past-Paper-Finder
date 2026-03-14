export default async function handler(req, res) {
  const { code, slug, board } = req.query;

  if (!code || !slug) {
    return res.status(400).json({ error: 'Missing code or slug' });
  }

  const isAQA = board === 'AQA';
  const BASE = isAQA
    ? 'https://pastpapers.papacambridge.com/papers/aqa/'
    : 'https://pastpapers.papacambridge.com/papers/caie/';

  const url = `${BASE}${slug}`;

  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return res.status(200).json({ sessions: [] });
    const html = await r.text();

    const sessions = [];
    const seen = new Set();

    if (isAQA) {
      // AQA session slugs: june, november
      // Links look like: /papers/aqa/gcsebiology-8461-2024-june
      const escapedSlug = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(escapedSlug + '-(\\d{4})-([a-z-]+)(?=[^a-z0-9-])', 'gi');
      let m;
      while ((m = pattern.exec(html)) !== null) {
        const year = m[1];
        const sessSlug = m[2].toLowerCase();
        let sess = null;
        if (sessSlug === 'june')     sess = 's';
        else if (sessSlug === 'november') sess = 'w';
        else if (sessSlug === 'march')    sess = 'm';
        if (!sess) continue;
        const key = year + sess;
        if (!seen.has(key)) {
          seen.add(key);
          sessions.push({ year, sess, slug: sessSlug });
        }
      }
    } else {
      // CAIE session slugs: may-june, oct-nov, march, etc.
      const escapedSlug = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(escapedSlug + '-(\\d{4})-([a-z-]+)(?=[^a-z0-9-])', 'gi');
      let m;
      while ((m = pattern.exec(html)) !== null) {
        const year = m[1];
        const sessSlug = m[2].toLowerCase();
        let sess = null;
        if (sessSlug === 'may-june')    sess = 's';
        else if (sessSlug === 'jun')    sess = 's';
        else if (sessSlug === 'oct-nov') sess = 'w';
        else if (sessSlug === 'nov')    sess = 'w';
        else if (sessSlug === 'march')  sess = 'm';
        else if (sessSlug === 'feb-march') sess = 'm';
        else if (sessSlug === 'mar')    sess = 'm';
        if (!sess) continue;
        const key = year + sess;
        if (!seen.has(key)) {
          seen.add(key);
          sessions.push({ year, sess, slug: sessSlug });
        }
      }
    }

    const ORDER = { s: 0, m: 1, w: 2 };
    sessions.sort((a, b) => parseInt(b.year) - parseInt(a.year) || ORDER[a.sess] - ORDER[b.sess]);

    return res.status(200).json({ sessions });
  } catch (e) {
    return res.status(200).json({ sessions: [], error: e.message });
  }
}
