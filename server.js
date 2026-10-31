require('dotenv').config();

const express = require('express');
const path = require('path');

const app = express();
const port = Number(process.env.PORT) || 3000;
const provider = (process.env.AI_PROVIDER || 'groq').toLowerCase();
const model = provider === 'gemini'
  ? (process.env.GEMINI_MODEL || 'gemini-3.8-flash')
  : (process.env.GROQ_MODEL || 'llama-3.3-70b-versatile');
const maxMessages = 40;
const maxMessageLength = 20_000;
const defaultContextCharBudget = provider === 'gemini' ? 100_000 : 28_000;
const contextCharBudget = Math.max(24_000, Number(process.env.CONTEXT_CHAR_BUDGET) || defaultContextCharBudget);
const maxCompletionTokens = Math.max(256, Number(process.env.MAX_COMPLETION_TOKENS) || 1_200);
const systemPrompt = 'You are a helpful assistant. Answer directly and concisely. Avoid unnecessary background, repetition, and oversized examples. For code requests, provide a focused runnable example and only essential notes. Expand when the user asks for detail.';

function fitContext(messages) {
  const recent = [];
  let usedChars = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    const cost = message.content.length + 16;
    if (recent.length && usedChars + cost > contextCharBudget) break;
    recent.unshift(message);
    usedChars += cost;
  }
  return recent;
}

app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (_req, res) => {
  res.json({ model, provider, contextCharBudget, searchAvailable: provider === 'gemini' });
});

app.post('/api/chat', async (req, res) => {
  const { messages, search = false } = req.body || {};
  const apiKey = provider === 'gemini' ? process.env.GEMINI_API_KEY : process.env.GROQ_API_KEY;

  if (!apiKey) {
    return res.status(503).json({ error: `Add your ${provider === 'gemini' ? 'Gemini' : 'Groq'} API key to the .env file to start chatting.` });
  }
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > maxMessages) {
    return res.status(400).json({ error: `Send between 1 and ${maxMessages} messages.` });
  }

  const cleanMessages = [];
  for (const message of messages) {
    if (!message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string' || message.content.length > maxMessageLength) {
      return res.status(400).json({ error: 'One or more messages are invalid or too long.' });
    }
    cleanMessages.push({ role: message.role, content: message.content });
  }

  const recentMessages = fitContext(cleanMessages);
  const useSearch = provider === 'gemini' && search === true;
  const requestBody = provider === 'gemini'
    ? {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: recentMessages.map(message => ({
          role: message.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: message.content }]
        })),
        generationConfig: {
          temperature: 0.5,
          maxOutputTokens: maxCompletionTokens,
          thinkingConfig: { thinkingLevel: 'low' }
        },
        ...(useSearch ? { tools: [{ google_search: {} }] } : {})
      }
    : {
        model,
        messages: [{ role: 'system', content: systemPrompt }, ...recentMessages],
        stream: true,
        temperature: 0.5,
        max_completion_tokens: maxCompletionTokens
      };
  const endpoint = provider === 'gemini'
    ? `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`
    : 'https://api.groq.com/openai/v1/chat/completions';

  let upstream;
  try {
    upstream = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...(provider === 'gemini' ? { 'x-goog-api-key': apiKey } : { Authorization: `Bearer ${apiKey}` }),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });
  } catch (error) {
    console.error(`${provider} request failed:`, error.name, error.message, error.cause?.code || '');
    if (!res.headersSent) return res.status(502).json({ error: `Could not connect to ${provider === 'gemini' ? 'Gemini' : 'Groq'}. Please try again.` });
    return res.end();
  }

  if (!upstream.ok) {
    const details = await upstream.json().catch(() => ({}));
    const message = details?.error?.message || `${provider === 'gemini' ? 'Gemini' : 'Groq'} returned an error (${upstream.status}).`;
    return res.status(upstream.status).json({ error: message });
  }

  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let ended = false;
  const sources = new Map();
  const send = (event) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  try {
    while (!ended) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary;
      while ((boundary = buffer.match(/\r?\n\r?\n/)) !== null) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        for (const line of frame.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            if (sources.size) send({ type: 'sources', sources: [...sources.values()] });
            send({ type: 'done' });
            ended = true;
            break;
          }
          try {
            const payload = JSON.parse(data);
            let token;
            if (provider === 'gemini') {
              const candidate = payload.candidates?.[0];
              token = candidate?.content?.parts?.map(part => part.text || '').join('');
              for (const chunk of candidate?.groundingMetadata?.groundingChunks || []) {
                const web = chunk.web;
                if (web?.uri && !sources.has(web.uri)) sources.set(web.uri, { url: web.uri, title: web.title || web.uri });
              }
            } else {
              token = payload.choices?.[0]?.delta?.content;
            }
            if (typeof token === 'string' && token) send({ type: 'token', token });
          } catch {
            // Ignore malformed or partial upstream frames; the next frame is still usable.
          }
        }
        if (ended) break;
      }
    }
  } catch (error) {
    if (!res.writableEnded) send({ type: 'error', error: 'The response stream was interrupted. Please try again.' });
  } finally {
    reader.releaseLock();
    if (!ended) {
      if (sources.size) send({ type: 'sources', sources: [...sources.values()] });
      send({ type: 'done' });
    }
    if (!res.writableEnded) res.end();
  }
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(port, () => {
  console.log(`Chat app running at http://localhost:${port}`);
});
