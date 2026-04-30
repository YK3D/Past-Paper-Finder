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
    return res.status(200).json({ results: [], error: 'Empty response from caiefinder', debug: rawText.substring(0, 200) });
  }

  const base = 'https://pastpapers.papacambridge.com/directories/CAIE/CAIE-pastpapers/upload/';
  const results = [];

  // Split on ↓ FOUND ↓ — each occurrence marks an exam result
  // Everything between two ↓ FOUND ↓ markers (plus the header line before each) is one block
  const foundMarker = '\u2193 FOUND \u2193';
  const parts = text.split(foundMarker);

  // parts[0] = preamble (total count etc)
  // parts[1..n] = " in QPFILE ← ...\nQuestion No...\n...↓ Below...\n...mark scheme..."
  // The header line for each result is the LAST non-empty line of the previous part

  for (let i = 1; i < parts.length && results.length < 8; i++) {
    const prevPart = parts[i - 1];
    const thisPart = parts[i];

    // Header line = last non-empty line of prevPart (untrimmed to preserve spacing)
    const prevLines = prevPart.split('\n');
    // Find last line that contains a 4-digit subject code in parens
    let hLine = '';
    let hLineOriginal = '';
    for (let j = prevLines.length - 1; j >= 0; j--) {
      if (/\(\d{4}\)/.test(prevLines[j])) {
        hLine = prevLines[j].trim();
        hLineOriginal = prevLines[j];
        break;
      }
    }
    if (!hLine) continue;

    // QP file = first word after "in " at start of thisPart
    const qpMatch = thisPart.match(/^\s*in\s+(\w+)\s*\u2190/);
    const qpFile  = qpMatch ? qpMatch[1] : '';

    // MS file = from "↓ Below is the answer ↓ in FILE ←"
    const msMatch = thisPart.match(/\u2193 Below is the answer[^\n]* in\s+(\w+)\s*\u2190/);
    const msFile  = msMatch ? msMatch[1] : (qpFile ? qpFile.replace('_qp_', '_ms_') : '');

    // Parse header line
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

    // Raw block = original header line (preserving spacing) + ↓ FOUND ↓ + this part
    // Find where next header starts in thisPart to trim it
    const nextHeaderIdx = thisPart.search(/\n[A-Z][^\n]+\(\d{4}\)[^\n]+\n/);
    const blockBody = nextHeaderIdx > -1 ? thisPart.substring(0, nextHeaderIdx) : thisPart;
    // The line after ↓ FOUND ↓ collapses several fields onto one line — split them out
    // Pattern: "in FILE ← Open question paper's PDFQuestion No: N —QUESTION TEXT ↓ Below..."
    const rawBlockRaw = (hLineOriginal + '\n' + foundMarker + blockBody).trim();
    const rawBlock = rawBlockRaw
      .replace(/← Open question paper's PDF(?!\n)/g, "← Open question paper's PDF\n")
      .replace(/ ↓ Below is the answer/g, '\n↓ Below is the answer')
      .replace(/← Open original marks scheme's PDF(?!\n)/g, "← Open original marks scheme's PDF\n");

    results.push({ subject, code, exam: examLevel, year, session, variant, paper, qpFile, msFile, rawBlock });
  }

  if (!results.length) {
    return res.status(200).json({ results: [], error: 'No results parsed', debug: text.substring(0, 400) });
  }

  return res.status(200).json({ results });
};

module.exports.config = { api: { bodyParser: { sizeLimit: '1mb' } } };
