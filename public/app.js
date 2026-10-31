const MAX_CONTEXT_MESSAGES = 12;
let contextCharBudget = 28_000;
const STORAGE_KEY = 'still-chat-messages-v1';

const form = document.querySelector('#chat-form');
const input = document.querySelector('#message-input');
const sendButton = document.querySelector('#send-button');
const messageList = document.querySelector('#message-list');
const conversation = document.querySelector('#conversation');
const welcome = document.querySelector('#welcome');
const historyTitle = document.querySelector('#history-title');
const toast = document.querySelector('#toast');
let messages = loadMessages();
let busy = false;
let activeController;
let toastTimer;
let searchEnabled = false;

function scrollToBottom() {
  conversation.scrollTop = conversation.scrollHeight;
}

function keepMessageStartVisible(message) {
  const panelTop = conversation.getBoundingClientRect().top;
  const messageTop = message.getBoundingClientRect().top;
  conversation.scrollTop += messageTop - panelTop - 12;
}

function loadMessages() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(stored) ? stored.filter(m => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string') : [];
  } catch { return []; }
}

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
}

function selectContext(source) {
  const recent = source.slice(-MAX_CONTEXT_MESSAGES);
  const selected = [];
  let usedChars = 0;
  for (let index = recent.length - 1; index >= 0; index--) {
    const message = recent[index];
    const cost = message.content.length + 16;
    if (selected.length && usedChars + cost > contextCharBudget) break;
    selected.unshift(message);
    usedChars += cost;
  }
  return selected;
}

function safeText(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// A small, dependency-free Markdown renderer for common assistant formatting.
function renderMarkdown(source) {
  const codeBlocks = [];
  const protectedSource = source.replace(/```([\w-]*)\n?([\s\S]*?)```/g, (_match, _language, code) => {
    const index = codeBlocks.push(`<pre><code>${safeText(code.trimEnd())}</code></pre>`) - 1;
    return `\u0000CODE${index}\u0000`;
  });
  const text = protectedSource.replace(/<br\s*\/?>/gi, '\u0002LINEBREAK\u0002');
  const inline = value => {
    const inlineCode = [];
    let result = safeText(value).replace(/`([^`\n]+)`/g, (_match, code) => {
      const index = inlineCode.push(`<code>${code}</code>`) - 1;
      return `\u0001INLINE${index}\u0001`;
    });
    result = result.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
    result = result.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
    return result
      .replace(/\u0001INLINE(\d+)\u0001/g, (_m, index) => inlineCode[Number(index)])
      .replace(/\u0002LINEBREAK\u0002/g, '<br>');
  };

  const lines = text.split('\n');
  const blocks = [];
  const tableCells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
  const isTableDivider = line => tableCells(line).length > 1 && tableCells(line).every(cell => /^:?-{3,}:?$/.test(cell));
  const isTableAt = row => row + 1 < lines.length && lines[row].includes('|') && isTableDivider(lines[row + 1]);
  for (let index = 0; index < lines.length;) {
    const line = lines[index].trim();
    if (!line) { index++; continue; }
    const codeMatch = line.match(/^\u0000CODE(\d+)\u0000$/);
    if (codeMatch) { blocks.push(codeBlocks[Number(codeMatch[1])]); index++; continue; }
    if (isTableAt(index)) {
      const headings = tableCells(lines[index]);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].trim().includes('|')) {
        const cells = tableCells(lines[index]);
        rows.push(`<tr>${headings.map((_heading, cell) => `<td>${inline(cells[cell] || '')}</td>`).join('')}</tr>`);
        index++;
      }
      blocks.push(`<div class="table-wrap"><table><thead><tr>${headings.map(cell => `<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`);
      continue;
    }
    if (/^(?:-{3,}|_{3,}|\*{3,})$/.test(line)) { blocks.push('<hr>'); index++; continue; }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) { const level = heading[1].length; blocks.push(`<h${level}>${inline(heading[2])}</h${level}>`); index++; continue; }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) { blocks.push(`<blockquote>${inline(quote[1])}</blockquote>`); index++; continue; }
    const listItem = line.match(/^([-*])\s+(.+)$/) || line.match(/^\d+\.\s+(.+)$/);
    if (listItem) {
      const ordered = /^\d+\./.test(line);
      const items = [];
      while (index < lines.length) {
        const current = lines[index].trim();
        const item = ordered ? current.match(/^\d+\.\s+(.+)$/) : current.match(/^[-*]\s+(.+)$/);
        if (!item) break;
        items.push(`<li>${inline(item[1])}</li>`);
        index++;
      }
      const tag = ordered ? 'ol' : 'ul';
      blocks.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }
    const paragraph = [line];
    index++;
    while (index < lines.length && lines[index].trim() && !/^\u0000CODE\d+\u0000$/.test(lines[index].trim()) && !isTableAt(index) && !/^(?:-{3,}|_{3,}|\*{3,})$/.test(lines[index].trim()) && !/^(#{1,3})\s+/.test(lines[index].trim()) && !/^([-*])\s+/.test(lines[index].trim()) && !/^\d+\.\s+/.test(lines[index].trim()) && !/^>\s?/.test(lines[index].trim())) {
      paragraph.push(lines[index].trim());
      index++;
    }
    blocks.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
  }
  return blocks.join('');
}

function findStreamingTable(source) {
  const lines = source.split('\n');
  const offsets = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
  const isDivider = line => cells(line).length > 1 && cells(line).every(cell => /^:?-{3,}:?$/.test(cell));

  for (let row = 0; row + 1 < lines.length; row++) {
    if (!lines[row].includes('|') || !isDivider(lines[row + 1])) continue;
    if (((source.slice(0, offsets[row]).match(/```/g) || []).length % 2) !== 0) continue;
    let endRow = row + 2;
    while (endRow < lines.length && lines[endRow].trim() && lines[endRow].includes('|')) endRow++;
    return { start: offsets[row], end: endRow < lines.length ? offsets[endRow] : source.length };
  }
  return null;
}

function renderStreamingTable(body, source, range, caret) {
  const prefix = document.createElement('div');
  prefix.innerHTML = renderMarkdown(source.slice(0, range.start));
  const table = document.createElement('div');
  table.innerHTML = renderMarkdown(source.slice(range.start, range.end));
  const suffix = document.createElement('span');
  suffix.className = 'streaming-tail';
  suffix.textContent = source.slice(range.end);
  body.replaceChildren(prefix, table, suffix, caret);
}

function renderAssistantContent(body, content, sources = []) {
  body.innerHTML = renderMarkdown(content);
  const safeSources = sources.filter(source => source && /^https?:\/\//i.test(source.url || ''));
  if (!safeSources.length) return;
  const sourceList = document.createElement('div');
  sourceList.className = 'source-list';
  const label = document.createElement('span');
  label.textContent = 'Sources';
  sourceList.append(label);
  for (const source of safeSources) {
    const link = document.createElement('a');
    link.href = source.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = source.title || source.url;
    sourceList.append(link);
  }
  body.append(sourceList);
}

function renderMessage(message, isStreaming = false) {
  const article = document.createElement('article');
  article.className = `message ${message.role}`;
  const body = document.createElement('div');
  body.className = 'message-body';
  if (message.role === 'user') {
    body.textContent = message.content;
    article.append(body);
  } else {
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = '✳';
    renderAssistantContent(body, message.content, message.sources);
    if (isStreaming) {
      const caret = document.createElement('span');
      caret.className = 'typing-caret';
      caret.setAttribute('aria-label', 'Generating response');
      body.append(caret);
    }
    article.append(avatar, body);
  }
  messageList.append(article);
  return { article, body };
}

function drawHistory() {
  messageList.replaceChildren();
  welcome.hidden = messages.length > 0;
  historyTitle.textContent = messages.find(m => m.role === 'user')?.content.slice(0, 30) || 'A fresh start';
  for (const message of messages) renderMessage(message);
  scrollToBottom();
}

function setBusy(value) {
  busy = value;
  input.disabled = value;
  sendButton.disabled = value;
  sendButton.setAttribute('aria-label', value ? 'Generating response' : 'Send message');
  sendButton.innerHTML = value ? '<span>·</span>' : '<span>↑</span>';
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3200);
}

function resizeInput() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
}

async function submitMessage(content) {
  const trimmed = content.trim();
  if (!trimmed || busy) return;
  messages.push({ role: 'user', content: trimmed });
  persist();
  welcome.hidden = true;
  renderMessage(messages[messages.length - 1]);
  historyTitle.textContent = trimmed.slice(0, 30);
  input.value = '';
  resizeInput();
  setBusy(true);

  const assistantMessage = { role: 'assistant', content: '', sources: [] };
  const rendered = renderMessage(assistantMessage, true);
  const streamText = document.createTextNode('');
  const caret = document.createElement('span');
  caret.className = 'typing-caret';
  caret.setAttribute('aria-label', 'Generating response');
  rendered.body.append(streamText, caret);
  keepMessageStartVisible(rendered.article);
  const context = selectContext(messages);
  let receivedToken = false;
  let streamingTableStarted = false;
  activeController = new AbortController();
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ messages: context, search: searchEnabled }),
      signal: activeController.signal
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Request failed (${response.status}).`);
    }
    if (!response.body) throw new Error('Your browser could not read the response stream.');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let done = false;
    while (!done) {
      const { value, done: streamDone } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !streamDone });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() || '';
      for (const frame of frames) {
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
        if (!data) continue;
        let event;
        try { event = JSON.parse(data); } catch { continue; }
        if (event.type === 'token' && typeof event.token === 'string') {
          receivedToken = true;
          assistantMessage.content += event.token;
          // Keep in-flight text literal. Parsing incomplete Markdown on every token
          // makes emphasis and code blocks flicker and repeatedly reflow the page.
          if (!streamingTableStarted) {
            const tableRange = findStreamingTable(assistantMessage.content);
            if (tableRange) {
              streamingTableStarted = true;
              renderStreamingTable(rendered.body, assistantMessage.content, tableRange, caret);
            } else {
              streamText.appendData(event.token);
            }
          } else {
            const tableRange = findStreamingTable(assistantMessage.content);
            if (tableRange) renderStreamingTable(rendered.body, assistantMessage.content, tableRange, caret);
            else streamText.appendData(event.token);
          }
        } else if (event.type === 'sources' && Array.isArray(event.sources)) {
          assistantMessage.sources = event.sources;
        } else if (event.type === 'error') {
          throw new Error(event.error || 'The response stream was interrupted.');
        } else if (event.type === 'done') {
          done = true;
          break;
        }
      }
      if (streamDone) done = true;
    }
    if (!assistantMessage.content) assistantMessage.content = 'I didn’t receive a response. Please try again.';
    renderAssistantContent(rendered.body, assistantMessage.content, assistantMessage.sources);
    messages.push(assistantMessage);
    persist();
  } catch (error) {
    if (receivedToken && assistantMessage.content) {
      renderAssistantContent(rendered.body, assistantMessage.content, assistantMessage.sources);
      messages.push(assistantMessage);
      persist();
    } else {
      rendered.article.remove();
    }
    if (error.name !== 'AbortError') showToast(error.message || 'Something went wrong. Please try again.');
  } finally {
    activeController = null;
    setBusy(false);
    input.focus();
  }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  submitMessage(input.value);
});
input.addEventListener('input', resizeInput);
input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});
document.querySelectorAll('.suggestion').forEach(button => button.addEventListener('click', () => submitMessage(button.dataset.prompt)));
document.querySelector('#new-chat').addEventListener('click', () => {
  activeController?.abort();
  messages = [];
  persist();
  drawHistory();
  setBusy(false);
  input.focus();
  document.querySelector('#sidebar').classList.remove('open');
});
document.querySelector('#clear-chat').addEventListener('click', () => {
  activeController?.abort();
  messages = [];
  persist();
  drawHistory();
  setBusy(false);
  showToast('Conversation cleared.');
});
document.querySelector('#mobile-menu').addEventListener('click', () => document.querySelector('#sidebar').classList.toggle('open'));
document.querySelector('#current-chat').addEventListener('click', () => document.querySelector('#sidebar').classList.remove('open'));
const searchToggle = document.querySelector('#search-toggle');
searchToggle.addEventListener('click', () => {
  searchEnabled = !searchEnabled;
  searchToggle.setAttribute('aria-pressed', String(searchEnabled));
  searchToggle.classList.toggle('active', searchEnabled);
  searchToggle.title = searchEnabled ? 'Google Search grounding is on for this request.' : 'Turn on Google Search for current information.';
});
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    document.querySelector('#new-chat').click();
  }
  if (event.key === 'Escape') document.querySelector('#sidebar').classList.remove('open');
});

drawHistory();
fetch('/api/config').then(response => response.json()).then(config => {
  if (config.model) document.querySelector('#model-name').textContent = `${config.provider === 'gemini' ? 'Gemini' : 'Groq'} · ${config.model}`;
  if (Number.isFinite(config.contextCharBudget)) contextCharBudget = config.contextCharBudget;
  document.querySelector('#context-note').textContent = `Context · rolling window (${Math.round(contextCharBudget / 1000)}k chars)`;
  searchToggle.hidden = config.searchAvailable !== true;
}).catch(() => {});
