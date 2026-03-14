export default async function handler(req, res) {
  const { code, slug } = req.query;

  if (!code || !slug) {
    return res.status(400).json({ error: 'Missing code or slug' });
  }

  // One single fetch of the subject page — it lists all available year/session links
  const url = `https://pastpapers.papacambridge.com/papers/caie/${slug}`;

  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return res.status(200).json({ sessions: [] });
    const html = await r.text();

    // Extract links like: /papers/caie/igcse-mathematics-0580-2023-may-june
    // Escape the slug for use in regex (handle hyphens and digits safely)
    const escapedSlug = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(escapedSlug + '-(\\d{4})-([a-z-]+)(?=[^a-z0-9-])', 'gi');

    const seen = new Set();
    const sessions = [];
    let m;

    while ((m = pattern.exec(html)) !== null) {
      const year = m[1];
      const sessSlug = m[2].toLowerCase();

      let sess = null;
      if (sessSlug === 'may-june')   sess = 's';
      else if (sessSlug === 'jun')   sess = 's';
      else if (sessSlug === 'oct-nov') sess = 'w';
      else if (sessSlug === 'nov')   sess = 'w';
      else if (sessSlug === 'march') sess = 'm';
      else if (sessSlug === 'feb-march') sess = 'm';
      else if (sessSlug === 'mar')   sess = 'm';

      if (!sess) continue;
      const key = year + sess;
      if (!seen.has(key)) {
        seen.add(key);
        sessions.push({ year, sess, slug: sessSlug });
      }
    }

    const ORDER = { s: 0, m: 1, w: 2 };
    sessions.sort((a, b) => parseInt(b.year) - parseInt(a.year) || ORDER[a.sess] - ORDER[b.sess]);

    return res.status(200).json({ sessions });
  } catch (e) {
    return res.status(200).json({ sessions: [], error: e.message });
  }
}
