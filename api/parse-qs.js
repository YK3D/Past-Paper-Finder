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

  // Fetch from caiefinder server-side
  const params = new URLSearchParams();
  params.set('subs', subs || '');
  params.set('zone', zone || '');
  params.set('search', query);
  const caieUrl = 'https://data.caiefinder.com/search/data/?' + params.toString();

  let rawText;
  try {
    const caieResp = await fetch(caieUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
        'Accept': 'text/html,*/*',
        'Referer': 'https://caiefinder.com/',
        'Origin': 'https://caiefinder.com'
      }
    });
    if (!caieResp.ok) {
      return res.status(200).json({ results: [], error: 'caiefinder HTTP ' + caieResp.status, debug: caieUrl });
    }
    rawText = await caieResp.text();
  } catch(e) {
    return res.status(200).json({ results: [], error: 'caiefinder fetch failed: ' + e.message, debug: caieUrl });
  }

  // Strip HTML
  const stripped = rawText
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!stripped || stripped.length < 20) {
    return res.status(200).json({ results: [], error: 'Empty response from caiefinder', debug: { rawLen: rawText.length, strippedLen: stripped.length } });
  }

  // Split into per-exam blocks
  const lines = stripped.split('\n');
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

  const validBlocks = blocks.filter(b => b.includes('\u2193 FOUND \u2193')).slice(0, 5);

  if (!validBlocks.length) {
    return res.status(200).json({
      results: [],
      error: 'No exam blocks found after parsing',
      debug: {
        totalBlocks: blocks.length,
        strippedPreview: stripped.substring(0, 300),
        firstLine: lines[0],
        hasFoundArrow: stripped.includes('\u2193 FOUND \u2193')
      }
    });
  }

  const results = [];
  for (const block of validBlocks) {
    const foundMatch  = block.match(/\u2193 FOUND \u2193 in (\w+)\s*\u2190/);
    const msMatch     = block.match(/\u2193 Below is the answer[^\n]* in (\w+)\s*\u2190/);
    const headerMatch = block.match(/^([A-Z][^\n]+\((\d{4})\)\s+([\w/]+)\s+(\d{4})(?:[^\n]*?Varient:\s*(\d+))?(?:[^\n]*?Paper:\s*(\d+))?)/m);

    if (!headerMatch) continue;

    const hLine     = headerMatch[1];
    const dashIdx   = hLine.indexOf(' - ');
    const examLevel = dashIdx > -1 ? hLine.substring(0, dashIdx).trim() : '';
    const subject   = dashIdx > -1 ? hLine.substring(dashIdx + 3, hLine.indexOf('(')).trim() : '';
    const code      = headerMatch[2];
    const session   = headerMatch[3];
    const year      = headerMatch[4];
    const variant   = headerMatch[5] || '';
    const paper     = headerMatch[6] || '';
    const qpFile    = foundMatch ? foundMatch[1] : '';
    const msFile    = msMatch    ? msMatch[1]    : (qpFile ? qpFile.replace('_qp_', '_ms_') : '');

    const headerIdx  = block.search(/^[A-Z][^\n]+\(\d{4}\)/m);
    const cleanBlock = headerIdx > 0 ? block.substring(headerIdx).trim() : block.trim();

    results.push({ subject, code, exam: examLevel, year, session, variant, paper, qpFile, msFile, rawBlock: cleanBlock });
  }

  return res.status(200).json({ results, debug: { totalBlocks: blocks.length, validBlocks: validBlocks.length, parsed: results.length } });
};

module.exports.config = { api: { bodyParser: { sizeLimit: '1mb' } } };
