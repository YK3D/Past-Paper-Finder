export default async function handler(req, res) {
  const { code, slug } = req.query;

  if (!code || !slug) {
    return res.status(400).json({ error: 'Missing code or slug' });
  }

  const BASE = 'https://pastpapers.papacambridge.com/papers/caie/';
  const currentYear = new Date().getFullYear();

  // Session slugs to try for each year
  // Modern (2018+): may-june, oct-nov, march (+ feb-march for 2022)
  // Older: jun, nov, mar
  const getSessionSlugs = (year) => {
    if (year >= 2023) return [
      { sess: 's', slug: 'may-june' },
      { sess: 'w', slug: 'oct-nov' },
      { sess: 'm', slug: 'march' },
    ];
    if (year === 2022) return [
      { sess: 's', slug: 'may-june' },
      { sess: 'w', slug: 'oct-nov' },
      { sess: 'm', slug: 'feb-march' },
    ];
    if (year >= 2018) return [
      { sess: 's', slug: 'may-june' },
      { sess: 'w', slug: 'oct-nov' },
      { sess: 'm', slug: 'march' },
    ];
    if (year >= 2016) return [
      { sess: 's', slug: 'jun' },
      { sess: 'w', slug: 'nov' },
      { sess: 'm', slug: 'mar' },
    ];
    return [
      { sess: 's', slug: 'jun' },
      { sess: 'w', slug: 'nov' },
    ];
  };

  // Check if a session page exists by doing a HEAD request
  const checkUrl = async (url) => {
    try {
      const r = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0' } });
      return r.ok;
    } catch { return false; }
  };

  const sessions = [];

  // Scan years from current down to 1990, stop when we hit 3 consecutive empty years
  let emptyYears = 0;
  for (let year = currentYear; year >= 1990; year--) {
    const sessOptions = getSessionSlugs(year);
    const yearHits = [];

    // Check all sessions for this year in parallel
    const checks = await Promise.all(
      sessOptions.map(async ({ sess, slug: sessSlug }) => {
        const url = `${BASE}${slug}-${year}-${sessSlug}`;
        const exists = await checkUrl(url);
        return exists ? { year: String(year), sess, slug: sessSlug } : null;
      })
    );

    checks.forEach(hit => { if (hit) yearHits.push(hit); });

    if (yearHits.length > 0) {
      sessions.push(...yearHits);
      emptyYears = 0;
    } else {
      emptyYears++;
      // Stop scanning if 3 consecutive years with no results (but always scan at least 5 years back)
      if (emptyYears >= 3 && year < currentYear - 5) break;
    }
  }

  // Sort: newest first, then s/m/w
  const ORDER = { s: 0, m: 1, w: 2 };
  sessions.sort((a, b) => parseInt(b.year) - parseInt(a.year) || ORDER[a.sess] - ORDER[b.sess]);

  return res.status(200).json({ sessions });
}
