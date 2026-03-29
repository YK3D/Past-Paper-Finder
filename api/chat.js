export const config = { runtime: 'edge' };

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GROQ_KEY   = process.env.GROQ_API_KEY;

const SYSTEM_PROMPT = (context, url) => [
  'You are PastPaperAI — an expert exam tutor for CAIE and AQA students.',
  '',
  '## CRITICAL RULES:',
  '- Honesty first. If you are not certain, say so clearly.',
  '- If the mark scheme is not in the context, say "I don\'t have the mark scheme for this paper" — never invent mark points.',
  '- If a question is unclear from the extracted text, say so — do not guess.',
  '- Only reference content that actually appears in the context below.',
  '- If a mark scheme contains multiple possible answers, mention ALL of them even if the question does not require all answers.',
  '- When asked to ANSWER a specific question, do not answer other questions as well.',
  '- When asked to ANSWER a question, you MUST always refer to the mark scheme.',
  '- When asked to EXPLAIN a question, you MUST always refer to the mark scheme.',
  '- YOU MUST OBEY EVERYTHING MENTIONED.',
  '',
  '## Context from the paper:',
  context.slice(0, 25000),
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
  '- Use emojis generously but not excessively',
].join('\n');

// Gemini streaming call
async function callGemini(model, systemPrompt, messages) {
  const geminiModel = model === 'gemini-1.5-flash' ? 'gemini-1.5-flash'
    : model === 'gemini-2.0-flash' ? 'gemini-2.0-flash'
    : 'gemini-2.0-flash-lite';

  const contents = messages.slice(-10).map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));

  return fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:streamGenerateContent?alt=sse&key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { temperature: 0.4, maxOutputTokens: 1024 }
      })
    }
  );
}

// Groq streaming call
async function callGroq(model, systemPrompt, messages) {
  const groqModel = model === 'groq-deepseek'
    ? 'deepseek-r1-distill-llama-70b'
    : 'llama-3.3-70b-versatile';

  return fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
    body: JSON.stringify({
      model: groqModel,
      messages: [{ role: 'system', content: systemPrompt }, ...messages.slice(-10)],
      max_tokens: 1024,
      temperature: 0.4,
      stream: true
    })
  });
}

// Convert Gemini SSE → our delta.text format
function makeGeminiStream(resp, encoder) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  return new ReadableStream({
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
}

// Convert Groq/OpenAI SSE → our delta.text format
function makeGroqStream(resp, encoder) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  return new ReadableStream({
    async start(ctrl) {
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
          try {
            const d = JSON.parse(line.slice(6));
            const text = d.choices?.[0]?.delta?.content;
            if (text) ctrl.enqueue(encoder.encode('data: ' + JSON.stringify({ delta: { text } }) + '\n\n'));
          } catch {}
        }
      }
      ctrl.enqueue(encoder.encode('data: [DONE]\n\n'));
      ctrl.close();
    }
  });
}

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const body     = await req.json().catch(() => ({}));
  const messages = body.messages || [];
  const context  = body.context  || '';
  const url      = body.url      || 'unknown';
  const model    = body.model    || 'gemini-2.0-flash-lite';

  const systemPrompt = SYSTEM_PROMPT(context, url);
  const encoder = new TextEncoder();
  const isGroq = model.startsWith('groq-');

  // Try primary model
  try {
    const apiKey = isGroq ? GROQ_KEY : GEMINI_KEY;
    if (!apiKey) throw new Error('API key not set');

    const resp = isGroq
      ? await callGroq(model, systemPrompt, messages)
      : await callGemini(model, systemPrompt, messages);

    if (resp.ok) {
      const stream = isGroq
        ? makeGroqStream(resp, encoder)
        : makeGeminiStream(resp, encoder);
      return new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }
      });
    }

    // Rate limited — try fallback
    if (resp.status === 429 || resp.status === 413) {
      // Fallback: if was Gemini try Groq, if was Groq try Gemini
      const fallbackIsGroq = !isGroq && !!GROQ_KEY;
      const fallbackResp = fallbackIsGroq
        ? await callGroq('groq-llama', systemPrompt, messages)
        : await callGemini('gemini-1.5-flash', systemPrompt, messages);

      if (fallbackResp.ok) {
        const stream = fallbackIsGroq
          ? makeGroqStream(fallbackResp, encoder)
          : makeGeminiStream(fallbackResp, encoder);
        return new Response(stream, {
          headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }
        });
      }
    }

    return new Response(await resp.text(), { status: resp.status });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
}
