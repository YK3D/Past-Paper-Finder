module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=300');
  if (req.method !== 'GET') return res.status(405).end();

  const q    = (req.query.q    || '').trim();
  const subs = (req.query.subs || '').trim();
  const zone = (req.query.zone || '').trim();
  if (!q) return res.status(400).json({ error: 'No query' });

  // Build URL — always use ? query params, always include subs= and zone= even if empty
  const params = new URLSearchParams();
  params.set('subs', subs);  // empty string if no subject selected
  params.set('zone', zone);  // empty string if no zone selected
  params.set('search', q);

  const caieUrl    = 'https://caiefinder.com/search/?' + params.toString();
  const dataApiUrl = 'https://data.caiefinder.com/search/data/?' + params.toString();

  try {
    const r = await fetch(dataApiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
        'Accept': 'text/html,*/*;q=0.8',
        'Referer': caieUrl,
        'Origin': 'https://caiefinder.com',
      }
    });

    if (!r.ok) return res.status(r.status).json({ error: 'caiefinder returned ' + r.status, fallback: caieUrl });

    const text = await r.text();
    const results = parseResults(text);
    return res.status(200).json({ results, fallback: caieUrl });

  } catch(e) {
    return res.status(500).json({ error: e.message, fallback: caieUrl });
  }
};

// Parse caiefinder's text response format:
//
// Total search results: N
//
// IGCSE - Computer Science (0478) May/June 2020 Varient: 2 Paper: 1
// ↓ FOUND ↓ in 0478_s20_qp_12 ← Open question paper's PDF
// Question No: 9
// — (a) six statements are given about storage devices.
// ↓ Below is the answer to this question ↓ in 0478_s20_ms_12 ← Open original marks scheme's PDF
// [mark scheme text...]

function parseResults(text) {
  const results = [];
  const base = 'https://pastpapers.papacambridge.com/directories/CAIE/CAIE-pastpapers/upload/';

  // Split by the result header pattern
  // Each result starts with a line like: "IGCSE - Subject (CODE) Session Year Varient: N Paper: N"
  const blocks = text.split(/\n(?=[A-Z][^\n]+\([0-9]{4}\)[^\n]+\n↓ FOUND ↓)/);

  for (const block of blocks) {
    if (!block.includes('↓ FOUND ↓')) continue;

    const lines = block.split('\n');

    // Line 0: "IGCSE - Computer Science (0478) May/June 2020 Varient: 2 Paper: 1"
    const headerLine = lines[0] || '';
    const headerMatch = headerLine.match(/^(.+?)\s+\((\d{4})\)\s+(\w+\/\w+|\w+)\s+(\d{4})(?:\s+Varient:\s*(\d+))?(?:\s+Paper:\s*(\d+))?/i);
    if (!headerMatch) continue;

    const examLevel = headerLine.split(' - ')[0].trim();    // e.g. "IGCSE"
    const subject   = headerMatch[1].replace(/^[^-]+-\s*/, '').trim(); // e.g. "Computer Science"
    const code      = headerMatch[2];
    const session   = headerMatch[3];   // e.g. "May/June"
    const year      = headerMatch[4];   // e.g. "2020"
    const variant   = headerMatch[5] || '';
    const paper     = headerMatch[6] || '';

    // Line 1: "↓ FOUND ↓ in 0478_s20_qp_12 ← Open question paper's PDF"
    const foundLine = lines[1] || '';
    const qpFileMatch = foundLine.match(/in\s+(\S+)\s*←/);
    const qpFile = qpFileMatch ? qpFileMatch[1] + '.pdf' : '';

    // Question number line: "Question No: 9"
    const qNumLine = lines.find(l => l.startsWith('Question No:')) || '';
    const qNum = qNumLine.replace('Question No:', '').trim();

    // Question text: line starting with "—"
    const qTextLine = lines.find(l => l.startsWith('—') || l.startsWith('\u2014')) || '';
    const questionText = qNum
      ? 'Q' + qNum + ' ' + qTextLine.replace(/^[\u2014\-]+\s*/, '').trim()
      : qTextLine.replace(/^[\u2014\-]+\s*/, '').trim();

    // MS file line: "↓ Below is the answer to this question ↓ in 0478_s20_ms_12 ← ..."
    const msFoundLine = lines.find(l => l.includes('↓ Below is the answer')) || '';
    const msFileMatch = msFoundLine.match(/in\s+(\S+)\s*←/);
    const msFile = msFileMatch ? msFileMatch[1] + '.pdf' : qpFile.replace('_qp_', '_ms_');

    // Extract mark scheme text — everything after the MS line
    const msLineIdx = lines.findIndex(l => l.includes('↓ Below is the answer'));
    const msText = msLineIdx > -1
      ? lines.slice(msLineIdx + 1).join('\n').replace(/\s+/g, ' ').trim().substring(0, 400)
      : '';

    results.push({
      subject,
      code,
      exam: examLevel,
      year,
      session,
      paper: variant ? 'Variant ' + variant + (paper ? ', Paper ' + paper : '') : (paper ? 'Paper ' + paper : ''),
      question: questionText || 'See paper',
      msSnippet: msText,
      qpUrl: qpFile ? base + qpFile : '',
      msUrl: msFile ? base + msFile : '',
      sourceUrl: 'https://caiefinder.com',
    });

    if (results.length >= 8) break;
  }

  return results;
}
