module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=300');
  if (req.method !== 'GET') return res.status(405).end();

  const q    = (req.query.q    || '').trim();
  const subs = (req.query.subs || '').trim();
  const zone = (req.query.zone || '').trim();
  if (!q) return res.status(400).json({ error: 'No query' });

  try {
    // Exact API used by caiefinder's JS bundle
    const params = new URLSearchParams({ search: q });
    if (subs) params.set('subs', subs);
    if (zone) params.set('zone', zone);

    const apiUrl = 'https://data.caiefinder.com/search/data/?' + params.toString();

    const r = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Referer': 'https://caiefinder.com/search/?' + params.toString(),
        'Origin': 'https://caiefinder.com',
      }
    });

    if (!r.ok) return res.status(r.status).json({ error: 'data.caiefinder.com returned ' + r.status });

    const html = await r.text();
    const results = parseHtml(html);
    return res.status(200).json({ results });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};

// Parse caiefinder's HTML response — results are rendered as divs/links with paper info
function parseHtml(html) {
  const results = [];

  // Extract total count (for info only)
  // const totalMatch = html.match(/Total search results:.*?(\d+)/i);

  // caiefinder renders each result as a block containing:
  // - subject name, code, year, session
  // - a link to /pastpapers/view/[level]/[Subject (code)]/[year]/filename.pdf
  // - question text in a div with class "quesdata" or similar

  // Extract all PDF links with their surrounding context
  const pdfPattern = /href="(\/pastpapers\/(?:view|pdf)\/[^"]+\.pdf)"/gi;
  const seen = new Set();
  let match;

  while ((match = pdfPattern.exec(html)) !== null) {
    const path = match[1]; // e.g. /pastpapers/view/IGCSE/Mathematics (0580)/2023/0580_s23_qp_12.pdf
    const filename = path.split('/').pop();
    if (seen.has(filename)) continue;
    seen.add(filename);

    // Only process QP files
    const fileMatch = filename.match(/^(\d{4})_([smw])(\d{2})_([a-z]+)(?:_(\d{1,2}))?\.pdf$/i);
    if (!fileMatch) continue;
    if (fileMatch[4] !== 'qp' && fileMatch[4] !== 'in' && fileMatch[4] !== 'ci') continue;

    const code    = fileMatch[1];
    const sess    = fileMatch[2];
    const yr      = fileMatch[3];
    const variant = fileMatch[5] || '';
    const session = sess === 's' ? 'May/June' : sess === 'w' ? 'Oct/Nov' : 'Feb/Mar';

    // Extract subject and level from path
    const parts   = path.split('/');
    // parts: ['', 'pastpapers', 'view', 'IGCSE', 'Mathematics (0580)', '2023', 'filename.pdf']
    const level   = parts[3] || '';
    const subject = (parts[4] || '').replace(/\s*\(\d+\)$/, '').trim() || codeToSubject(code);

    // Extract question text — find the surrounding text near this link
    const linkIdx = html.indexOf(match[0]);
    // Look for quesdata class or surrounding text
    const before  = html.substring(Math.max(0, linkIdx - 600), linkIdx);
    const after   = html.substring(linkIdx, Math.min(html.length, linkIdx + 600));
    const chunk   = (before + after).replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

    const base  = 'https://pastpapers.papacambridge.com/directories/CAIE/CAIE-pastpapers/upload/';
    const qpFn  = filename;
    const msFn  = qpFn.replace(/_qp_/, '_ms_').replace(/_in_/, '_ms_').replace(/_ci_/, '_ms_');

    results.push({
      subject,
      code,
      exam:    level,
      year:    '20' + yr,
      session,
      paper:   variant ? 'Variant ' + parseInt(variant) : '',
      question: chunk.length > 20 ? chunk.substring(0, 320) + '…' : 'See paper',
      qpUrl:   base + qpFn,
      msUrl:   base + msFn,
      sourceUrl: 'https://caiefinder.com' + path.replace('/pdf/', '/view/'),
    });

    if (results.length >= 8) break;
  }

  return results;
}

const SUBJECT_MAP = {
  '0580':'Mathematics','0625':'Physics','0620':'Chemistry','0610':'Biology',
  '0450':'Business Studies','0455':'Economics','0500':'English Language',
  '0478':'Computer Science','0470':'History','0460':'Geography',
  '9709':'Mathematics','9702':'Physics','9701':'Chemistry','9700':'Biology',
  '9708':'Economics','9609':'Business Studies','9618':'Computer Science',
  '0417':'Computer Science','0452':'Accounting','9706':'Accounting',
  '0606':'Additional Mathematics','0607':'Cambridge International Mathematics',
};
function codeToSubject(code) { return SUBJECT_MAP[code] || code; }
