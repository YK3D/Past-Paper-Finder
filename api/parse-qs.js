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

  const GROQ_KEY = process.env.QS_GROQ || process.env.GROQ_API_KEY_3 || process.env.GROQ_API_KEY_2 || process.env.GROQ_API_KEY;
  if (!GROQ_KEY) return res.status(500).json({ error: 'No Groq key configured' });

  // Fetch from caiefinder server-side
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
    if (!caieResp.ok) return res.status(200).json({ results: [], error: 'caiefinder returned ' + caieResp.status });
    rawText = await caieResp.text();
  } catch(e) {
    return res.status(200).json({ results: [], error: 'caiefinder fetch failed: ' + e.message });
  }

  // Strip HTML
  rawText = rawText
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n') // collapse excessive blank lines
    .trim();

  if (!rawText || rawText.length < 20) {
    return res.status(200).json({ results: [] });
  }

  // Split into blocks before sending to AI — keep max 5 blocks to stay under TPM
  const lines = rawText.split('\n');
  const blocks = [];
  let buf = [];
  for (let li = 0; li < lines.length; li++) {
    const l = lines[li];
    const nl = lines[li + 1] || '';
    if (buf.length && /^[A-Z]/.test(l) && /\(\d{4}\)/.test(l) && nl.includes('\u2193 FOUND \u2193')) {
      blocks.push(buf.join('\n'));
      buf = [];
    }
    buf.push(l);
  }
  if (buf.length) blocks.push(buf.join('\n'));

  // Keep only blocks that contain ↓ FOUND ↓, max 5
  const validBlocks = blocks.filter(b => b.includes('\u2193 FOUND \u2193')).slice(0, 5);
  if (!validBlocks.length) return res.status(200).json({ results: [] });

  // Send each block to AI individually to stay under TPM
  const base = 'https://pastpapers.papacambridge.com/directories/CAIE/CAIE-pastpapers/upload/';
  const results = [];

  for (const block of validBlocks) {
    // First try to extract filenames with regex — no AI needed for that
    const foundMatch = block.match(/\u2193 FOUND \u2193 in (\w+) \u2190/);
    const msMatch    = block.match(/\u2193 Below is the answer[^\n]* in (\w+) \u2190/);
    const headerMatch = block.match(/^([A-Z][^\n]+\((\d{4})\)\s+([\w/]+)\s+(\d{4})(?:.*?Varient:\s*(\d+))?(?:.*?Paper:\s*(\d+))?)/m);

    if (!headerMatch) continue;

    const hLine    = headerMatch[1];
    const dashIdx  = hLine.indexOf(' - ');
    const examLevel = dashIdx > -1 ? hLine.substring(0, dashIdx).trim() : '';
    const subject  = dashIdx > -1 ? hLine.substring(dashIdx + 3, hLine.indexOf('(')).trim() : '';
    const code     = headerMatch[2];
    const session  = headerMatch[3];
    const year     = headerMatch[4];
    const variant  = headerMatch[5] || '';
    const paper    = headerMatch[6] || '';
    const qpFile   = foundMatch ? foundMatch[1] : '';
    const msFile   = msMatch    ? msMatch[1]    : (qpFile ? qpFile.replace('_qp_', '_ms_') : '');

    // Strip the "Total search results: N" prefix if present
    const headerIdx = block.search(/^[A-Z][^\n]+\(\d{4}\)/m);
    const cleanBlock = headerIdx > 0 ? block.substring(headerIdx).trim() : block.trim();

    results.push({
      subject, code, exam: examLevel, year, session,
      variant, paper,
      qpFile, msFile,
      rawBlock: cleanBlock
    });
  }

  return res.status(200).json({ results });
};

module.exports.config = { api: { bodyParser: { sizeLimit: '1mb' } } };
