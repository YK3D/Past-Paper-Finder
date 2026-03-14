export default async function handler(req, res) {
const { code, slug } = req.query;

if (!code || !slug) {
return res.status(400).json({ error: ‘Missing code or slug’ });
}

const url = `https://pastpapers.papacambridge.com/papers/caie/${slug}`;

try {
const r = await fetch(url, { headers: { ‘User-Agent’: ‘Mozilla/5.0’ } });
if (!r.ok) return res.status(200).json({ sessions: [] });
const html = await r.text();

```
// Extract all links of the form: /papers/caie/SLUG-YYYY-SESSION
// Use a generic pattern that captures year and session slug from any subject page link
const linkPattern = /\/papers\/caie\/[a-z0-9-]+-(\d{4})-([a-z-]+)(?=['"\s])/gi;
const seen = new Set();
const sessions = [];
let m;

while ((m = linkPattern.exec(html)) !== null) {
  const year = m[1];
  const sessSlug = m[2].toLowerCase();

  // Only include if the full link starts with our slug
  const fullMatch = m[0].replace('/papers/caie/', '');
  if (!fullMatch.startsWith(slug + '-')) continue;

  let sess = null;
  if (/^(oct-nov|nov)$/.test(sessSlug)) sess = 'w';
  else if (/^(may-june|jun)$/.test(sessSlug)) sess = 's';
  else if (/^(march|feb-march|mar)$/.test(sessSlug)) sess = 'm';

  if (!sess) continue;
  const key = year + sess;
  if (!seen.has(key)) {
    seen.add(key);
    sessions.push({ year, sess, slug: sessSlug });
  }
}

// Sort descending by year, then s/m/w
const ORDER = { s: 0, m: 1, w: 2 };
sessions.sort((a, b) => parseInt(b.year) - parseInt(a.year) || ORDER[a.sess] - ORDER[b.sess]);

return res.status(200).json({ sessions });
```

} catch (e) {
return res.status(200).json({ sessions: [], error: e.message });
}
}