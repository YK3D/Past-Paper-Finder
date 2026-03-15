export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const body = req.body || {};
  const messages = body.messages || [];
  const context = body.context || '';
  const url = body.url || 'unknown';
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not set in Vercel Environment Variables.' });
  }

  const systemPrompt = 'You are an AI assistant helping a student understand a CAIE/AQA past exam paper.\n\n'
    + context + '\n\nPaper URL: ' + url + '\n\n'
    + 'Be concise, clear and educational. Format responses in plain text without markdown.';

  const contents = [];
  contents.push({ role: 'user', parts: [{ text: systemPrompt }] });
  contents.push({ role: 'model', parts: [{ text: 'Understood. I have read the paper and am ready to help.' }] });

  const slice = messages.slice(-10);
  for (let i = 0; i < slice.length; i++) {
    const msg = slice[i];
    contents.push({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    });
  }

  try {
    const geminiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?alt=sse&key=' + apiKey;

    const resp = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: contents,
        generationConfig: { maxOutputTokens: 1024, temperature: 0.7 }
      })
    });

    if (!resp.ok) {
      const err = await resp.text();
      return res.status(resp.status).json({ error: err });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const text = decoder.decode(chunk.value);
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.indexOf('data: ') === 0) {
          try {
            const data = JSON.parse(line.slice(6));
            const part = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
            if (part) {
              res.write('data: ' + JSON.stringify({ delta: { text: part } }) + '\n\n');
            }
          } catch (e) { /* skip */ }
        }
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
