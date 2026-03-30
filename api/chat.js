const GROQ_KEYS   = [process.env.GROQ_API_KEY, process.env.GROQ_API_KEY_2, process.env.GROQ_API_KEY_3].filter(Boolean);
const GEMINI_KEYS = [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2, process.env.GEMINI_API_KEY_3].filter(Boolean);

const RATE_LIMIT_MSG = ‘Rate limit reached on all available keys — please switch to a different model using the selector above.’;

function buildSystemPrompt(context, url) {
return [
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
‘- For mark scheme answers: list each mark point with [1] — only if the MS is in context’,
‘- For maths: show full working step by step’,
‘- For humanities: use PEEL structure’,
‘- Use tables for comparisons, equations with units for science’,
‘- Be concise — no padding’,
‘- Use emojis generously but not excessively’,
].join(’\n’);
}

async function tryGroq(key, systemPrompt, messages) {
return fetch(‘https://api.groq.com/openai/v1/chat/completions’, {
method: ‘POST’,
headers: {
‘Content-Type’: ‘application/json’,
‘Authorization’: ’Bearer ’ + key
},
body: JSON.stringify({
model: ‘llama-3.3-70b-versatile’,
messages: [{ role: ‘system’, content: systemPrompt }].concat(messages.slice(-10)),
max_tokens: 2048,
temperature: 0.4,
stream: true
})
});
}

async function tryGemini(key, geminiModel, systemPrompt, messages) {
const contents = messages.slice(-10).map(function(m) {
return {
role: m.role === ‘assistant’ ? ‘model’ : ‘user’,
parts: [{ text: m.content }]
};
});
return fetch(
‘https://generativelanguage.googleapis.com/v1beta/models/’ + geminiModel + ‘:streamGenerateContent?alt=sse&key=’ + key,
{
method: ‘POST’,
headers: { ‘Content-Type’: ‘application/json’ },
body: JSON.stringify({
systemInstruction: { parts: [{ text: systemPrompt }] },
contents: contents,
generationConfig: { temperature: 0.4, maxOutputTokens: 2048 }
})
}
);
}

function pipeGroqStream(resp, res) {
res.setHeader(‘Content-Type’, ‘text/event-stream’);
res.setHeader(‘Cache-Control’, ‘no-cache’);
res.setHeader(‘Connection’, ‘keep-alive’);

const reader = resp.body.getReader();
const decoder = new TextDecoder();
let buf = ‘’;

function pump() {
return reader.read().then(function(chunk) {
if (chunk.done) {
res.write(‘data: [DONE]\n\n’);
res.end();
return;
}
buf += decoder.decode(chunk.value, { stream: true });
const lines = buf.split(’\n’);
buf = lines.pop();
for (let i = 0; i < lines.length; i++) {
const line = lines[i];
if (!line.startsWith(’data: ’) || line === ‘data: [DONE]’) continue;
try {
const d = JSON.parse(line.slice(6));
const text = d.choices && d.choices[0] && d.choices[0].delta && d.choices[0].delta.content;
if (text) res.write(’data: ’ + JSON.stringify({ delta: { text: text } }) + ‘\n\n’);
} catch (e) {}
}
return pump();
});
}

pump().catch(function() { res.end(); });
}

function pipeGeminiStream(resp, res) {
res.setHeader(‘Content-Type’, ‘text/event-stream’);
res.setHeader(‘Cache-Control’, ‘no-cache’);
res.setHeader(‘Connection’, ‘keep-alive’);

const reader = resp.body.getReader();
const decoder = new TextDecoder();
let buf = ‘’;

function pump() {
return reader.read().then(function(chunk) {
if (chunk.done) {
res.write(‘data: [DONE]\n\n’);
res.end();
return;
}
buf += decoder.decode(chunk.value, { stream: true });
const lines = buf.split(’\n’);
buf = lines.pop();
for (let i = 0; i < lines.length; i++) {
const line = lines[i];
if (!line.startsWith(’data: ’)) continue;
const raw = line.slice(6).trim();
if (!raw || raw === ‘[DONE]’) continue;
try {
const d = JSON.parse(raw);
const text = d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts && d.candidates[0].content.parts[0] && d.candidates[0].content.parts[0].text;
if (text) res.write(’data: ’ + JSON.stringify({ delta: { text: text } }) + ‘\n\n’);
} catch (e) {}
}
return pump();
});
}

pump().catch(function() { res.end(); });
}

module.exports = async function handler(req, res) {
res.setHeader(‘Access-Control-Allow-Origin’, ‘*’);
res.setHeader(‘Access-Control-Allow-Methods’, ‘POST, OPTIONS’);
res.setHeader(‘Access-Control-Allow-Headers’, ‘Content-Type’);
if (req.method === ‘OPTIONS’) return res.status(200).end();
if (req.method !== ‘POST’) return res.status(405).end();

const body     = req.body || {};
const messages = body.messages || [];
const context  = body.context  || ‘’;
const url      = body.url      || ‘unknown’;
const model    = body.model    || ‘groq-llama’;

const systemPrompt = buildSystemPrompt(context, url);
const isGroq = model.indexOf(‘groq’) === 0;

try {
if (isGroq) {
for (let i = 0; i < GROQ_KEYS.length; i++) {
const r = await tryGroq(GROQ_KEYS[i], systemPrompt, messages);
if (r.ok) return pipeGroqStream(r, res);
if (r.status !== 429 && r.status !== 413) {
const text = await r.text();
return res.status(r.status).json({ error: text });
}
}
} else {
const geminiModel = model === ‘gemini-2.0-flash’ ? ‘gemini-2.0-flash’ : ‘gemini-2.0-flash-lite’;
for (let i = 0; i < GEMINI_KEYS.length; i++) {
const r = await tryGemini(GEMINI_KEYS[i], geminiModel, systemPrompt, messages);
if (r.ok) return pipeGeminiStream(r, res);
if (r.status !== 429 && r.status !== 413) {
const text = await r.text();
return res.status(r.status).json({ error: text });
}
}
}

```
return res.status(429).json({ error: RATE_LIMIT_MSG });
```

} catch (e) {
return res.status(500).json({ error: e.message });
}
};