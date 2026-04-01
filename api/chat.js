const GROQ_KEYS   = [process.env.GROQ_API_KEY, process.env.GROQ_API_KEY_2, process.env.GROQ_API_KEY_3].filter(Boolean);
const VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct'; // vision-capable, free on Groq
const GEMINI_KEYS = [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2, process.env.GEMINI_API_KEY_3, process.env.GEMINI_API_KEY_4, process.env.GEMINI_API_KEY_5, process.env.GEMINI_API_KEY_6].filter(Boolean);

const RATE_LIMIT_MSG = 'Gemini free tier quota exhausted for today. Please switch to Llama (Groq) using the model selector above, or try again tomorrow.';

function buildSystemPrompt(context, url) {
  return [
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
    context,
    '',
    'Paper URL: ' + url,
    '',
    '## Response style:',
    '- Bold key terms, bullet points for mark points, numbered steps for working',
    '- For mark scheme answers: list each mark point with [1] — only if the MS is in context',
    '- For maths: show full working step by step',
    '- For humanities: use PEEL structure',
    '- Use tables for comparisons, equations with units for science',
    '- Be concise — no padding',
    '- Use emojis generously but not excessively',
  ].join('\n');
}

async function tryGroq(key, systemPrompt, messages) {
  return fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'system', content: systemPrompt }].concat(messages.slice(-10)),
      max_tokens: 2048,
      temperature: 0.4,
      stream: true
    })
  });
}

async function tryGemini(key, geminiModel, systemPrompt, messages) {
  const contents = messages.slice(-10).map(function(m) {
    return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] };
  });
  return fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + geminiModel + ':streamGenerateContent?alt=sse&key=' + key,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: contents,
        generationConfig: { temperature: 0.4, maxOutputTokens: 2048 }
      })
    }
  );
}

async function tryGroqVision(key, systemPrompt, messages, image) {
  // Groq vision: image-only, no system message, no extra text (causes 400)
  const content = [
    {
      type: 'image_url',
      image_url: { url: 'data:' + (image.mimeType || 'image/jpeg') + ';base64,' + image.base64 }
    },
    { type: "text", text: "You are an expert CAIE exam tutor. Correct the student answer shown in this image. Identify mistakes, explain what is wrong, and provide the correct answer with full working." }
  ];

  const groqMessages = [{ role: 'user', content: content }];

  const reqBody = {
    model: VISION_MODEL,
    messages: groqMessages,
    max_completion_tokens: 1024,
    temperature: 0.4,
    stream: false
  };
  console.log('[Vision] request body (truncated):', JSON.stringify(reqBody).substring(0, 500));
  return fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + key
    },
    body: JSON.stringify(reqBody)
  });
}

function pipeGroqStream(resp, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  function pump() {
    return reader.read().then(function(chunk) {
      if (chunk.done) { res.write('data: [DONE]\n\n'); res.end(); return; }
      buf += decoder.decode(chunk.value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
        try {
          const d = JSON.parse(line.slice(6));
          const text = d.choices && d.choices[0] && d.choices[0].delta && d.choices[0].delta.content;
          if (text) res.write('data: ' + JSON.stringify({ delta: { text: text } }) + '\n\n');
        } catch(e) {}
      }
      return pump();
    });
  }
  pump().catch(function() { try { res.end(); } catch(e) {} });
}

function pipeGeminiStream(resp, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  function pump() {
    return reader.read().then(function(chunk) {
      if (chunk.done) { res.write('data: [DONE]\n\n'); res.end(); return; }
      buf += decoder.decode(chunk.value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw === '[DONE]') continue;
        try {
          const d = JSON.parse(raw);
          const parts = d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts;
          const text = parts && parts[0] && parts[0].text;
          if (text) res.write('data: ' + JSON.stringify({ delta: { text: text } }) + '\n\n');
        } catch(e) {}
      }
      return pump();
    });
  }
  pump().catch(function() { try { res.end(); } catch(e) {} });
}

module.exports.config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb'
    }
  }
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  // Parse body — Vercel may provide it already parsed or as a stream
  let body = {};
  try {
    if (req.body && typeof req.body === 'object') {
      body = req.body;
    } else if (req.body && typeof req.body === 'string') {
      body = JSON.parse(req.body);
    } else {
      // Read raw stream
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString());
    }
  } catch(e) {
    return res.status(400).json({ error: 'Invalid request body: ' + e.message });
  }

  const messages = body.messages || [];
  const context  = body.context  || '';
  const url      = body.url      || 'unknown';
  const model    = body.model    || 'groq-llama';

  const systemPrompt = buildSystemPrompt(context, url);
  const isGroq   = model.indexOf('groq') === 0;
  const isVision  = model === 'groq-llama-vision';
  const image     = body.image || null;

  try {
    if (isVision) {
      if (!GROQ_KEYS.length) return res.status(500).json({ error: 'GROQ_API_KEY not configured.' });
      if (!image || !image.base64) return res.status(400).json({ error: 'No image provided.' });
      for (let i = 0; i < GROQ_KEYS.length; i++) {
        const r = await tryGroqVision(GROQ_KEYS[i], systemPrompt, messages, image);
        if (r.ok) {
          // Vision returns non-streaming JSON — convert to SSE format
          const data = await r.json();
          const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '';
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.write('data: ' + JSON.stringify({ delta: { text } }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        const errText = await r.text();
        console.error('[Vision key ' + (i+1) + '] status=' + r.status + ' body=' + errText.slice(0, 300));
        if (r.status === 429 || r.status === 503) continue;
        return res.status(r.status).json({ error: 'Vision error ' + r.status + ': ' + errText.slice(0, 300) });
      }
      return res.status(429).json({ error: 'Vision model rate limited. Try again in a moment.' });
    } else if (isGroq) {
      if (!GROQ_KEYS.length) return res.status(500).json({ error: 'GROQ_API_KEY not configured in Vercel environment variables.' });
      for (let i = 0; i < GROQ_KEYS.length; i++) {
        const r = await tryGroq(GROQ_KEYS[i], systemPrompt, messages);
        if (r.ok) return pipeGroqStream(r, res);
        if (r.status === 429 || r.status === 413 || r.status === 503) continue;
        return res.status(r.status).json({ error: await r.text() });
      }
    } else {
      if (!GEMINI_KEYS.length) return res.status(500).json({ error: 'GEMINI_API_KEY not configured in Vercel environment variables.' });
      const geminiModel = model === 'gemini-2.0-flash' ? 'gemini-2.0-flash' : 'gemini-2.0-flash-lite';
      let lastGeminiError = '';
      for (let i = 0; i < GEMINI_KEYS.length; i++) {
        const r = await tryGemini(GEMINI_KEYS[i], geminiModel, systemPrompt, messages);
        if (r.ok) return pipeGeminiStream(r, res);
        const errText = await r.text();
        console.error('[Gemini key ' + (i+1) + '] status=' + r.status + ' body=' + errText.slice(0, 500));
        // Only retry on rate limit (429) or overloaded (503) — treat other errors as fatal
        if (r.status === 429 || r.status === 503) {
          lastGeminiError = 'Key ' + (i+1) + ' rate limited (' + r.status + ')';
          continue; // try next key
        }
        // Fatal error — return it directly with the actual error message
        return res.status(r.status).json({ error: 'Gemini error ' + r.status + ': ' + errText.slice(0, 500) });
      }
      // All keys rate-limited
      lastGeminiError = lastGeminiError || 'All Gemini keys exhausted';
    }
    return res.status(429).json({ error: RATE_LIMIT_MSG });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
