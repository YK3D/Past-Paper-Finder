export default async function handler(req, res) {
  const { url } = req.query;
  if (!url || !url.startsWith('https://pastpapers.papacambridge.com/papers/caie/')) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return res.status(200).json({ types: [], variants: {} });
    const html = await r.text();

    // Extract all upload filenames — handles any type code
    const filePattern = /upload\/(\d{4}_[smw]\d{2,4}_([a-z]+)(?:_(\d+))?\.pdf)/gi;
    const types = {};
    let m;
    while ((m = filePattern.exec(html)) !== null) {
      const type = m[2].toLowerCase();
      const variant = m[3] || null;
      if (!types[type]) types[type] = new Set();
      if (variant) types[type].add(variant);
    }

    // Convert sets to sorted arrays
    const result = {};
    for (const [t, vs] of Object.entries(types)) {
      result[t] = [...vs].sort((a, b) => parseInt(a) - parseInt(b));
    }

    // Sort types in logical order: qp, ms, gt/gb, er, ci, then rest alphabetically
    const TYPE_ORDER = ['qp','ms','gt','gb','er','ci','in','sf','sg','sp','sm'];
    const sortedTypes = Object.keys(result).sort((a, b) => {
      const ai = TYPE_ORDER.indexOf(a);
      const bi = TYPE_ORDER.indexOf(b);
      if (ai === -1 && bi === -1) return a.localeCompare(b);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });

    return res.status(200).json({ types: sortedTypes, variants: result });
  } catch (e) {
    return res.status(200).json({ types: [], variants: {}, error: e.message });
  }
}
