export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  // Check request size before parsing — Vercel edge limit is ~4.5MB
  const contentLength = parseInt(req.headers.get('content-length') || '0');
  if (contentLength > 200000) {
    return new Response(JSON.stringify({ error: 'Context too large — please try a shorter question or reload the page.' }), { status: 413 });
  }

  const body     = await req.json().catch(() => ({}));
  const messages = body.messages || [];
  const context  = body.context  || '';
  const url      = body.url      || 'unknown';
  const apiKey   = process.env.GEMINI_API_KEY;

  if (!apiKey) return new Response(JSON.stringify({ error: 'GEMINI_API_KEY not set' }), { status: 500 });

  const systemPrompt = [
    'You are PastPaperAI — an expert exam tutor for CAIE and AQA students.',
    '',
    '## CRITICAL RULES:',
    '- Honesty first. If you are not certain, say so clearly.',
    '- If the mark scheme is not in the context, say "I don\'t have the mark scheme for this paper" — never invent mark points.',
    '- If a question is unclear from the extracted text, say so — do not guess.',
    '- Only reference content that actually appears in the context below.',
    '',
    '## Context from the paper:',
    context.slice(0, 25000),  // safety cap
    '',
    'Paper URL: ' + url,
    '',
    '## Response style:',
    '- Bold key terms, bullet points for mark points, numbered steps for working',
    '- ✅ correct / full marks   ⚠️ partial   ❌ wrong',
    '- For mark scheme answers: list each mark point with [1] — only if the MS is in context',
    '- For maths: show full working step by step',
    '- For humanities: use PEEL structure',
    '- Use tables for comparisons, equations with units for science',
    '- Be concise — no padding',
    '- use emojis generously but not too excessively',
    '- if a mark scheme contains multiple possible answers, please mention ALL of them EVEN IF the question doesnt require all of the answers.',
    '- when asked to ANSWER a specific question, do not answer other questions as well',
    '- when asked to ANSWER a question, you MUST always refer to the mark scheme',
    '- when asked to EXPLAIN a question, you MUST always refer to the mark scheme',
    '- YOU MUST OBEY EVERYTHING MENTIONED ',
  ].join('\n');

  // Gemini uses a different messages format — convert from OpenAI format
  const geminiContents = messages.slice(-10).map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: geminiContents,
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 1024,
        }
      })
    }
  );

  if (!resp.ok) return new Response(await resp.text(), { status: resp.status });

  const encoder = new TextEncoder();
  const reader  = resp.body.getReader();
  const decoder = new TextDecoder();

  // Convert Gemini SSE stream → our existing SSE format (delta.text)
  const stream = new ReadableStream({
    async start(ctrl) {
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw || raw === '[DONE]') continue;
          try {
            const d = JSON.parse(raw);
            const text = d.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) ctrl.enqueue(encoder.encode('data: ' + JSON.stringify({ delta: { text } }) + '\n\n'));
          } catch {}
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
