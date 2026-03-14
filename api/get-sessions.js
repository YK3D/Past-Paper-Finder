export default async function handler(req, res) {
  const { code, slug } = req.query;
  if (!code || !slug) return res.status(400).json({ error: 'Missing code or slug' });

  const UPLOAD = 'https://pastpapers.papacambridge.com/directories/CAIE/CAIE-pastpapers/upload/';
  const currentYear = new Date().getFullYear();

  // Map session letter to 2-digit year suffix
  // Try to find QP or MS for the most common paper (paper 1 = _11 or _1)
  const sessLetters = (year) => {
    const yy = String(year).slice(2);
    const candidates = [];
    // s = May/June
    candidates.push({ sess: 's', sessSlug: year >= 2018 ? 'may-june' : 'jun',
      probe: `${code}_s${yy}_qp_11.pdf` });
    // w = Oct/Nov  
    candidates.push({ sess: 'w', sessSlug: year >= 2018 ? 'oct-nov' : 'nov',
      probe: `${code}_w${yy}_qp_11.pdf` });
    // m = Feb/Mar (only 2018+)
    if (year >= 2018) {
      const mSlug = year === 2022 ? 'feb-march' : year >= 2023 ? 'march' : 'march';
      candidates.push({ sess: 'm', sessSlug: mSlug,
        probe: `${code}_m${yy}_qp_11.pdf` });
    }
    return candidates;
  };

  // For each candidate, try multiple paper numbers since not all subjects use _11
  const probeVariants = (code, sessLetter, yy) => [
    `${code}_${sessLetter}${yy}_qp_11.pdf`,
    `${code}_${sessLetter}${yy}_qp_1.pdf`,
    `${code}_${sessLetter}${yy}_ms_11.pdf`,
    `${code}_${sessLetter}${yy}_ms_1.pdf`,
    `${code}_${sessLetter}${yy}_qp_12.pdf`,
    `${code}_${sessLetter}${yy}_gt.pdf`,
  ];

  const checkSession = async (year, sess, sessSlug) => {
    const yy = String(year).slice(2);
    const probes = probeVariants(code, sess, yy);
    // Try all probes in parallel — if any exists, session exists
    const results = await Promise.all(probes.map(async (file) => {
      try {
        const r = await fetch(UPLOAD + file, {
          method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const ct = r.headers.get('content-type') || '';
        return r.ok && (ct.includes('pdf') || ct.includes('octet'));
      } catch { return false; }
    }));
    return results.some(Boolean);
  };

  const checkYear = async (year) => {
    const sessions = sessLetters(year);
    const results = await Promise.all(
      sessions.map(async ({ sess, sessSlug }) => {
        const exists = await checkSession(year, sess, sessSlug);
        return exists ? { year: String(year), sess, slug: sessSlug } : null;
      })
    );
    return results.filter(Boolean);
  };

  // Phase 1: last 10 years in parallel
  const recentYears = [];
  for (let y = currentYear; y >= currentYear - 9; y--) recentYears.push(y);
  const recentResults = await Promise.all(recentYears.map(y => checkYear(y)));
  let sessions = recentResults.flat();

  // Phase 2: if papers exist in oldest recent year, check further back
  const oldest = sessions.length > 0
    ? Math.min(...sessions.map(s => parseInt(s.year))) : null;

  if (oldest && oldest <= currentYear - 8) {
    const olderYears = [];
    for (let y = currentYear - 10; y >= 1990; y--) olderYears.push(y);
    const olderResults = await Promise.all(olderYears.map(y => checkYear(y)));
    sessions = sessions.concat(olderResults.flat());
  }

  const ORDER = { s: 0, m: 1, w: 2 };
  sessions.sort((a, b) => parseInt(b.year) - parseInt(a.year) || ORDER[a.sess] - ORDER[b.sess]);
  return res.status(200).json({ sessions });
}
