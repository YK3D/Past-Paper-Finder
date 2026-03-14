export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { messages, context, url } = req.body || {};
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY not set. Add it in Vercel Dashboard → Settings → Environment Variables.'
    });
  }

  const systemPrompt = `You are an AI assistant helping a student understand a CAIE/AQA past exam paper.
${context}
Paper URL: ${url || 'unknown'}
Be concise, clear, and educational. If asked about specific questions, refer to the paper content above.
Format responses in plain text without markdown.`;

  // Build Gemini contents array from message history
  const contents = [];

  // Add system context as first user message
  contents.push({
    role: 'user',
    parts: [{ text: systemPrompt }]
  });
  contents.push({
    role: 'model',
    parts: [{ text: 'Understood. I have read the paper content and am ready to help.' }]
  });

  // Add conversation history
  for (const msg of (messages || []).slice(-10)) {
    contents.push({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    });
  }

  try {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?alt=sse&key=${apiKey}`;

    const resp = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        generationConfig: {
          maxOutputTokens: 1024,
          temperature: 0.7
        }
      })
    });

    if (!resp.ok) {
      const err = await resp.text();
      return res.status(resp.status).json({ error: err });
    }

    // Stream back to client
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) {
              res.write(`data: ${JSON.stringify({ delta: { text } })}\n\n`);
            }
          } catch {}
        }
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
