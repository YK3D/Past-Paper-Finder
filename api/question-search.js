// Proxy to caiefinder.com search — parses results and returns structured JSON
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).end();

  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'No query' });

  try {
    const url = 'https://caiefinder.com/search/?search=' + encodeURIComponent(q);
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-GB,en;q=0.9',
        'Referer': 'https://caiefinder.com/',
      }
    });

    if (!r.ok) return res.status(r.status).json({ error: 'caiefinder returned ' + r.status });

    const html = await r.text();

    // Parse results from HTML
    const results = parseResults(html, q);
    return res.status(200).json({ results });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};

function parseResults(html, query) {
  const results = [];

  // caiefinder returns result cards with data attributes or structured divs
  // Pattern: look for paper filename patterns like 9709_s23_qp_12
  const paperPattern = /(\d{4})_([smw])(\d{2})_([a-z]+)(?:_(\d{1,2}))?/gi;

  // Also parse JSON if embedded (some SPA sites embed __INITIAL_DATA__ or similar)
  const jsonMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*({.+?});/s)
    || html.match(/window\.__DATA__\s*=\s*({.+?});/s)
    || html.match(/"results"\s*:\s*(\[.+?\])/s);

  if (jsonMatch) {
    try {
      const data = JSON.parse(jsonMatch[1]);
      const items = Array.isArray(data) ? data : (data.results || data.hits || []);
      for (const item of items.slice(0, 10)) {
        results.push(normaliseItem(item));
      }
      if (results.length) return results;
    } catch(e) {}
  }

  // Fallback: extract paper filenames found in the HTML and build result cards
  const seen = new Set();
  let match;
  while ((match = paperPattern.exec(html)) !== null) {
    const filename = match[0].toLowerCase();
    if (seen.has(filename)) continue;
    seen.add(filename);

    const code    = match[1];
    const session = match[2] === 's' ? 'May/June' : match[2] === 'w' ? 'Oct/Nov' : 'Feb/Mar';
    const year    = '20' + match[3];
    const type    = match[4];
    const variant = match[5] || '';

    if (type !== 'qp' && type !== 'ms') continue;

    const base    = 'https://pastpapers.papacambridge.com/directories/CAIE/CAIE-pastpapers/upload/';
    const qpFile  = code + '_' + match[2] + match[3] + '_qp' + (variant ? '_' + variant.padStart(2,'0') : '') + '.pdf';
    const msFile  = qpFile.replace('_qp', '_ms');

    // Extract surrounding text as the question snippet
    const idx = html.indexOf(match[0]);
    const surrounding = html.substring(Math.max(0, idx - 200), idx + 400)
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    results.push({
      subject:    codeToSubject(code),
      code:       code,
      exam:       codeToLevel(code),
      year:       year,
      session:    session,
      paper:      variant || '',
      question:   surrounding.length > 20 ? surrounding.substring(0, 280) + '…' : 'See paper for question text',
      qpUrl:      base + qpFile,
      msUrl:      base + msFile,
      sourceUrl:  'https://caiefinder.com/search/?search=' + encodeURIComponent(query)
    });

    if (results.length >= 8) break;
  }

  return results;
}

function normaliseItem(item) {
  const code = item.code || item.subject_code || item.syllabus || '';
  const base = 'https://pastpapers.papacambridge.com/directories/CAIE/CAIE-pastpapers/upload/';
  return {
    subject:  item.subject || item.subject_name || codeToSubject(code),
    code:     code,
    exam:     item.level || item.exam_level || codeToLevel(code),
    year:     item.year || '',
    session:  item.session || '',
    paper:    item.paper || item.variant || '',
    question: item.question || item.text || item.content || '',
    qpUrl:    item.qp_url || item.question_paper_url || (code ? base + code + '.pdf' : ''),
    msUrl:    item.ms_url || item.mark_scheme_url || '',
    sourceUrl: item.url || item.source_url || ''
  };
}

const SUBJECT_MAP = {
  '0580':'Mathematics','0625':'Physics','0620':'Chemistry','0610':'Biology',
  '0450':'Business Studies','0455':'Economics','0500':'English Language',
  '0478':'Computer Science','0470':'History','0460':'Geography',
  '9709':'Mathematics A Level','9702':'Physics A Level','9701':'Chemistry A Level',
  '9700':'Biology A Level','9708':'Economics A Level','9609':'Business A Level',
  '9618':'Computer Science A Level','0417':'Computer Science',
};

function codeToSubject(code) {
  return SUBJECT_MAP[code] || ('Subject ' + code);
}

function codeToLevel(code) {
  const n = parseInt(code);
  if (n >= 9000) return 'A Level';
  if (n >= 7000) return 'A Level';
  return 'IGCSE / O Level';
}
