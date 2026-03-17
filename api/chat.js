export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const body = await req.json().catch(() => ({}));
  const messages = body.messages || [];
  const context  = body.context  || '';
  const url      = body.url      || 'unknown';
  const apiKey   = process.env.GROQ_API_KEY;

  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'GROQ_API_KEY not set in Vercel Environment Variables.' }), { status: 500 });
  }

  const systemPrompt =
    'You are PastPaperAI 🎓, a friendly and helpful assistant helping a student understand CAIE/AQA past exam papers.\n\n' +
    context + '\n\n' +
    'Paper URL: ' + url + '\n\n' +
    'Style guide:\n' +
    '- Use emojis frequently to make responses engaging and easy to scan 📝✅❌💡🔑⚠️📊🧪🔬💬🎯\n' +
    '- Use **bold** for key terms and important points\n' +
    '- Use bullet points (- item) for lists\n' +
    '- Use numbered lists for steps or mark scheme answers\n' +
    '- Use # headings for sections in longer answers\n' +
    '- When answering exam questions, structure like a mark scheme: give the answer, then the marks, then explain why\n' +
    '- Be concise, clear and educational\n' +
    '- Use 🔴 for wrong/common mistakes, 🟢 for correct answers, 🟡 for partial credit\n' +
    '- End longer responses with a 💡 tip or summary';

  const groqMessages = [{ role: 'system', content: systemPrompt }];
  const slice = messages.slice(-10);
  for (let i = 0; i < slice.length; i++) {
    groqMessages.push({ role: slice[i].role, content: slice[i].content });
  }

  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
    body: JSON.stringify({ model: 'llama-3.1-8b-instant', messages: groqMessages, max_tokens: 1024, temperature: 0.7, stream: true })
  });

  if (!resp.ok) {
    const err = await resp.text();
    return new Response(JSON.stringify({ error: err }), { status: resp.status });
  }

  const encoder = new TextEncoder();
  const groqReader = resp.body.getReader();
  const decoder = new TextDecoder();

  const stream = new ReadableStream({
    async start(controller) {
      let buffer = '';
      while (true) {
        const { done, value } = await groqReader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try {
              const data = JSON.parse(line.slice(6));
              const delta = data.choices && data.choices[0] && data.choices[0].delta && data.choices[0].delta.content;
              if (delta) controller.enqueue(encoder.encode('data: ' + JSON.stringify({ delta: { text: delta } }) + '\n\n'));
            } catch {}
          }
        }
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    }
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }
  });
}
