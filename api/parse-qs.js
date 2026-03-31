module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (!body || typeof body === 'string') {
    try { body = JSON.parse(body || '{}'); } catch(e) {
      body = await new Promise((resolve) => {
        let data = '';
        req.on('data', chunk => { data += chunk; });
        req.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({}); } });
      });
    }
  }

  const { query, subs, zone } = body || {};
  if (!query) return res.status(400).json({ error: 'No query provided' });

  const params = new URLSearchParams();
  params.set('subs', subs || '');
  params.set('zone', zone || '');
  params.set('search', query);

  let rawText;
  try {
    const caieResp = await fetch('https://data.caiefinder.com/search/data/?' + params.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
        'Accept': 'text/html,*/*',
        'Referer': 'https://caiefinder.com/',
        'Origin': 'https://caiefinder.com'
      }
    });
    if (!caieResp.ok) return res.status(200).json({ results: [], error: 'caiefinder HTTP ' + caieResp.status });
    rawText = await caieResp.text();
  } catch(e) {
    return res.status(200).json({ results: [], error: 'caiefinder fetch failed: ' + e.message });
  }

  // Strip HTML
  const text = rawText
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .trim();

  if (!text || text.length < 20) {
    return res.status(200).json({ results: [], error: 'Empty response from caiefinder' });
  }

  // Split on every occurrence of a line matching the exam header pattern
  // Use a regex split on the header pattern so we capture each exam separately
  const base = 'https://pastpapers.papacambridge.com/directories/CAIE/CAIE-pastpapers/upload/';
  const results = [];

  // Find all positions where a new exam header starts
  // Pattern: line starting with "IGCSE - " or "O Levels - " or "A Levels - " etc.
  const headerRe = /(?:^|\n)((?:IGCSE|O Levels?|A Levels?|International AS)[^\n]+\(\d{4}\)[^\n]+)\n(↓ FOUND ↓[^\n]*)/g;
  let match;
  const starts = [];

  while ((match = headerRe.exec(text)) !== null) {
    starts.push({ pos: match.index === 0 ? 0 : match.index + 1, header: match[1], foundLine: match[2] });
  }

  if (!starts.length) {
    return res.status(200).json({ results: [], error: 'No exam headers found' });
  }

  for (let i = 0; i < starts.length && results.length < 8; i++) {
    const blockStart = starts[i].pos;
    const blockEnd   = i + 1 < starts.length ? starts[i + 1].pos : text.length;
    const block      = text.substring(blockStart, blockEnd).trim();
    const hLine      = starts[i].header;
    const foundLine  = starts[i].foundLine;

    // Parse header
    const hm = hLine.match(/^(.+?)\s+\((\d{4})\)\s+([\w/]+)\s+(\d{4})(?:.*?Varient:\s*(\d+))?(?:.*?Paper:\s*(\d+))?/i);
    if (!hm) continue;

    const dashIdx   = hLine.indexOf(' - ');
    const examLevel = dashIdx > -1 ? hLine.substring(0, dashIdx).trim() : '';
    const subject   = dashIdx > -1 ? hLine.substring(dashIdx + 3, hLine.indexOf('(')).trim() : hm[1];
    const code      = hm[2];
    const session   = hm[3];
    const year      = hm[4];
    const variant   = hm[5] || '';
    const paper     = hm[6] || '';

    // Extract filenames
    const qpMatch = foundLine.match(/in\s+(\w+)\s*←/);
    const msLineM = block.match(/↓ Below is the answer[^\n]* in\s+(\w+)\s*←/);
    const qpFile  = qpMatch ? qpMatch[1] : '';
    const msFile  = msLineM ? msLineM[1] : (qpFile ? qpFile.replace('_qp_', '_ms_') : '');

    results.push({
      subject, code, exam: examLevel, year, session, variant, paper,
      qpFile, msFile,
      rawBlock: block
    });
  }

  return res.status(200).json({ results });
};

module.exports.config = { api: { bodyParser: { sizeLimit: '1mb' } } };
