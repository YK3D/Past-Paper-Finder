export const config = { runtime: ‘edge’ };

// Primary keys
const GEMINI_KEY  = process.env.GEMINI_API_KEY;
const GROQ_KEY    = process.env.GROQ_API_KEY;

// Backup keys — add these in Vercel env vars
const GEMINI_KEY2 = process.env.GEMINI_API_KEY_2;
const GEMINI_KEY3 = process.env.GEMINI_API_KEY_3;
const GROQ_KEY2   = process.env.GROQ_API_KEY_2;
const GROQ_KEY3   = process.env.GROQ_API_KEY_3;

const RATE_LIMIT_MSG = ‘Rate limit reached on all available keys — please switch to a different model using the selector above.’;

const SYSTEM_PROMPT = (context, url) => [
‘You are PastPaperAI — an expert exam tutor for CAIE and AQA students.’,
‘’,
‘## CRITICAL RULES:’,
‘- Honesty first. If you are not certain, say so clearly.’,
‘- If the mark scheme is not in the context, say “I don't have the mark scheme for this paper” — never invent mark points.’,
‘- If a question is unclear from the extracted text, say so — do not guess.’,
‘- Only reference content that actually appears in the context below.’,
‘- If a mark scheme contains multiple possible answers, mention ALL of them even if the question does not require all answers.’,
‘- When asked to ANSWER a specific question, do not answer other questions as well.’,
‘- When asked to ANSWER a question, you MUST always refer to the mark scheme.’,
‘- When asked to EXPLAIN a question, you MUST always refer to the mark scheme.’,
‘- YOU MUST OBEY EVERYTHING MENTIONED.’,
‘’,
‘## Context from the paper:’,
context,
‘’,
‘Paper URL: ’ + url,
‘’,
‘## Response style:’,
‘- Bold key terms, bullet points for mark points, numbered steps for working’,
‘- ✅ correct / full marks   ⚠️ partial   ❌ wrong’,
‘- For mark scheme answers: list each mark point with [1] — only if the MS is in context’,
‘- For maths: show full working step by step’,
‘- For humanities: use PEEL structure’,
‘- Use tables for comparisons, equations with units for science’,
‘- Be concise — no padding’,
‘- Use emojis generously but not excessively’,
].join(’\n’);

async function tryGemini(key, geminiModel, systemPrompt, messages) {
if (!key) return null;
const contents = messages.slice(-10).map(m => ({
role: m.role === ‘assistant’ ? ‘model’ : ‘user’,
parts: [{ text: m.content }]
}));
const r = await fetch(
`https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:streamGenerateContent?alt=sse&key=${key}`,
{
method: ‘POST’,
headers: { ‘Content-Type’: ‘application/json’ },
body: JSON.stringify({
systemInstruction: { parts: [{ text: systemPrompt }] },
contents,
generationConfig: { temperature: 0.4, maxOutputTokens: 1024 }
})
}
);
return r;
}

async function tryGroq(key, groqModel, systemPrompt, messages) {
if (!key) return null;
const r = await fetch(‘https://api.groq.com/openai/v1/chat/completions’, {
method: ‘POST’,
headers: { ‘Content-Type’: ‘application/json’, ‘Authorization’: `Bearer ${key}` },
body: JSON.stringify({
model: groqModel,
messages: [{ role: ‘system’, content: systemPrompt }, …messages.slice(-10)],
max_tokens: 1024,
temperature: 0.4,
stream: true
})
});
return r;
}

function makeGeminiStream(resp, encoder) {
const reader = resp.body.getReader();
const decoder = new TextDecoder();
return new ReadableStream({
async start(ctrl) {
let buf = ‘’;
while (true) {
const { done, value } = await reader.read();
if (done) break;
buf += decoder.decode(value, { stream: true });
const lines = buf.split(’\n’); buf = lines.pop();
for (const line of lines) {
if (!line.startsWith(’data: ’)) continue;
const raw = line.slice(6).trim();
if (!raw || raw === ‘[DONE]’) continue;
try {
const d = JSON.parse(raw);
const text = d.candidates?.[0]?.content?.parts?.[0]?.text;
if (text) ctrl.enqueue(encoder.encode(’data: ’ + JSON.stringify({ delta: { text } }) + ‘\n\n’));
} catch {}
}
}
ctrl.enqueue(encoder.encode(‘data: [DONE]\n\n’));
ctrl.close();
}
});
}

function makeGroqStream(resp, encoder) {
const reader = resp.body.getReader();
const decoder = new TextDecoder();
return new ReadableStream({
async start(ctrl) {
let buf = ‘’;
while (true) {
const { done, value } = await reader.read();
if (done) break;
buf += decoder.decode(value, { stream: true });
const lines = buf.split(’\n’); buf = lines.pop();
for (const line of lines) {
if (!line.startsWith(’data: ’) || line === ‘data: [DONE]’) continue;
try {
const d = JSON.parse(line.slice(6));
const text = d.choices?.[0]?.delta?.content;
if (text) ctrl.enqueue(encoder.encode(’data: ’ + JSON.stringify({ delta: { text } }) + ‘\n\n’));
} catch {}
}
}
ctrl.enqueue(encoder.encode(‘data: [DONE]\n\n’));
ctrl.close();
}
});
}

function isRateLimit(resp) {
return resp && (resp.status === 429 || resp.status === 413);
}

export default async function handler(req) {
if (req.method !== ‘POST’) return new Response(‘Method not allowed’, { status: 405 });

const body     = await req.json().catch(() => ({}));
const messages = body.messages || [];
const context  = body.context  || ‘’;
const url      = body.url      || ‘unknown’;
const model    = body.model    || ‘groq-llama’;

const systemPrompt = SYSTEM_PROMPT(context, url);
const encoder = new TextEncoder();
const isGroq = model.startsWith(‘groq-’);

const streamOk = (resp, type) => {
const stream = type === ‘groq’ ? makeGroqStream(resp, encoder) : makeGeminiStream(resp, encoder);
return new Response(stream, {
headers: { ‘Content-Type’: ‘text/event-stream’, ‘Cache-Control’: ‘no-cache’ }
});
};

try {
if (isGroq) {
// Try Groq key 1, 2, 3 in order
const groqModel = ‘llama-3.3-70b-versatile’;
for (const key of [GROQ_KEY, GROQ_KEY2, GROQ_KEY3]) {
const r = await tryGroq(key, groqModel, systemPrompt, messages);
if (!r) continue;
if (r.ok) return streamOk(r, ‘groq’);
if (!isRateLimit(r)) return new Response(await r.text(), { status: r.status });
// rate limited — try next key
}
} else {
// Gemini — try key 1, 2, 3 in order
const geminiModel = model === ‘gemini-2.0-flash’ ? ‘gemini-2.0-flash’ : ‘gemini-2.0-flash-lite’;
for (const key of [GEMINI_KEY, GEMINI_KEY2, GEMINI_KEY3]) {
const r = await tryGemini(key, geminiModel, systemPrompt, messages);
if (!r) continue;
if (r.ok) return streamOk(r, ‘gemini’);
if (!isRateLimit(r)) return new Response(await r.text(), { status: r.status });
// rate limited — try next key
}
}

```
// All keys exhausted — tell user to switch models
return new Response(
  JSON.stringify({ error: RATE_LIMIT_MSG }),
  { status: 429, headers: { 'Content-Type': 'application/json' } }
);
```

} catch (e) {
return new Response(JSON.stringify({ error: e.message }), { status: 500 });
}
}