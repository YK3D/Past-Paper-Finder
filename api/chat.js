export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const body = await req.json().catch(() => ({}));
  const messages = body.messages || [];
  const context  = body.context  || '';
  const url      = body.url      || 'unknown';
  const apiKey   = process.env.GROQ_API_KEY;

  if (!apiKey) return new Response(JSON.stringify({ error: 'GROQ_API_KEY not set' }), { status: 500 });

  const systemPrompt = [
    '🎓 You are **PastPaperAI** — an expert, enthusiastic exam tutor for CAIE and AQA students.',
    '',
    context,
    '',
    '📄 Paper: ' + url,
    '',
    '## Your response style:',
    '- 🌈 Use **rich formatting**: bold, italics, headings, bullet points, numbered lists',
    '- 😊 Use emojis **generously** throughout — they help students engage',
    '- 🔑 Lead every answer with the key point first',
    '- ✅ 🟢 = correct / full marks   ⚠️ 🟡 = partial credit   ❌ 🔴 = wrong / common mistake',
    '- 📝 For mark scheme questions: list each mark point with • and the mark value e.g. [1]',
    '- 💡 End every answer with a **Pro Tip** or **Exam Tip** section',
    '- 🎯 Be **concise but complete** — no waffle',
    '- 📊 Use tables where comparisons are helpful',
    '- 🔬 For science: include equations, units, and significant figures',
    '- 📐 For maths: show full working step by step',
    '- 🗺️ For humanities: structure answers as PEEL or similar',
    '- When the user asks for mark scheme answers, retrieve them from the MS file if available, or construct a model answer using mark scheme structure',
    '- Always use colours metaphorically: 🔵 blue for facts, 🟠 orange for examples, 🟣 purple for key vocab',
  ].join('\n');

  const groqMessages = [{ role: 'system', content: systemPrompt }, ...messages.slice(-10)];

  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
    body: JSON.stringify({ model: 'llama-3.1-8b-instant', messages: groqMessages, max_tokens: 1024, temperature: 0.75, stream: true })
  });

  if (!resp.ok) return new Response(await resp.text(), { status: resp.status });

  const encoder = new TextEncoder();
  const reader  = resp.body.getReader();
  const decoder = new TextDecoder();

  const stream = new ReadableStream({
    async start(ctrl) {
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try {
              const d = JSON.parse(line.slice(6));
              const delta = d.choices?.[0]?.delta?.content;
              if (delta) ctrl.enqueue(encoder.encode('data: ' + JSON.stringify({ delta: { text: delta } }) + '\n\n'));
            } catch {}
          }
        }
      }
      ctrl.enqueue(encoder.encode('data: [DONE]\n\n'));
      ctrl.close();
    }
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }
  });
}
