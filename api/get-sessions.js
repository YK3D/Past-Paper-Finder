export default async function handler(req, res) {
  const { code, slug } = req.query;

  if (!code || !slug) {
    return res.status(400).json({ error: 'Missing code or slug' });
  }

  const BASE = 'https://pastpapers.papacambridge.com/papers/caie/';
  const currentYear = new Date().getFullYear();

  // Build all session URL candidates for a given year
  const getCandidates = (year) => {
    const y = parseInt(year);
    if (y === 2022) return [
      { sess: 's', sessSlug: 'may-june' },
      { sess: 'w', sessSlug: 'oct-nov' },
      { sess: 'm', sessSlug: 'feb-march' },
    ];
    if (y >= 2018) return [
      { sess: 's', sessSlug: 'may-june' },
      { sess: 'w', sessSlug: 'oct-nov' },
      { sess: 'm', sessSlug: 'march' },
    ];
    if (y >= 2016) return [
      { sess: 's', sessSlug: 'jun' },
      { sess: 'w', sessSlug: 'nov' },
      { sess: 'm', sessSlug: 'mar' },
    ];
    return [
      { sess: 's', sessSlug: 'jun' },
      { sess: 'w', sessSlug: 'nov' },
    ];
  };

  // Fire all years 2000→current in one parallel batch
  // Then only go back to 1990 if we found results in 2000-2005
  const checkYear = async (year) => {
    const candidates = getCandidates(year);
    const checks = await Promise.all(candidates.map(async ({ sess, sessSlug }) => {
      try {
        const url = `${BASE}${slug}-${year}-${sessSlug}`;
        const r = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0' } });
        return r.ok ? { year: String(year), sess, slug: sessSlug } : null;
      } catch { return null; }
    }));
    return checks.filter(Boolean);
  };

  // Scan 2000→currentYear all in parallel (fast batch)
  const recentYears = [];
  for (let y = 2000; y <= currentYear; y++) recentYears.push(y);

  const recentResults = await Promise.all(recentYears.map(y => checkYear(y)));
  let sessions = recentResults.flat();

  // If we have results near 2000-2005, also check 1990-1999
  const hasOld = sessions.some(s => parseInt(s.year) <= 2005);
  if (hasOld) {
    const oldYears = [];
    for (let y = 1990; y < 2000; y++) oldYears.push(y);
    const oldResults = await Promise.all(oldYears.map(y => checkYear(y)));
    sessions = sessions.concat(oldResults.flat());
  }

  // Sort: newest first, then s/m/w
  const ORDER = { s: 0, m: 1, w: 2 };
  sessions.sort((a, b) => parseInt(b.year) - parseInt(a.year) || ORDER[a.sess] - ORDER[b.sess]);

  return res.status(200).json({ sessions });
}
