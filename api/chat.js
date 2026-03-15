export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const body = req.body || {};
  const messages = body.messages || [];
  const context = body.context || '';
  const url = body.url || 'unknown';
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'GROQ_API_KEY not set in Vercel Environment Variables.' });
  }

  const systemPrompt = 'You are an AI assistant helping a student understand a CAIE/AQA past exam paper.\n\n'
    + context + '\n\nPaper URL: ' + url + '\n\n'
    + 'Be concise, clear and educational. Format responses in plain text without markdown.';

  // Build messages array for Groq (OpenAI-compatible format)
  const groqMessages = [{ role: 'system', content: systemPrompt }];
  const slice = messages.slice(-10);
  for (let i = 0; i < slice.length; i++) {
    groqMessages.push({ role: slice[i].role, content: slice[i].content });
  }

  try {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: groqMessages,
        max_tokens: 1024,
        temperature: 0.7,
        stream: true
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
        if (line.indexOf('data: ') === 0 && line !== 'data: [DONE]') {
          try {
            const data = JSON.parse(line.slice(6));
            const delta = data.choices && data.choices[0] && data.choices[0].delta && data.choices[0].delta.content;
            if (delta) {
              res.write('data: ' + JSON.stringify({ delta: { text: delta } }) + '\n\n');
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
