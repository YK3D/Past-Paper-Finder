export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).end();

  const { query, subs, zone } = req.body || {};
  if (!query) return res.status(400).json({ error: 'No query' });

  const GROQ_KEY = process.env.GROQ_API_KEY_3 || process.env.GROQ_API_KEY_2 || process.env.GROQ_API_KEY;
  if (!GROQ_KEY) return res.status(500).json({ error: 'No Groq key configured' });

  // Step 1: fetch raw text from caiefinder server-side (no CORS issues)
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
    if (!caieResp.ok) return res.status(200).json({ results: [], error: 'caiefinder returned ' + caieResp.status, fallback: 'https://caiefinder.com/search/?' + params.toString() });
    rawText = await caieResp.text();
  } catch(e) {
    return res.status(200).json({ results: [], error: 'caiefinder fetch failed: ' + e.message, fallback: 'https://caiefinder.com/search/?' + params.toString() });
  }

  // Strip HTML tags
  rawText = rawText
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');

  if (!rawText || rawText.trim().length < 20) {
    return res.status(200).json({ results: [] });
  }

  // Step 2: AI parse
  const prompt = `You are given raw text output from the CaieFinder past paper search engine.
Split it into individual exam results. Each result starts with a header line like:
"IGCSE - Computer Science (0478) May/June 2022 Varient: 2 Paper: 1"

Return ONLY a JSON array. Each object must have exactly these fields:
- "subject": string (e.g. "Computer Science")
- "code": string (e.g. "0478")
- "exam": string (e.g. "IGCSE" or "O Levels" or "A Levels")
- "year": string (e.g. "2022")
- "session": string (e.g. "May/June")
- "variant": string (e.g. "2")
- "paper": string (e.g. "1")
- "qpFile": string — filename WITHOUT .pdf from the line "↓ FOUND ↓ in FILENAME ←" (e.g. "0478_s22_qp_12")
- "msFile": string — filename WITHOUT .pdf from the line "↓ Below is the answer to this question ↓ in FILENAME ←" (e.g. "0478_s22_ms_12")
- "rawBlock": string — the COMPLETE raw text for this result, preserving ALL whitespace, newlines and indentation exactly as given

Return ONLY the JSON array, no markdown, no explanation.

Raw text:
${rawText.substring(0, 12000)}`;

  try {
    const groqResp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + GROQ_KEY
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 4096,
        temperature: 0
      })
    });

    if (!groqResp.ok) return res.status(groqResp.status).json({ error: await groqResp.text() });

    const data = await groqResp.json();
    const content = data.choices?.[0]?.message?.content || '';
    const clean = content.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    let results;
    try {
      results = JSON.parse(clean);
    } catch(e) {
      return res.status(200).json({ results: [], error: 'JSON parse failed: ' + e.message });
    }

    return res.status(200).json({ results });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
