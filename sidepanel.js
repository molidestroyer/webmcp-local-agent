/**
 * WebMCP Local Agent - sidepanel.js
 *
 * Agent logic: discovers Ollama models, discovers the WebMCP tools exposed by
 * the active tab and runs the tool-calling loop against /api/chat.
 */
'use strict';

const OLLAMA_HOSTS = ['http://127.0.0.1:11434', 'http://localhost:11434'];
const MAX_TOOL_STEPS = 6;

// Ollama answers 403 to any origin missing from OLLAMA_ORIGINS, and
// chrome-extension:// is not allowed by default. Chrome does not attach an
// Origin header to the GET on /api/tags (it carries no headers of its own) but
// it does to the POST on /api/chat, hence the confusing symptom: "the models
// load fine but sending a message returns 403".
const CORS_HINT = 'Ollama is rejecting the extension origin (403). Allow it: on Windows run '
  + '  setx OLLAMA_ORIGINS "chrome-extension://*"  and restart Ollama from the tray icon '
  + '(setx only affects newly started processes).';

const SYSTEM_PROMPT = [
  'You are an agent helping the user with the web page they currently have open.',
  'The page may expose tools (WebMCP). Use them whenever they help you answer or',
  'act on the page, passing exactly the arguments their schema requires.',
  'If no tool is useful, just answer directly.',
  'Never invent tools or results: if a call fails, say so.',
  'Reply in the language the user writes in, and be concise.',
].join(' ');

function describeHttpError(status, detail) {
  if (status === 403) return CORS_HINT;
  return 'Ollama responded ' + status + '. ' + String(detail || '').slice(0, 300);
}

const els = {
  modelSelect: document.getElementById('model-select'),
  refreshModels: document.getElementById('refresh-models'),
  toolsBadge: document.getElementById('tools-badge'),
  toolsBadgeText: document.getElementById('tools-badge-text'),
  refreshTools: document.getElementById('refresh-tools'),
  clearChat: document.getElementById('clear-chat'),
  toolsList: document.getElementById('tools-list'),
  status: document.getElementById('status'),
  chat: document.getElementById('chat'),
  input: document.getElementById('input'),
  send: document.getElementById('send'),
  confirmTools: document.getElementById('confirm-tools'),
};

const state = {
  host: OLLAMA_HOSTS[0],
  models: [],
  model: '',
  tools: [],
  // Tool names whose card is expanded, so re-renders do not collapse them.
  openTools: new Set(),
  messages: [{ role: 'system', content: SYSTEM_PROMPT }],
  tabId: null,
  busy: false,
  ollamaOk: false,
};

// --- Helpers ---------------------------------------------------------------

function scrollToBottom() {
  els.chat.scrollTop = els.chat.scrollHeight;
}

function clearEmptyState() {
  const empty = els.chat.querySelector('.empty');
  if (empty) empty.remove();
}

function showStatus(text) {
  if (!text) {
    els.status.hidden = true;
    els.status.textContent = '';
    return;
  }
  els.status.hidden = false;
  els.status.textContent = text;
}

function updateSendState() {
  els.send.disabled = state.busy || !state.ollamaOk || !state.model || !els.input.value.trim();
}

/** Minimal, safe markdown (never innerHTML for model output). */
function renderMarkdown(container, text) {
  container.textContent = '';
  const parts = String(text).split(/```/);
  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = part.replace(/^[a-zA-Z0-9_-]*\n/, '');
      pre.appendChild(code);
      container.appendChild(pre);
      return;
    }
    const chunks = part.split(/(`[^`\n]+`)/);
    chunks.forEach((chunk) => {
      if (!chunk) return;
      if (chunk.startsWith('`') && chunk.endsWith('`') && chunk.length > 2) {
        const code = document.createElement('code');
        code.textContent = chunk.slice(1, -1);
        container.appendChild(code);
      } else {
        container.appendChild(document.createTextNode(chunk));
      }
    });
  });
}

function pretty(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch (_) {
    return String(value);
  }
}

// --- Message rendering -----------------------------------------------------

function addMessage(role, text) {
  clearEmptyState();
  const div = document.createElement('div');
  div.className = 'msg msg--' + role;
  if (role === 'assistant') renderMarkdown(div, text);
  else div.textContent = text;
  els.chat.appendChild(div);
  scrollToBottom();
  return div;
}

/** Assistant bubble that fills in as the response streams. */
function createAssistantBubble() {
  clearEmptyState();
  const wrapper = document.createElement('div');
  wrapper.className = 'msg msg--assistant cursor';

  let thinkingBox = null;
  let thinkingPre = null;
  const body = document.createElement('span');
  wrapper.appendChild(body);
  els.chat.appendChild(wrapper);
  scrollToBottom();

  let content = '';
  let thinking = '';

  return {
    append(kind, delta) {
      const atBottom = els.chat.scrollHeight - els.chat.scrollTop - els.chat.clientHeight < 60;
      if (kind === 'thinking') {
        thinking += delta;
        if (!thinkingBox) {
          thinkingBox = document.createElement('details');
          thinkingBox.className = 'thinking';
          const summary = document.createElement('summary');
          summary.textContent = 'Model reasoning';
          thinkingPre = document.createElement('pre');
          thinkingBox.append(summary, thinkingPre);
          wrapper.insertBefore(thinkingBox, body);
        }
        thinkingPre.textContent = thinking;
      } else {
        content += delta;
        body.textContent = content;
      }
      if (atBottom) scrollToBottom();
    },
    finish(message) {
      wrapper.classList.remove('cursor');
      const finalText = (message && message.content) || content;
      if (finalText) {
        body.textContent = '';
        renderMarkdown(body, finalText);
      } else if (!thinkingBox) {
        wrapper.remove();
        return;
      } else {
        body.textContent = '';
      }
      scrollToBottom();
    },
    fail(text) {
      wrapper.classList.remove('cursor');
      wrapper.remove();
      addMessage('error', text);
    },
  };
}

/** Visual block for a single tool call. */
function createToolCard(name, args) {
  clearEmptyState();
  const card = document.createElement('div');
  card.className = 'toolcall';

  const head = document.createElement('div');
  head.className = 'toolcall__head';
  const icon = document.createElement('span');
  icon.textContent = '🔧';
  const label = document.createElement('span');
  label.className = 'toolcall__name';
  label.textContent = name;
  const stateEl = document.createElement('span');
  stateEl.className = 'toolcall__state';
  stateEl.textContent = 'running…';
  head.append(icon, label, stateEl);

  const body = document.createElement('div');
  body.className = 'toolcall__body';
  const argsLabel = document.createElement('div');
  argsLabel.className = 'toolcall__label';
  argsLabel.textContent = 'Arguments';
  const argsPre = document.createElement('pre');
  argsPre.textContent = pretty(args);
  body.append(argsLabel, argsPre);

  card.append(head, body);
  els.chat.appendChild(card);
  scrollToBottom();

  function addResult(title, text) {
    const resLabel = document.createElement('div');
    resLabel.className = 'toolcall__label';
    resLabel.textContent = title;
    const resPre = document.createElement('pre');
    resPre.textContent = text;
    body.append(resLabel, resPre);
    scrollToBottom();
  }

  return {
    element: card,
    done(text) {
      card.classList.add('toolcall--ok');
      stateEl.textContent = 'ok';
      addResult('Result', text);
    },
    fail(text) {
      card.classList.add('toolcall--err');
      stateEl.textContent = 'error';
      addResult('Error', text);
    },
    cancelled(text) {
      card.classList.add('toolcall--err');
      stateEl.textContent = 'cancelled';
      addResult('Status', text);
    },
    /** Shows the confirmation buttons and waits for the decision. */
    confirm() {
      stateEl.textContent = 'awaiting confirmation';
      return new Promise((resolve) => {
        const row = document.createElement('div');
        row.className = 'toolcall__confirm';
        const yes = document.createElement('button');
        yes.type = 'button';
        yes.className = 'primary';
        yes.textContent = 'Run';
        const no = document.createElement('button');
        no.type = 'button';
        no.textContent = 'Cancel';
        row.append(yes, no);
        card.appendChild(row);
        scrollToBottom();

        const finish = (value) => {
          row.remove();
          stateEl.textContent = value ? 'running…' : 'cancelled';
          resolve(value);
        };
        yes.addEventListener('click', () => finish(true));
        no.addEventListener('click', () => finish(false));
      });
    },
  };
}

// --- Ollama models ---------------------------------------------------------

async function fetchLocalModels() {
  els.refreshModels.classList.add('is-spinning');
  els.refreshModels.disabled = true;

  let lastError = null;
  for (const host of OLLAMA_HOSTS) {
    try {
      const response = await fetch(host + '/api/tags', { cache: 'no-store' });
      if (response.status === 403) {
        // Ollama is alive but rejects our origin: stop trying other hosts, a
        // "not detected" message would be misleading.
        state.host = host;
        state.ollamaOk = false;
        state.models = [];
        state.model = '';
        renderModelOptions('Ollama rejects the extension');
        showStatus(CORS_HINT);
        updateSendState();
        return;
      }
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = await response.json();
      const models = (data.models || [])
        .map((entry) => ({
          name: entry.name || entry.model,
          size: entry.size || 0,
          capabilities: entry.capabilities || [],
        }))
        .filter((entry) => entry.name)
        .sort((a, b) => a.name.localeCompare(b.name));

      state.host = host;
      state.models = models;
      state.ollamaOk = models.length > 0;

      if (!models.length) {
        renderModelOptions('No models pulled');
        showStatus('Ollama is running but has no models. Pull one with: ollama pull qwen3:8b');
        updateSendState();
        return;
      }

      const stored = await chrome.storage.local.get('selectedModel');
      const preferred = models.some((m) => m.name === stored.selectedModel)
        ? stored.selectedModel
        : models[0].name;

      renderModelOptions();
      els.modelSelect.value = preferred;
      state.model = preferred;
      showStatus('');
      updateSendState();
      return;
    } catch (err) {
      lastError = err;
    }
  }

  state.ollamaOk = false;
  state.models = [];
  state.model = '';
  renderModelOptions('Ollama not detected');
  showStatus(
    'Ollama not detected on 127.0.0.1:11434. Start it with "ollama serve" and hit 🔄. '
    + (lastError ? '(' + lastError.message + ')' : '')
  );
  updateSendState();
}

function renderModelOptions(placeholder) {
  els.modelSelect.textContent = '';
  if (placeholder) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = placeholder;
    els.modelSelect.appendChild(option);
    els.modelSelect.disabled = true;
    return;
  }
  els.modelSelect.disabled = false;
  for (const model of state.models) {
    const option = document.createElement('option');
    option.value = model.name;
    const gb = model.size ? ' · ' + (model.size / 1e9).toFixed(1) + ' GB' : '';
    const tools = model.capabilities.includes('tools') ? ' · tools' : '';
    option.textContent = model.name + gb + tools;
    els.modelSelect.appendChild(option);
  }
}

// --- Page tools ------------------------------------------------------------

async function currentTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tabId = tab ? tab.id : null;
  return state.tabId;
}

async function bridge(action, payload) {
  try {
    const answer = await chrome.runtime.sendMessage({
      type: 'bridge',
      tabId: state.tabId,
      action,
      payload,
    });
    return answer || { result: null, error: 'The service worker did not respond.' };
  } catch (err) {
    return { result: null, error: String((err && err.message) || err) };
  }
}

async function detectPageTools() {
  els.refreshTools.classList.add('is-spinning');
  try {
    await currentTabId();
    if (state.tabId == null) {
      state.tools = [];
      renderToolsBadge('No active tab');
      return;
    }

    const answer = await bridge('list', null);
    if (!answer || answer.error) {
      state.tools = [];
      renderToolsBadge('0 tools');
      els.toolsList.textContent = '';
      els.toolsList.hidden = true;
      return;
    }

    state.tools = Array.isArray(answer.result) ? answer.result : [];
    renderToolsBadge();
    renderToolsList();
  } finally {
    els.refreshTools.classList.remove('is-spinning');
  }
}

function renderToolsBadge(text) {
  const count = state.tools.length;
  els.toolsBadgeText.textContent = text || (count === 1 ? '1 tool detected' : count + ' tools detected');
  els.toolsBadge.classList.toggle('has-tools', count > 0);
}

// --- Tool inspector cards --------------------------------------------------

const TOOL_ICONS = [
  [/(book|reserve|schedul|appointment|slot|calendar|date)/, '📅'],
  [/(cart|buy|order|checkout|purchas|pay)/, '🛒'],
  [/(search|find|query|lookup)/, '🔍'],
  [/(add|create|new|insert|append)/, '➕'],
  [/(delete|remove|clear|cancel)/, '🗑'],
  [/(list|todos|items|all|get|read|fetch|info)/, '📋'],
  [/(update|edit|set|change|toggle)/, '✏️'],
  [/(theme|color|style|dark|light)/, '🎨'],
  [/(send|mail|message|notify|email)/, '✉️'],
  [/(user|account|profile|login|auth)/, '👤'],
  [/(nav|open|go|route|scroll|click)/, '🧭'],
];

function iconForTool(tool) {
  const haystack = (tool.name + ' ' + (tool.description || '')).toLowerCase();
  for (const [pattern, icon] of TOOL_ICONS) {
    if (pattern.test(haystack)) return icon;
  }
  return '⚡';
}

/** `checkInDate` / `check_in_date` / `check-in-date` -> `Check In Date`. */
function humanizeParam(key) {
  return String(key)
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function schemaOf(tool) {
  const schema = tool.inputSchema || tool.parameters;
  return schema && typeof schema === 'object' && !Array.isArray(schema) ? schema : {};
}

function propertyNames(schema) {
  const props = schema.properties;
  return props && typeof props === 'object' ? Object.keys(props) : [];
}

function requiredNames(schema) {
  return Array.isArray(schema.required) ? schema.required : [];
}

/** Plain-language summary of what the tool asks for. */
function describeNeeds(props, required) {
  if (!props.length) return 'No input needed.';
  const primary = (required.length ? required : props).map(humanizeParam);
  if (props.length === 1) return 'Needs: ' + primary[0] + '.';
  // "and more" tracks the total, not just the sample: a tool with 2 required and
  // 2 optional params still asks for 4 things.
  const shown = primary.slice(0, 2);
  const more = props.length > shown.length;
  const sample = more ? shown.join(', ') + ' and more' : shown.join(' and ');
  return 'Needs ' + props.length + ' details (like ' + sample + ').';
}

function makeSection(labelText) {
  const section = document.createElement('div');
  section.className = 'tool-card__section';
  const label = document.createElement('div');
  label.className = 'tool-card__label';
  label.textContent = labelText;
  section.appendChild(label);
  return section;
}

/** Small form so a tool can be tried by hand, typed from its JSON Schema. */
function buildToolForm(schema, props) {
  const form = document.createElement('div');
  form.className = 'tool-form';
  const required = requiredNames(schema);
  const readers = [];

  for (const key of props) {
    const def = (schema.properties && schema.properties[key]) || {};
    const field = document.createElement('div');
    field.className = 'tool-form__field';

    const label = document.createElement('label');
    label.textContent = key + (required.includes(key) ? ' *' : '');
    field.appendChild(label);

    let input;
    if (Array.isArray(def.enum) && def.enum.length) {
      input = document.createElement('select');
      if (!required.includes(key)) input.appendChild(new Option('', ''));
      for (const value of def.enum) input.appendChild(new Option(String(value), String(value)));
    } else if (def.type === 'boolean') {
      input = document.createElement('input');
      input.type = 'checkbox';
    } else if (def.type === 'number' || def.type === 'integer') {
      input = document.createElement('input');
      input.type = 'number';
      if (def.type === 'integer') input.step = '1';
    } else {
      input = document.createElement('input');
      input.type = 'text';
    }
    if (def.description) {
      input.title = def.description;
      if (input.type === 'text' || input.type === 'number') input.placeholder = def.description;
    }

    field.appendChild(input);
    form.appendChild(field);

    readers.push(() => {
      if (def.type === 'boolean') return [key, input.checked];
      const raw = input.value;
      if (raw === '' && !required.includes(key)) return null;
      if (def.type === 'number' || def.type === 'integer') {
        const num = Number(raw);
        return [key, Number.isNaN(num) ? raw : num];
      }
      if (def.type === 'array' || def.type === 'object') {
        try {
          return [key, JSON.parse(raw)];
        } catch (_) {
          return [key, raw];
        }
      }
      return [key, raw];
    });
  }

  return {
    element: form,
    read() {
      const args = {};
      for (const reader of readers) {
        const entry = reader();
        if (entry) args[entry[0]] = entry[1];
      }
      return args;
    },
  };
}

function createToolListItem(tool) {
  const schema = schemaOf(tool);
  const props = propertyNames(schema);
  const required = requiredNames(schema);

  const card = document.createElement('div');
  card.className = 'tool-card';
  if (state.openTools.has(tool.name)) card.classList.add('is-open');

  // --- Header (always visible)
  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'tool-card__head';
  head.setAttribute('aria-expanded', String(card.classList.contains('is-open')));

  const icon = document.createElement('span');
  icon.className = 'tool-card__icon';
  icon.textContent = iconForTool(tool);

  const titles = document.createElement('div');
  titles.className = 'tool-card__titles';
  const title = document.createElement('div');
  title.className = 'tool-card__name';
  title.textContent = humanizeParam(tool.name);
  const id = document.createElement('div');
  id.className = 'tool-card__id';
  id.textContent = tool.name;
  const teaser = document.createElement('div');
  teaser.className = 'tool-card__teaser';
  teaser.textContent = tool.description || 'No description provided.';
  titles.append(title, id, teaser);

  const chevron = document.createElement('span');
  chevron.className = 'tool-card__chevron';
  chevron.textContent = '▼';

  head.append(icon, titles, chevron);

  // --- Expandable body
  const details = document.createElement('div');
  details.className = 'tool-card__details';
  const inner = document.createElement('div');
  details.appendChild(inner);

  const does = makeSection('What it does');
  const doesText = document.createElement('div');
  doesText.className = 'tool-card__text';
  doesText.textContent = tool.description || 'The page did not provide a description.';
  does.appendChild(doesText);

  const needs = makeSection('What it needs');
  const needsText = document.createElement('div');
  needsText.className = 'tool-card__text';
  needsText.textContent = describeNeeds(props, required);
  needs.appendChild(needsText);

  inner.append(does, needs);

  if (props.length) {
    const params = makeSection('Parameters');
    const pills = document.createElement('div');
    pills.className = 'pills';
    for (const key of props) {
      const pill = document.createElement('span');
      pill.className = 'pill' + (required.includes(key) ? ' pill--required' : '');
      const def = (schema.properties && schema.properties[key]) || {};
      pill.textContent = key + (def.type ? ':' + def.type : '');
      if (def.description) pill.title = def.description;
      pills.appendChild(pill);
    }
    params.appendChild(pills);
    inner.appendChild(params);
  }

  // --- Manual run
  const runSection = makeSection('Try it');
  const form = buildToolForm(schema, props);
  if (props.length) runSection.appendChild(form.element);
  const output = document.createElement('div');
  output.className = 'tool-out';
  output.hidden = true;
  runSection.appendChild(output);
  inner.appendChild(runSection);

  // --- Footer
  const foot = document.createElement('div');
  foot.className = 'tool-card__foot';
  const via = document.createElement('span');
  via.textContent = 'Registered via';
  const source = document.createElement('span');
  source.className = 'pill tool-card__source';
  source.textContent = '⚙️ JavaScript API';
  // The raw object the tool came from is more precise than the friendly label.
  if (tool.source) source.title = tool.source;
  const run = document.createElement('button');
  run.type = 'button';
  run.className = 'tool-card__run';
  run.textContent = 'Run ▶';
  foot.append(via, source, run);

  card.append(head, details, foot);

  // --- Behaviour
  head.addEventListener('click', () => {
    const open = card.classList.toggle('is-open');
    head.setAttribute('aria-expanded', String(open));
    if (open) state.openTools.add(tool.name);
    else state.openTools.delete(tool.name);
  });

  run.addEventListener('click', async () => {
    if (!card.classList.contains('is-open')) head.click();
    run.disabled = true;
    run.textContent = 'Running…';
    output.hidden = false;
    output.className = 'tool-out';
    output.textContent = 'Running…';

    const answer = await bridge('execute', { name: tool.name, args: form.read() });
    if (!answer || answer.error) {
      output.className = 'tool-out tool-out--err';
      output.textContent = (answer && answer.error) || 'Unknown error.';
    } else {
      output.textContent = resultToText(answer.result);
    }
    run.disabled = false;
    run.textContent = 'Run ▶';
  });

  return card;
}

function renderToolsList() {
  els.toolsList.textContent = '';
  if (!state.tools.length) {
    els.toolsList.hidden = true;
    return;
  }
  for (const tool of state.tools) {
    els.toolsList.appendChild(createToolListItem(tool));
  }
}

function normalizeSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {} };
  }
  const out = Object.assign({}, schema);
  if (!out.type) out.type = 'object';
  if (out.type === 'object' && !out.properties) out.properties = {};
  return out;
}

function toOllamaTool(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || tool.name,
      parameters: normalizeSchema(tool.inputSchema),
    },
  };
}

/** Turns a tool result (MCP shape or anything else) into text. */
function resultToText(result) {
  if (result === null || result === undefined) return 'The tool returned no value.';
  if (typeof result === 'string') return result;

  if (Array.isArray(result.content)) {
    const parts = result.content.map((block) => {
      if (!block || typeof block !== 'object') return String(block);
      if (typeof block.text === 'string') return block.text;
      return pretty(block);
    });
    const text = parts.join('\n').trim();
    if (text) return result.isError ? 'Error: ' + text : text;
  }

  return pretty(result);
}

// --- Chat loop -------------------------------------------------------------

async function ollamaChat(messages, tools, onDelta) {
  const body = {
    model: state.model,
    messages,
    stream: true,
  };
  if (tools.length) body.tools = tools;

  const response = await fetch(state.host + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const error = new Error(describeHttpError(response.status, detail));
    error.status = response.status;
    throw error;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const accumulated = { role: 'assistant', content: '', thinking: '', tool_calls: [] };
  let buffer = '';

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let chunk;
    try {
      chunk = JSON.parse(trimmed);
    } catch (_) {
      return;
    }
    if (chunk.error) throw new Error(chunk.error);
    const message = chunk.message || {};
    if (message.thinking) {
      accumulated.thinking += message.thinking;
      onDelta('thinking', message.thinking);
    }
    if (message.content) {
      accumulated.content += message.content;
      onDelta('content', message.content);
    }
    if (Array.isArray(message.tool_calls)) {
      accumulated.tool_calls.push(...message.tool_calls);
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      handleLine(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
  }
  handleLine(buffer);

  const result = { role: 'assistant', content: accumulated.content };
  if (accumulated.thinking) result.thinking = accumulated.thinking;
  if (accumulated.tool_calls.length) result.tool_calls = accumulated.tool_calls;
  return result;
}

function parseArguments(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
      return {};
    }
  }
  return {};
}

async function runToolCall(call) {
  const fn = call.function || {};
  const name = fn.name;
  const args = parseArguments(fn.arguments);
  const card = createToolCard(name || '(unnamed)', args);

  if (!name || !state.tools.some((tool) => tool.name === name)) {
    const text = 'The page exposes no tool named "' + String(name) + '".';
    card.fail(text);
    return { role: 'tool', tool_name: String(name || 'unknown'), content: 'Error: ' + text };
  }

  if (els.confirmTools.checked) {
    const approved = await card.confirm();
    if (!approved) {
      const text = 'The user cancelled this tool call.';
      card.cancelled(text);
      return { role: 'tool', tool_name: name, content: text };
    }
  }

  const answer = await bridge('execute', { name, args });
  if (!answer || answer.error) {
    const text = (answer && answer.error) || 'Unknown error while running the tool.';
    card.fail(text);
    return { role: 'tool', tool_name: name, content: 'Error: ' + text };
  }

  const text = resultToText(answer.result);
  card.done(text);
  return { role: 'tool', tool_name: name, content: text };
}

async function runAgent() {
  const tools = state.tools.map(toOllamaTool);

  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    const bubble = createAssistantBubble();
    let reply;
    try {
      reply = await ollamaChat(state.messages, tools, (kind, delta) => bubble.append(kind, delta));
    } catch (err) {
      const message = String((err && err.message) || err);
      // A 403 will not fix itself on retry: Ollama has to be reconfigured, so
      // keep the hint pinned in the status bar as well as in the chat.
      if (err && err.status === 403) showStatus(CORS_HINT);
      bubble.fail('Failed to reach Ollama: ' + message);
      return;
    }

    bubble.finish(reply);
    state.messages.push(reply);

    if (!reply.tool_calls || !reply.tool_calls.length) return;

    for (const call of reply.tool_calls) {
      state.messages.push(await runToolCall(call));
    }
  }

  addMessage('note', 'Reached the limit of ' + MAX_TOOL_STEPS + ' tool rounds.');
}

async function sendMessage() {
  const text = els.input.value.trim();
  if (!text || state.busy || !state.model) return;

  state.busy = true;
  els.input.value = '';
  autoGrow();
  updateSendState();

  addMessage('user', text);
  state.messages.push({ role: 'user', content: text });

  try {
    await detectPageTools();
    await runAgent();
  } finally {
    state.busy = false;
    updateSendState();
    els.input.focus();
  }
}

// --- Events ----------------------------------------------------------------

function autoGrow() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 160) + 'px';
}

els.input.addEventListener('input', () => {
  autoGrow();
  updateSendState();
});

els.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

els.send.addEventListener('click', sendMessage);

els.refreshModels.addEventListener('click', async () => {
  await fetchLocalModels();
  els.refreshModels.classList.remove('is-spinning');
  els.refreshModels.disabled = false;
});

els.modelSelect.addEventListener('change', () => {
  state.model = els.modelSelect.value;
  chrome.storage.local.set({ selectedModel: state.model });
  updateSendState();
});

els.refreshTools.addEventListener('click', detectPageTools);

els.toolsBadge.addEventListener('click', () => {
  if (!state.tools.length) return;
  els.toolsList.hidden = !els.toolsList.hidden;
});

els.clearChat.addEventListener('click', () => {
  state.messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  els.chat.textContent = '';
  const empty = document.createElement('div');
  empty.className = 'empty';
  const title = document.createElement('h1');
  title.textContent = 'Conversation cleared';
  const hint = document.createElement('p');
  hint.textContent = 'Type a message to start over.';
  empty.append(title, hint);
  els.chat.appendChild(empty);
});

els.confirmTools.addEventListener('change', () => {
  chrome.storage.local.set({ confirmTools: els.confirmTools.checked });
});

chrome.tabs.onActivated.addListener(detectPageTools);
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === state.tabId && changeInfo.status === 'complete') detectPageTools();
});
chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === 'tools-changed' && message.tabId === state.tabId) {
    detectPageTools();
  }
});

// --- Bootstrap -------------------------------------------------------------

(async function init() {
  const stored = await chrome.storage.local.get('confirmTools');
  els.confirmTools.checked = Boolean(stored.confirmTools);

  await fetchLocalModels();
  els.refreshModels.classList.remove('is-spinning');
  els.refreshModels.disabled = false;

  await detectPageTools();
  els.input.focus();
})();
