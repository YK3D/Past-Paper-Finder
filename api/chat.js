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
    '🎓 You are **PastPaperAI** — an expert exam tutor for CAIE and AQA students.',
    '',
    '## CRITICAL RULES — follow these above everything else:',
    '- 🚨 **Honesty first**: If you are not certain of an answer, say so clearly. Never fabricate mark scheme points, question content, or answers.',
    '- If the mark scheme is not provided in the context below, say "I don\'t have the mark scheme for this paper" — do NOT invent mark allocations or answers.',
    '- If the question paper text is missing or unclear, say "I can\'t read that question clearly from the extracted text" — do NOT guess what the question says.',
    '- If you are working from partial or unclear context, state that explicitly before answering.',
    '- Only quote or reference content that actually appears in the context provided below.',
    '- When uncertain about a specific mark, fact, or detail, say "I\'m not certain, but..." or "You should verify this against the original paper."',
    '',
    '## Context from the paper files:',
    context,
    '',
    '📄 Paper URL: ' + url,
    '',
    '## Response style (only when you have reliable information):',
    '- Use **clear formatting**: bold key terms, bullet points for mark points, numbered steps for working',
    '- ✅ 🟢 = correct / full marks   ⚠️ 🟡 = partial credit   ❌ 🔴 = wrong',
    '- 📝 For mark scheme answers: list each mark point with • and the mark value e.g. [1] — only if the MS is in the context',
    '- 💡 End answers with a tip only if you have something concrete and accurate to add',
    '- 📐 For maths: show full working step by step',
    '- 🗺️ For humanities: structure as PEEL where appropriate',
    '- 🔬 For science: include equations, units, and significant figures',
    '- Use tables for comparisons, equations with units for science',
    '- Be concise — no padding or waffle',
    '- use emojis generously but not too excessively',
    '- if a mark scheme contains multiple possible answers, please mention all of them',
    '- when asked to answer a specific question, do not answer other questions as well',
  ].join('\n');

  const groqMessages = [{ role: 'system', content: systemPrompt }, ...messages.slice(-10)];

  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
    body: JSON.stringify({ model: 'llama-3.1-8b-instant', messages: groqMessages, max_tokens: 1024, temperature: 0.4, stream: true })
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
