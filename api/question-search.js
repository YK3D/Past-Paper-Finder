module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).end();

  const q    = (req.query.q    || '').trim();
  const subs = (req.query.subs || '').trim();
  const zone = (req.query.zone || '').trim();

  if (!q) return res.status(400).json({ error: 'No query' });

  try {
    // POST to caiefinder search exactly as the form does
    const formBody = new URLSearchParams();
    formBody.append('search', q);
    if (subs) formBody.append('subs', subs);
    if (zone) formBody.append('zone', zone);

    const r = await fetch('https://caiefinder.com/search/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
        'Referer': 'https://caiefinder.com/',
        'Origin': 'https://caiefinder.com',
      },
      body: formBody.toString(),
      redirect: 'follow',
    });

    if (!r.ok) return res.status(r.status).json({ error: 'caiefinder returned ' + r.status });

    const html = await r.text();
    const results = parseResults(html);
    return res.status(200).json({ results, raw: html.length });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};

function parseResults(html) {
  const results = [];

  // caiefinder is a React SPA — results are rendered into the DOM by JS
  // However the search response page may contain JSON data embedded in a script tag
  // Look for patterns like window.__data or JSON arrays
  const jsonScripts = html.match(/<script[^>]*>([\s\S]*?)<\/script>/g) || [];
  for (const script of jsonScripts) {
    const inner = script.replace(/<\/?script[^>]*>/g, '');
    // Look for arrays of result objects
    const match = inner.match(/"results"\s*:\s*(\[[\s\S]+?\])/);
    if (match) {
      try {
        const items = JSON.parse(match[1]);
        for (const item of items.slice(0, 10)) results.push(buildResult(item));
        if (results.length) return results;
      } catch(e) {}
    }
    // Look for hits array (common in search engines)
    const hitsMatch = inner.match(/"hits"\s*:\s*(\[[\s\S]+?\])/);
    if (hitsMatch) {
      try {
        const items = JSON.parse(hitsMatch[1]);
        for (const item of items.slice(0, 10)) results.push(buildResult(item));
        if (results.length) return results;
      } catch(e) {}
    }
  }

  // Fallback: scan HTML for caiefinder PDF URL patterns
  // caiefinder stores papers at: /pastpapers/pdf/[level]/[Subject (code)]/[year]/[filename].pdf
  const pdfPattern = /\/pastpapers\/(?:pdf|view)\/([^"'\s]+\.pdf)/gi;
  const seen = new Set();
  let match;

  while ((match = pdfPattern.exec(html)) !== null) {
    const path = match[1]; // e.g. IGCSE/Mathematics (0580)/2023/0580_s23_qp_12.pdf
    const key  = path.split('/').pop();
    if (seen.has(key)) continue;
    seen.add(key);

    const parts    = path.split('/');
    const filename = parts[parts.length - 1];
    const level    = parts[0] || '';
    const subject  = parts[1] || '';
    const year     = parts[2] || '';

    // Only show QP files (not MS) in the main listing
    if (!filename.includes('_qp')) continue;

    const fileMatch = filename.match(/^(\d{4})_([smw])(\d{2})_([a-z]+)(?:_(\d{1,2,2}))?\.pdf$/i);
    if (!fileMatch) continue;

    const code     = fileMatch[1];
    const sess     = fileMatch[2];
    const yr       = fileMatch[3];
    const type     = fileMatch[4];
    const variant  = fileMatch[5] || '';
    const session  = sess === 's' ? 'May/June' : sess === 'w' ? 'Oct/Nov' : 'Feb/Mar';
    const msFile   = filename.replace('_qp', '_ms');
    const base     = 'https://pastpapers.papacambridge.com/directories/CAIE/CAIE-pastpapers/upload/';

    // Extract surrounding text from the HTML near this PDF link
    const linkIdx  = html.indexOf(match[0]);
    const snippet  = html.substring(Math.max(0, linkIdx - 400), linkIdx + 400)
      .replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();

    results.push({
      subject:   subject.replace(/\s*\(\d+\)$/, '').trim() || codeToSubject(code),
      code:      code,
      exam:      level,
      year:      '20' + yr,
      session:   session,
      paper:     variant ? 'Variant ' + parseInt(variant) : '',
      question:  snippet.length > 30 ? snippet.substring(0, 300) + '…' : 'See paper',
      qpUrl:     base + filename,
      msUrl:     base + msFile,
      sourceUrl: 'https://caiefinder.com' + match[0],
    });

    if (results.length >= 8) break;
  }

  return results;
}

function buildResult(item) {
  const code = item.code || item.subject_code || item.syllabus || '';
  const base = 'https://pastpapers.papacambridge.com/directories/CAIE/CAIE-pastpapers/upload/';
  return {
    subject:  item.subject || item.subject_name || codeToSubject(code),
    code:     code,
    exam:     item.level || item.zone || '',
    year:     item.year || '',
    session:  item.session || '',
    paper:    item.paper || item.variant || '',
    question: item.question || item.text || item.context || item.content || '',
    qpUrl:    item.qp_url || item.question_paper_url || '',
    msUrl:    item.ms_url || item.mark_scheme_url || '',
    sourceUrl: item.url || '',
  };
}

const SUBJECT_MAP = {
  '0580':'Mathematics','0625':'Physics','0620':'Chemistry','0610':'Biology',
  '0450':'Business Studies','0455':'Economics','0500':'English Language',
  '0478':'Computer Science','0470':'History','0460':'Geography',
  '9709':'Mathematics','9702':'Physics','9701':'Chemistry','9700':'Biology',
  '9708':'Economics','9609':'Business Studies','9618':'Computer Science',
  '0417':'Computer Science','0452':'Accounting','9706':'Accounting',
};
function codeToSubject(code) { return SUBJECT_MAP[code] || code; }
