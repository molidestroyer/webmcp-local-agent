/**
 * WebMCP Local Agent - sidepanel.js
 *
 * Logica del agente: descubre modelos de Ollama, descubre las tools WebMCP de
 * la pestana activa y ejecuta el ciclo de tool calling contra /api/chat.
 */
'use strict';

const OLLAMA_HOSTS = ['http://127.0.0.1:11434', 'http://localhost:11434'];
const MAX_TOOL_STEPS = 6;

// Ollama rechaza con 403 cualquier origen que no este en OLLAMA_ORIGINS, y
// chrome-extension:// no entra en la lista por defecto. Chrome no manda Origin
// en el GET de /api/tags (sin cabeceras), pero si en el POST de /api/chat, asi
// que el sintoma tipico es "los modelos cargan pero al enviar sale 403".
const CORS_HINT = 'Ollama rechaza el origen de la extensión (403). Arráncalo permitiéndolo: '
  + 'en Windows ejecuta  setx OLLAMA_ORIGINS "chrome-extension://*"  y reinicia Ollama '
  + 'desde el icono de la bandeja (setx solo afecta a procesos nuevos).';

function describeHttpError(status, detail) {
  if (status === 403) return CORS_HINT;
  return 'Ollama respondió ' + status + '. ' + String(detail || '').slice(0, 300);
}
const SYSTEM_PROMPT = [
  'Eres un agente que asiste al usuario sobre la pagina web que tiene abierta.',
  'La pagina puede exponer herramientas (WebMCP). Usalas cuando sirvan para',
  'responder o para actuar sobre la pagina, con los argumentos exactos que pide',
  'su esquema. Si no hay ninguna herramienta util, responde directamente.',
  'No inventes herramientas ni resultados: si una llamada falla, dilo.',
  'Responde en el idioma del usuario y se breve.',
].join(' ');

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
  messages: [{ role: 'system', content: SYSTEM_PROMPT }],
  tabId: null,
  busy: false,
  ollamaOk: false,
};

// --- Utilidades ------------------------------------------------------------

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

/** Markdown minimo y seguro (sin innerHTML de contenido del modelo). */
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

// --- Render de mensajes ----------------------------------------------------

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

/** Burbuja de asistente que se va rellenando en streaming. */
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
          summary.textContent = 'Razonamiento del modelo';
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

/** Bloque visual de una llamada a herramienta. */
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
  stateEl.textContent = 'ejecutando…';
  head.append(icon, label, stateEl);

  const body = document.createElement('div');
  body.className = 'toolcall__body';
  const argsLabel = document.createElement('div');
  argsLabel.className = 'toolcall__label';
  argsLabel.textContent = 'Argumentos';
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
      addResult('Resultado', text);
    },
    fail(text) {
      card.classList.add('toolcall--err');
      stateEl.textContent = 'error';
      addResult('Error', text);
    },
    cancelled(text) {
      card.classList.add('toolcall--err');
      stateEl.textContent = 'cancelada';
      addResult('Estado', text);
    },
    /** Muestra los botones de confirmacion y espera la decision. */
    confirm() {
      stateEl.textContent = 'esperando confirmación';
      return new Promise((resolve) => {
        const row = document.createElement('div');
        row.className = 'toolcall__confirm';
        const yes = document.createElement('button');
        yes.type = 'button';
        yes.className = 'primary';
        yes.textContent = 'Ejecutar';
        const no = document.createElement('button');
        no.type = 'button';
        no.textContent = 'Cancelar';
        row.append(yes, no);
        card.appendChild(row);
        scrollToBottom();

        const finish = (value) => {
          row.remove();
          stateEl.textContent = value ? 'ejecutando…' : 'cancelada';
          resolve(value);
        };
        yes.addEventListener('click', () => finish(true));
        no.addEventListener('click', () => finish(false));
      });
    },
  };
}

// --- Modelos de Ollama -----------------------------------------------------

async function fetchLocalModels() {
  els.refreshModels.classList.add('is-spinning');
  els.refreshModels.disabled = true;

  let lastError = null;
  for (const host of OLLAMA_HOSTS) {
    try {
      const response = await fetch(host + '/api/tags', { cache: 'no-store' });
      if (response.status === 403) {
        // Ollama esta vivo pero no acepta el origen: no seguir probando hosts,
        // el mensaje de "no detectado" seria enganoso.
        state.host = host;
        state.ollamaOk = false;
        state.models = [];
        state.model = '';
        renderModelOptions('Ollama rechaza la extensión');
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
        renderModelOptions('Ollama sin modelos descargados');
        showStatus('Ollama responde pero no hay modelos. Descarga uno con: ollama pull qwen3:8b');
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
  renderModelOptions('Ollama no detectado');
  showStatus(
    'Ollama no detectado en 127.0.0.1:11434. Arráncalo con "ollama serve" y pulsa 🔄. '
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

// --- Tools de la pagina ----------------------------------------------------

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
    return answer || { result: null, error: 'El service worker no respondió.' };
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
      renderToolsBadge('Sin pestaña activa');
      return;
    }

    const answer = await bridge('list', null);
    if (!answer || answer.error) {
      state.tools = [];
      renderToolsBadge('0 Tools');
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
  els.toolsBadgeText.textContent = text || (count === 1 ? '1 Tool detectada' : count + ' Tools detectadas');
  els.toolsBadge.classList.toggle('has-tools', count > 0);
}

function renderToolsList() {
  els.toolsList.textContent = '';
  if (!state.tools.length) {
    els.toolsList.hidden = true;
    return;
  }
  for (const tool of state.tools) {
    const item = document.createElement('div');
    item.className = 'tools-list__item';
    const name = document.createElement('div');
    name.className = 'tools-list__name';
    name.textContent = tool.name;
    const desc = document.createElement('div');
    desc.className = 'tools-list__desc';
    desc.textContent = tool.description || 'Sin descripción.';
    item.append(name, desc);
    els.toolsList.appendChild(item);
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

/** Convierte el resultado de una tool (formato MCP o libre) en texto. */
function resultToText(result) {
  if (result === null || result === undefined) return 'La herramienta no devolvió ningún valor.';
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

// --- Ciclo de chat ---------------------------------------------------------

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
  const card = createToolCard(name || '(sin nombre)', args);

  if (!name || !state.tools.some((tool) => tool.name === name)) {
    const text = 'La página no expone ninguna herramienta llamada "' + String(name) + '".';
    card.fail(text);
    return { role: 'tool', tool_name: String(name || 'unknown'), content: 'Error: ' + text };
  }

  if (els.confirmTools.checked) {
    const approved = await card.confirm();
    if (!approved) {
      const text = 'El usuario canceló la ejecución de esta herramienta.';
      card.cancelled(text);
      return { role: 'tool', tool_name: name, content: text };
    }
  }

  const answer = await bridge('execute', { name, args });
  if (!answer || answer.error) {
    const text = (answer && answer.error) || 'Error desconocido al ejecutar la herramienta.';
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
      // El 403 no se arregla reintentando: hay que reconfigurar Ollama, asi que
      // ademas del mensaje en el chat lo dejamos fijo en la barra de estado.
      if (err && err.status === 403) showStatus(CORS_HINT);
      bubble.fail('Fallo al hablar con Ollama: ' + message);
      return;
    }

    bubble.finish(reply);
    state.messages.push(reply);

    if (!reply.tool_calls || !reply.tool_calls.length) return;

    for (const call of reply.tool_calls) {
      state.messages.push(await runToolCall(call));
    }
  }

  addMessage('note', 'Se alcanzó el límite de ' + MAX_TOOL_STEPS + ' rondas de herramientas.');
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

// --- Eventos ---------------------------------------------------------------

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
  title.textContent = 'Conversación vaciada';
  const hint = document.createElement('p');
  hint.textContent = 'Escribe un mensaje para empezar de nuevo.';
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

// --- Arranque --------------------------------------------------------------

(async function init() {
  const stored = await chrome.storage.local.get('confirmTools');
  els.confirmTools.checked = Boolean(stored.confirmTools);

  await fetchLocalModels();
  els.refreshModels.classList.remove('is-spinning');
  els.refreshModels.disabled = false;

  await detectPageTools();
  els.input.focus();
})();
