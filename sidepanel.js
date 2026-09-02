/**
 * WebMCP Local Agent - sidepanel.js
 *
 * Four tabs over one shared state:
 *   Chat     - Ollama conversation with automatic tool calling
 *   Tools    - rich cards for the tools the active tab exposes
 *   Execute  - manual runs with a schema-driven form and a live JSON editor
 *   History  - every execution, manual or model-driven
 */
'use strict';

const OLLAMA_HOSTS = ['http://127.0.0.1:11434', 'http://localhost:11434'];
const MAX_TOOL_STEPS = 6;
const HISTORY_LIMIT = 100;
// Local models (Ollama) can take much longer than Copilot to answer a suggestion
// request, especially on first load when the model has to be paged into VRAM.
const SUGGESTION_TIMEOUT_MS = 45000;
const TABS = ['chat', 'tools', 'execute', 'history', 'logs', 'settings'];

// Ollama answers 403 to any origin missing from OLLAMA_ORIGINS, and
// chrome-extension:// is not allowed by default. Chrome does not attach an
// Origin header to the GET on /api/tags (it carries no headers of its own) but
// it does to the POST on /api/chat, hence the confusing symptom: "the models
// load fine but sending a message returns 403".
const CORS_HINT = 'Ollama is rejecting the extension origin (403). Allow it: on Windows run '
  + '  setx OLLAMA_ORIGINS "chrome-extension://*"  and restart Ollama from the tray icon '
  + '(setx only affects newly started processes).';

const SYSTEM_PROMPT = [
  'You are the agent inside a Chrome side panel. The page the user is looking at exposes',
  'WebMCP tools, and you are the only thing that can call them.',
  '',
  'HOW TO ANSWER',
  '- If the request can be done with a tool, CALL THE TOOL. Do not describe what you are',
  '  about to do: the user sees what you do, not what you plan.',
  '- Never say "I will", "let me" or "I\'m going to" about a tool. Either you call it in this',
  '  same turn, or you do not mention it.',
  '- Never report something as done unless a tool returned a result saying so.',
  '- Ask the user only when a REQUIRED parameter is missing and cannot be inferred. Do not',
  '  ask for permission: the panel already does that when the user wants it.',
  '- Read the input schema before filling arguments. Use its exact property names and its',
  '  allowed enum values. Never invent tools, parameters or results.',
  '- If the page exposes no tools other than "wait", say so plainly: this page publishes no',
  '  WebMCP tools, so there is nothing here you can act on. Answer from your own knowledge if',
  '  the question allows it, and never pretend to have acted on the page.',
  '',
  'AFTER A TOOL RUNS',
  '- In-progress status (PENDING, RUNNING, QUEUED) or a navigation: call "wait" with',
  '  seconds=5, then check the status again. If it is still in progress, wait 10, then 20.',
  '  After the third wait, stop and report what the last status was.',
  '- The page\'s tools change as the page does: re-read the list at each step.',
  '- SUCCESS or COMPLETED: stop calling tools and tell the user what happened, briefly, in',
  '  their language.',
  '- FAILED: stop calling tools, state the failure reason the tool gave, and ask the user',
  '  whether to retry or try something else. Do not stop silently and do not retry the same',
  '  call with the same arguments.',
].join('\n');

const NATIVE_WAIT_TOOL = {
  type: 'function',
  function: {
    name: 'wait',
    description: 'Pause execution for a specified duration in seconds (1 to 30s) to allow asynchronous page updates, SPA transitions, background tasks, or status changes to complete before re-inspecting page tools.',
    parameters: {
      type: 'object',
      properties: {
        seconds: {
          type: 'number',
          description: 'Number of seconds to wait (1 to 30). Default is 5.',
        },
      },
      required: ['seconds'],
    },
  },
};

function describeHttpError(status, detail) {
  if (status === 403) return CORS_HINT;
  return 'Ollama responded ' + status + '. ' + String(detail || '').slice(0, 300);
}

const els = {
  // header
  toolsBadge: document.getElementById('tools-badge'),
  toolsBadgeText: document.getElementById('tools-badge-text'),
  refreshTools: document.getElementById('refresh-tools'),
  modelSelect: document.getElementById('model-select'),
  refreshModels: document.getElementById('refresh-models'),
  status: document.getElementById('status'),
  // chat
  chat: document.getElementById('chat'),
  chatThreadsView: document.getElementById('chat-threads-view'),
  chatActiveView: document.getElementById('chat-active-view'),
  chatThreadsList: document.getElementById('chat-threads-list'),
  chatBackBtn: document.getElementById('chat-back-btn'),
  chatThreadTitle: document.getElementById('chat-thread-title'),
  chatThreadDomain: document.getElementById('chat-thread-domain'),
  threadsDomain: document.getElementById('threads-domain'),
  chatNewBtn: document.getElementById('chat-new-btn'),
  threadsNewBtn: document.getElementById('threads-new-btn'),
  composer: document.getElementById('composer'),
  input: document.getElementById('input'),
  send: document.getElementById('send'),
  clearChat: document.getElementById('clear-chat'),
  confirmTools: document.getElementById('confirm-tools'),
  suggestions: document.getElementById('suggestions'),
  suggestionsLoading: document.getElementById('suggestions-loading'),
  suggestionsChips: document.getElementById('suggestions-chips'),
  // settings
  autoSuggestToggle: document.getElementById('auto-suggest-toggle'),
  resetChatOnTabToggle: document.getElementById('reset-chat-on-tab-toggle'),
  catalogSourceNone: document.getElementById('catalog-source-none'),
  catalogSourceDemo: document.getElementById('catalog-source-demo'),
  catalogSourceRemote: document.getElementById('catalog-source-remote'),
  catalogRemoteFields: document.getElementById('catalog-remote-fields'),
  catalogUrl: document.getElementById('catalog-url'),
  catalogToken: document.getElementById('catalog-token'),
  catalogSyncBtn: document.getElementById('catalog-sync-btn'),
  catalogStatusBadge: document.getElementById('catalog-status-badge'),
  catalogStatusMeta: document.getElementById('catalog-status-meta'),
  catalogRulesCount: document.getElementById('catalog-rules-count'),
  catalogRulesList: document.getElementById('catalog-rules-list'),
  // copilot settings
  copilotStatusBox: document.getElementById('copilot-status-box'),
  copilotDisconnectedView: document.getElementById('copilot-disconnected-view'),
  copilotPendingView: document.getElementById('copilot-pending-view'),
  copilotConnectedView: document.getElementById('copilot-connected-view'),
  copilotConnectBtn: document.getElementById('copilot-connect-btn'),
  copilotUserCode: document.getElementById('copilot-user-code'),
  copilotCopyCodeBtn: document.getElementById('copilot-copy-code-btn'),
  copilotVerifyLink: document.getElementById('copilot-verify-link'),
  copilotPollingText: document.getElementById('copilot-polling-text'),
  copilotCancelBtn: document.getElementById('copilot-cancel-btn'),
  copilotDisconnectBtn: document.getElementById('copilot-disconnect-btn'),
  copilotErrorMsg: document.getElementById('copilot-error-msg'),
  catalogActive: document.getElementById('catalog-active'),
  catalogActiveText: document.getElementById('catalog-active-text'),

  // logs
  logsOutput: document.getElementById('logs-output'),
  logsCopyBtn: document.getElementById('logs-copy-btn'),
  logsClearBtn: document.getElementById('logs-clear-btn'),
  // tools
  toolsList: document.getElementById('tools-list'),
  toolsEmpty: document.getElementById('tools-empty'),
  // execute
  execPicker: document.getElementById('exec-picker'),
  execBody: document.getElementById('exec-body'),
  execIcon: document.getElementById('exec-icon'),
  execName: document.getElementById('exec-name'),
  execDesc: document.getElementById('exec-desc'),
  execForm: document.getElementById('exec-form'),
  execJson: document.getElementById('exec-json'),
  execJsonState: document.getElementById('exec-json-state'),
  execRun: document.getElementById('exec-run'),
  execResult: document.getElementById('exec-result'),
  execStatus: document.getElementById('exec-status'),
  execOutput: document.getElementById('exec-output'),
  execEmpty: document.getElementById('exec-empty'),
  // history
  historyList: document.getElementById('history-list'),
  historyCount: document.getElementById('history-count'),
  historyClear: document.getElementById('history-clear'),
  historyEmpty: document.getElementById('history-empty'),
};

const state = {
  tab: 'chat',
  host: OLLAMA_HOSTS[0],
  models: [],
  model: '',
  tools: [],
  openTools: new Set(),
  selectedTool: '',
  messages: [{ role: 'system', content: SYSTEM_PROMPT }],
  history: [],
  chatSessions: [],
  currentSessionId: 'session-' + Date.now(),
  chatSubView: 'chat',
  tabId: null,
  tabUrl: '',
  lastNotedTabId: undefined,
  windowId: null,
  busy: false,
  ollamaOk: false,
  autoSuggest: false,
  resetChatOnTabSwitch: false,
  suggesting: false,
  staticSuggestions: [],
  aiSuggestions: [],
  catalogSourceMode: 'none',
  catalogUrl: '',
  catalogToken: '',
  catalogData: null,
  catalogSyncedAt: 0,
  activeSystemContext: '',
  activeRuleNames: [],
  announcedContext: null,
  copilotConnected: false,
  copilotModels: [],
  copilotDeviceCode: null,
  copilotDeviceExpiresAt: 0,
  copilotPollingTimer: null,
};

// --- Generic helpers -------------------------------------------------------

function pretty(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch (_) {
    return String(value);
  }
}

function showStatus(text) {
  els.status.hidden = !text;
  els.status.textContent = text || '';
}

/**
 * Si el proveedor del modelo elegido está listo.
 *
 * `state.ollamaOk` solo dice si Ollama respondió. Usarlo como condición general
 * dejaba la extensión inservible con un modelo de Copilot y Ollama parado: no
 * se podía ni enviar un mensaje, y las sugerencias automáticas no se generaban
 * nunca. Cada modelo responde por su proveedor.
 */
function providerReady() {
  return String(state.model || '').startsWith('copilot:')
    ? state.copilotConnected
    : state.ollamaOk;
}

function updateSendState() {
  els.send.disabled = state.busy || !providerReady() || !state.model || !els.input.value.trim();
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
    part.split(/(`[^`\n]+`)/).forEach((chunk) => {
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

// Shared with the page hook and the tests: see lib/webmcp-schema.js.
const S = globalThis.__WebMCPLocalAgentSchema;
const tokens = S.tokens;
const humanize = S.humanize;

/** Pretty-prints a JSON string result while keeping the raw value elsewhere. */
function maybeParseJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    return value;
  }
}

// --- Tabs ------------------------------------------------------------------

function setTab(name) {
  if (!TABS.includes(name)) name = 'chat';
  state.tab = name;
  for (const button of document.querySelectorAll('.tab')) {
    button.classList.toggle('is-active', button.dataset.tab === name);
  }
  for (const tab of TABS) {
    document.getElementById('tab-' + tab).classList.toggle('is-active', tab === name);
  }
  // The composer belongs to the chat only; keeping it visible elsewhere would
  // suggest the other tabs accept messages.
  els.composer.hidden = name !== 'chat';
  chrome.storage.local.set({ activeTab: name });
  if (name === 'chat') els.input.focus();
}

// --- Ollama models ---------------------------------------------------------

async function fetchLocalModels() {
  els.refreshModels.classList.add('is-spinning');
  els.refreshModels.disabled = true;

  let lastError = null;
  try {
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
  } finally {
    els.refreshModels.classList.remove('is-spinning');
    els.refreshModels.disabled = false;
    updateSendState();
  }
}

async function fetchRemoteCopilotModels() {
  if (!state.copilotConnected) {
    state.copilotModels = [];
    renderModelOptions();
    return;
  }

  try {
    const tokenRes = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'GET_OR_REFRESH_COPILOT_TOKEN', forceRefresh: false }, resolve);
    });

    if (!tokenRes || !tokenRes.success || !tokenRes.token) {
      state.copilotModels = [];
      renderModelOptions();
      showCopilotError((tokenRes && tokenRes.error)
        || 'Could not obtain a Copilot session token. Reconnect GitHub Copilot in Settings.');
      return;
    }

    const Copilot = globalThis.__WebMCPCopilotService;
    if (!Copilot || typeof Copilot.fetchCopilotModels !== 'function') {
      state.copilotModels = [];
      renderModelOptions();
      showCopilotError('CopilotService library not loaded.');
      return;
    }

    // The service appends /models itself; hand it the bare API endpoint or the
    // URL ends up as .../models/models and only the hardcoded fallbacks work.
    const endpointUrl = tokenRes.endpoints && tokenRes.endpoints.api
      ? tokenRes.endpoints.api.replace(/\/+$/, '')
      : undefined;

    const dynamicModels = await Copilot.fetchCopilotModels(tokenRes.token, tokenRes.oauthToken, endpointUrl);
    console.log('[Sidepanel] Dynamic Copilot models updated:', dynamicModels);
    state.copilotModels = Array.isArray(dynamicModels) ? dynamicModels : [];
    if (!state.copilotModels.length) {
      showCopilotError('Connected, but GitHub returned no Copilot models. The Logs tab lists every endpoint tried and its status code.');
    } else if (els.copilotErrorMsg) {
      els.copilotErrorMsg.hidden = true;
    }
  } catch (err) {
    state.copilotModels = [];
    showCopilotError('Failed to fetch Copilot models: ' + String((err && err.message) || err));
  }
  renderModelOptions();
}

function renderModelOptions(placeholder) {
  els.modelSelect.textContent = '';
  const copilotModels = state.copilotModels || [];

  const hasCopilot = state.copilotConnected && copilotModels.length > 0;
  const hasOllama = state.models.length > 0;

  if (!hasOllama && !hasCopilot) {
    els.modelSelect.appendChild(new Option(placeholder || 'No models available', ''));
    els.modelSelect.disabled = true;
    return;
  }

  els.modelSelect.disabled = false;

  if (hasOllama && hasCopilot) {
    const ollamaGroup = document.createElement('optgroup');
    ollamaGroup.label = 'Ollama (Local)';
    for (const model of state.models) {
      const gb = model.size ? ' · ' + (model.size / 1e9).toFixed(1) + ' GB' : '';
      const tools = model.capabilities.includes('tools') ? ' · tools' : '';
      ollamaGroup.appendChild(new Option(model.name + gb + tools, model.name));
    }
    els.modelSelect.appendChild(ollamaGroup);

    const copilotGroup = document.createElement('optgroup');
    copilotGroup.label = 'GitHub Copilot (Remote)';
    for (const model of copilotModels) {
      copilotGroup.appendChild(new Option(model.displayName, model.id));
    }
    els.modelSelect.appendChild(copilotGroup);
  } else if (hasOllama) {
    for (const model of state.models) {
      const gb = model.size ? ' · ' + (model.size / 1e9).toFixed(1) + ' GB' : '';
      const tools = model.capabilities.includes('tools') ? ' · tools' : '';
      els.modelSelect.appendChild(new Option(model.name + gb + tools, model.name));
    }
  } else if (hasCopilot) {
    for (const model of copilotModels) {
      els.modelSelect.appendChild(new Option(model.displayName, model.id));
    }
  }

  if (state.model) {
    const exists = [...els.modelSelect.options].some((opt) => opt.value === state.model);
    if (exists) {
      els.modelSelect.value = state.model;
    } else {
      state.model = els.modelSelect.value;
    }
  } else {
    state.model = els.modelSelect.value;
  }
}

// --- Bridge to the page ----------------------------------------------------

async function currentTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tabId = tab ? tab.id : null;
  state.tabUrl = tab ? tab.url : '';
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

// --- Catalog & Prompt suggestions ----------------------------------------

const C = globalThis.__WebMCPCatalogService;
let suggestAbortController = null;

/** Last few real exchanges, so a post-turn suggestion can follow up on them. */
function recentConversationSummary() {
  const turns = state.messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content);
  if (!turns.length) return '';
  return turns
    .slice(-6)
    .map((m) => (m.role === 'user' ? 'User: ' : 'Assistant: ') + String(m.content).slice(0, 300))
    .join('\n');
}

/**
 * Paints the catalog badge from what is actually loaded.
 *
 * This used to be written inline by syncCatalog() alone, so a panel that had
 * just been reopened — which happens every time you close it — restored the
 * cached catalog and its rules but still read "No Catalog Active · 0 rules
 * loaded". The catalog was working; only the card said otherwise.
 */
function renderCatalogStatus() {
  if (!els.catalogStatusBadge || !els.catalogStatusMeta) return;

  const rules = state.catalogData && Array.isArray(state.catalogData.rules)
    ? state.catalogData.rules
    : [];

  if (state.catalogSourceMode === 'demo') {
    els.catalogStatusBadge.className = 'chip chip--ok';
    els.catalogStatusBadge.textContent = 'Demo Catalog Active';
    els.catalogStatusMeta.textContent = `${rules.length} sample rules loaded`;
    return;
  }

  if (state.catalogSourceMode === 'remote') {
    if (!rules.length) {
      els.catalogStatusBadge.className = 'chip pill--muted';
      els.catalogStatusBadge.textContent = 'Remote Catalog Not Synced';
      els.catalogStatusMeta.textContent = state.catalogUrl
        ? 'Press "Sync Catalog Now" to load it'
        : 'Enter a valid catalog JSON URL';
      return;
    }
    els.catalogStatusBadge.className = 'chip chip--ok';
    els.catalogStatusBadge.textContent = 'Remote Catalog Synced';
    const when = state.catalogSyncedAt
      ? new Date(state.catalogSyncedAt).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
      : null;
    els.catalogStatusMeta.textContent = when
      ? `✔ Synced ${when} · ${rules.length} rules`
      : `${rules.length} rules loaded`;
    return;
  }

  els.catalogStatusBadge.className = 'chip pill--muted';
  els.catalogStatusBadge.textContent = 'No Catalog Active';
  els.catalogStatusMeta.textContent = '0 rules loaded';
}

function renderCatalogRulesInspector() {
  if (!els.catalogRulesList) return;
  els.catalogRulesList.textContent = '';

  const catalog = state.catalogData || (C ? C.EMPTY_CATALOG : null);
  const rules = catalog && Array.isArray(catalog.rules) ? catalog.rules : [];

  if (els.catalogRulesCount) {
    els.catalogRulesCount.textContent = rules.length === 1 ? '1 rule' : rules.length + ' rules';
  }

  if (!rules.length) {
    const empty = document.createElement('div');
    empty.className = 'pane__empty';
    empty.textContent = 'No rules loaded in catalog.';
    els.catalogRulesList.appendChild(empty);
    return;
  }

  for (const rule of rules) {
    const card = document.createElement('div');
    card.className = 'rule-card';

    const title = document.createElement('div');
    title.className = 'rule-card__title';
    title.textContent = `${rule.name || 'Untitled rule'} (${rule.id || 'no-id'})`;

    const match = document.createElement('div');
    match.className = 'rule-card__match';
    const urlPat = rule.match && rule.match.urlPattern ? `URL: ${rule.match.urlPattern}` : '';
    const reqTools = rule.match && Array.isArray(rule.match.requiredTools) && rule.match.requiredTools.length
      ? `Tools: ${rule.match.requiredTools.join(', ')}`
      : '';
    match.textContent = [urlPat, reqTools].filter(Boolean).join(' | ') || 'No filter criteria';

    const ctx = document.createElement('div');
    ctx.className = 'rule-card__ctx';
    ctx.textContent = rule.systemContext || 'No business rules (systemContext)';

    card.append(title, match, ctx);
    els.catalogRulesList.appendChild(card);
  }
}

async function syncCatalog() {
  if (!C) return;

  let mode = 'none';
  if (els.catalogSourceDemo && els.catalogSourceDemo.checked) mode = 'demo';
  else if (els.catalogSourceRemote && els.catalogSourceRemote.checked) mode = 'remote';
  state.catalogSourceMode = mode;

  if (mode === 'none') {
    state.catalogData = C.EMPTY_CATALOG;
    renderCatalogStatus();
    renderCatalogRulesInspector();
    await chrome.storage.local.set({
      catalogSourceMode: 'none',
      webmcp_catalog_cache: state.catalogData,
    });
    detectPageTools();
    return;
  }

  if (mode === 'demo') {
    state.catalogData = C.DEMO_SAMPLE_CATALOG;
    renderCatalogStatus();
    renderCatalogRulesInspector();
    await chrome.storage.local.set({
      catalogSourceMode: 'demo',
      webmcp_catalog_cache: state.catalogData,
    });
    detectPageTools();
    return;
  }

  // Remote catalog sync
  const url = els.catalogUrl ? els.catalogUrl.value.trim() : '';
  const token = els.catalogToken ? els.catalogToken.value.trim() : '';
  state.catalogUrl = url;
  state.catalogToken = token;

  if (!url) {
    if (els.catalogStatusBadge) {
      els.catalogStatusBadge.className = 'chip chip--err';
      els.catalogStatusBadge.textContent = 'URL Required';
    }
    if (els.catalogStatusMeta) els.catalogStatusMeta.textContent = 'Enter a valid catalog JSON URL';
    return;
  }

  if (els.catalogSyncBtn) {
    els.catalogSyncBtn.disabled = true;
    els.catalogSyncBtn.textContent = 'Syncing…';
  }

  try {
    const res = await C.fetchCatalog(url, token);
    if (!res.ok) {
      if (els.catalogStatusBadge) {
        els.catalogStatusBadge.className = 'chip chip--err';
        els.catalogStatusBadge.textContent = 'Sync Error';
      }
      if (els.catalogStatusMeta) els.catalogStatusMeta.textContent = res.error;
      return;
    }

    state.catalogData = res.data;
    state.catalogSyncedAt = Date.now();
    renderCatalogStatus();

    renderCatalogRulesInspector();
    await chrome.storage.local.set({
      catalogSourceMode: 'remote',
      catalogUrl: url,
      catalogToken: token,
      catalogSyncedAt: state.catalogSyncedAt,
      webmcp_catalog_cache: state.catalogData,
    });
    detectPageTools();
  } finally {
    if (els.catalogSyncBtn) {
      els.catalogSyncBtn.disabled = false;
      els.catalogSyncBtn.textContent = '🔄 Sync Catalog Now';
    }
  }
}

function clearSuggestions() {
  if (suggestAbortController) {
    suggestAbortController.abort();
    suggestAbortController = null;
  }
  state.suggesting = false;
  state.aiSuggestions = [];
  state.staticSuggestions = [];
  if (els.suggestions) els.suggestions.hidden = true;
  if (els.suggestionsLoading) els.suggestionsLoading.hidden = true;
  if (els.suggestionsChips) els.suggestionsChips.textContent = '';
}

function renderSuggestions() {
  if (!els.suggestionsChips) return;
  els.suggestionsChips.textContent = '';

  // If NO tools are present on active tab -> STRICTLY HIDE EVERYTHING
  if (!state.tools || state.tools.length === 0) {
    if (els.suggestions) els.suggestions.hidden = true;
    if (els.suggestionsLoading) els.suggestionsLoading.hidden = true;
    return;
  }

  const hasStatic = state.staticSuggestions && state.staticSuggestions.length > 0;
  const hasAI = state.aiSuggestions && state.aiSuggestions.length > 0;

  if (!hasStatic && !hasAI && !state.suggesting) {
    if (els.suggestions) els.suggestions.hidden = true;
    if (els.suggestionsLoading) els.suggestionsLoading.hidden = true;
    return;
  }

  if (els.suggestions) els.suggestions.hidden = false;
  if (els.suggestionsLoading) els.suggestionsLoading.hidden = !state.suggesting;

  // Static prompts from Catalog (blue chip)
  if (hasStatic) {
    for (const text of state.staticSuggestions) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip-suggestion chip-suggestion--static';
      chip.textContent = '📌 ' + text;
      chip.addEventListener('click', () => {
        els.input.value = text;
        autoGrow();
        updateSendState();
        sendMessage();
      });
      els.suggestionsChips.appendChild(chip);
    }
  }

  // AI Generated Prompts (purple chip)
  if (hasAI) {
    for (const text of state.aiSuggestions) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip-suggestion chip-suggestion--ai';
      chip.textContent = '✨ ' + text;
      chip.addEventListener('click', () => {
        els.input.value = text;
        autoGrow();
        updateSendState();
        sendMessage();
      });
      els.suggestionsChips.appendChild(chip);
    }
  }
}

async function generatePromptSuggestions() {
  if (!state.autoSuggest || !providerReady() || !state.model || !state.tools || !state.tools.length || state.busy) {
    state.suggesting = false;
    state.aiSuggestions = [];
    renderSuggestions();
    return;
  }

  if (suggestAbortController) {
    suggestAbortController.abort();
  }
  suggestAbortController = new AbortController();
  let suggestTimedOut = false;
  const timeoutId = setTimeout(() => {
    suggestTimedOut = true;
    if (suggestAbortController) suggestAbortController.abort();
  }, SUGGESTION_TIMEOUT_MS);
  const signal = suggestAbortController.signal;

  state.suggesting = true;
  state.aiSuggestions = [];
  renderSuggestions();

  const toolNames = state.tools.map((t) => t.name);
  const toolSummary = state.tools.map((t) => `- ${t.name}: ${t.description || 'No description'}`).join('\n');
  const conversationSummary = recentConversationSummary();

  let prompt = `Available page tools:\n${toolSummary}\n`;
  if (state.activeSystemContext) {
    prompt += `\nBusiness rules and context:\n${state.activeSystemContext}\n`;
  }
  if (conversationSummary) {
    prompt += `\nRecent conversation:\n${conversationSummary}\n`;
    prompt += `\nGiven how the conversation just went, suggest between 1 and 3 short follow-up messages the user could send next. If the assistant just asked the user for information, suggest a plausible, concrete answer to that question instead of repeating it.`;
  } else {
    prompt += `\nSuggest between 1 and 3 short, concrete messages the user could send to start using these tools. Prefer specific example values (names, ids, places, numbers) over a generic restatement of what a tool does.`;
  }
  prompt += ` These suggestions become clickable chips that get sent verbatim as the user's own next chat message, so every suggestion MUST be phrased in the user's voice, as something THEY would say to the assistant (e.g. "Create a contact for Ada Lovelace in Spain, DNI 12345678Z, postal code 28001") — NEVER as the assistant asking the user a question (e.g. never "Please provide..." or "Do you want to..."). Output MUST be ONLY a JSON array of strings, e.g. ["Suggestion 1", "Suggestion 2"]. Do NOT include any markdown code blocks, explanation, or extra text.`;

  const started = performance.now();
  const args = {
    tools: toolNames,
    model: state.model,
    usedConversation: Boolean(conversationSummary),
    usedCatalog: Boolean(state.activeSystemContext),
    prompt,
  };
  const logResult = (ok, output) => {
    recordExecution({ tool: 'suggestions', origin: 'suggestion', args, ok, output, ms: performance.now() - started });
  };

  try {
    let content = '';
    if (state.model.startsWith('copilot:')) {
      const copilotReply = await copilotChat([{ role: 'user', content: prompt }], undefined, () => {});
      content = (copilotReply && copilotReply.content) || '';
    } else {
      const response = await fetch(state.host + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: state.model,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
        }),
        signal,
      });

      if (!response.ok) {
        state.suggesting = false;
        state.aiSuggestions = [];
        renderSuggestions();
        logResult(false, 'Model provider responded ' + response.status + ' while generating suggestions.');
        return;
      }

      const data = await response.json();
      content = (data.message && data.message.content) || '';
    }

    if (signal.aborted) {
      // copilotChat() above isn't wired to `signal`, so a timeout during a Copilot
      // request doesn't cancel it — it just lands here once it finally resolves.
      if (suggestTimedOut) {
        logResult(false, `Timed out after ${SUGGESTION_TIMEOUT_MS / 1000}s waiting for the model to generate suggestions.`);
      }
      return;
    }

    content = content.trim();
    if (content.startsWith('```')) {
      content = content.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    }

    let parsed = [];
    try {
      parsed = JSON.parse(content);
    } catch (_) {
      const matches = content.match(/"([^"]+)"/g);
      if (matches) {
        parsed = matches.map((m) => m.replace(/^"|"$/g, '').trim());
      }
    }

    if (!Array.isArray(parsed) || !parsed.length) {
      state.suggesting = false;
      state.aiSuggestions = [];
      renderSuggestions();
      logResult(false, 'Model returned no usable suggestions. Raw reply: ' + content.slice(0, 300));
      return;
    }

    const validSuggestions = parsed
      .filter((item) => typeof item === 'string' && item.trim())
      .map((item) => item.trim())
      .slice(0, 3);

    state.aiSuggestions = validSuggestions;
    renderSuggestions();
    logResult(true, validSuggestions.join(' | '));
  } catch (err) {
    if (err && err.name === 'AbortError') {
      // Only a real timeout is worth logging: a newer suggestion request aborting
      // this one (suggestAbortController.abort() above) is expected and silent.
      if (suggestTimedOut) {
        logResult(false, `Timed out after ${SUGGESTION_TIMEOUT_MS / 1000}s waiting for the model to generate suggestions.`);
      }
      return;
    }
    state.aiSuggestions = [];
    renderSuggestions();
    logResult(false, String((err && err.message) || err));
  } finally {
    clearTimeout(timeoutId);
    state.suggesting = false;
    if (els.suggestionsLoading) els.suggestionsLoading.hidden = true;
  }
}

/**
 * By default the chat conversation survives a tab switch (losing it would be
 * worse: a lot of real workflows read page A then act on page B) — but the
 * tools available silently change underneath it, so a mid-conversation
 * switch gets a visible note — both in the transcript and in what the model
 * sees — instead of the model quietly acting on a different page's tools
 * than the ones the user was just talking about. Users who would rather
 * start fresh on every tab switch can flip that in Settings.
 */
function announceTabChangeIfNeeded() {
  const changed = state.lastNotedTabId !== undefined && state.lastNotedTabId !== state.tabId;
  state.lastNotedTabId = state.tabId;
  if (!changed || state.messages.length <= 1) return;

  if (state.resetChatOnTabSwitch) {
    resetConversation();
  } else {
    const label = state.tabUrl || 'this tab';
    const text = state.tools.length
      ? `Switched to a different tab (${label}). ${state.tools.length} tool(s) now available here.`
      : `Switched to a different tab (${label}). This page exposes no WebMCP tools.`;
    addMessage('note', text);
    state.messages.push({ role: 'system', content: text });
  }

  // Either way the conversation just changed shape (reset, or a new note in
  // it) and the tab's tools are new: any suggestion chip still on screen was
  // computed for the previous tab/conversation and must not linger while a
  // fresh one is generated.
  state.aiSuggestions = [];
}

async function detectPageTools() {
  els.refreshTools.classList.add('is-spinning');
  try {
    await currentTabId();
    const answer = state.tabId == null ? null : await bridge('list', null);
    const failed = !answer || answer.error;
    state.tools = failed ? [] : S.toolsFromListing(answer.result);

    const problems = failed ? [] : S.listingErrors(answer.result);
    if (problems.length) showStatus('Reading the page tools failed: ' + problems.join(' | '));

    renderToolsBadge(state.tabId == null ? 'no tab' : null);
    renderToolsList();
    renderPicker();
    announceTabChangeIfNeeded();

    // If NO tools detected on active page -> clear and hide suggestions completely!
    if (!state.tools || state.tools.length === 0) {
      state.activeSystemContext = '';
      state.activeRuleNames = [];
      state.staticSuggestions = [];
      state.aiSuggestions = [];
      syncSystemMessage();
      renderCatalogActive();
      clearSuggestions();
      return;
    }

    // Resolve context using the active tab's URL and its WebMCP tools
    const tabUrl = state.tabUrl;

    if (C) {
      // Sin apaños: lo que esté cargado, y si no hay nada, nada. El catálogo de
      // demostración se activa desde Ajustes, no por que la URL diga "webmcp".
      const resolved = C.resolveContext(tabUrl, state.tools, state.catalogData);
      state.activeSystemContext = resolved.systemContext;
      state.activeRuleNames = (resolved.matchedRules || []).map((r) => r.name || r.id || 'rule');
      state.staticSuggestions = resolved.suggestedPrompts;
    } else {
      state.activeSystemContext = '';
      state.activeRuleNames = [];
      state.staticSuggestions = [];
    }

    syncSystemMessage();
    renderCatalogActive();
    renderSuggestions();

    if (state.autoSuggest && providerReady() && state.model && !state.busy) {
      generatePromptSuggestions();
    } else {
      state.aiSuggestions = [];
      renderSuggestions();
    }
  } finally {
    els.refreshTools.classList.remove('is-spinning');
  }
}

/**
 * Inspects now and once more shortly after.
 *
 * Declarative tools are synthesized from the markup by the browser, and a tab
 * that has just come to the front may not have them ready the instant it does.
 * The second pass costs nothing and is the difference between seeing them and
 * having to press F5.
 */
let recheckTimer = null;
function detectPageToolsTwice() {
  detectPageTools();
  clearTimeout(recheckTimer);
  recheckTimer = setTimeout(detectPageTools, 700);
}

function renderToolsBadge(text) {
  const count = state.tools.length;
  els.toolsBadgeText.textContent = text || (count === 1 ? '1 tool' : count + ' tools');
  els.toolsBadge.classList.toggle('has-tools', count > 0);
}

// --- Schema reading --------------------------------------------------------

/**
 * The hook already normalises schemas, but the panel re-runs it: a descriptor
 * that still carries a JSON string must never degrade into "No input needed".
 */
function schemaOf(tool) {
  return S.safeNormalizeInputSchema(tool.inputSchema !== undefined ? tool.inputSchema : tool.parameters).schema;
}

function schemaErrorOf(tool) {
  if (tool.schemaError) return tool.schemaError;
  return S.safeNormalizeInputSchema(tool.inputSchema !== undefined ? tool.inputSchema : tool.parameters).error;
}

const propertyNames = S.propertyNames;
const requiredNames = S.requiredNames;
const describeNeeds = S.describeNeeds;

function propertyDef(schema, key) {
  return (schema.properties && schema.properties[key]) || {};
}

function toolByName(name) {
  return state.tools.find((tool) => tool.name === name) || null;
}

/** Executions always carry the origin so the hook can match the right tool. */
function executeOnPage(name, args) {
  const tool = toolByName(name);
  return bridge('execute', { name, args, origin: tool ? tool.origin : null });
}

// Name-based icon inference lives in lib/webmcp-schema.js, with its tests.
const iconForTool = S.iconForTool;

// --- Tools tab -------------------------------------------------------------

function makeSection(labelText) {
  const section = document.createElement('div');
  section.className = 'tool-card__section';
  const label = document.createElement('div');
  label.className = 'field-label';
  label.textContent = labelText;
  section.appendChild(label);
  return section;
}

function createToolListItem(tool) {
  const schema = schemaOf(tool);
  const props = propertyNames(schema);
  const required = requiredNames(schema);

  const card = document.createElement('div');
  card.className = 'tool-card';
  if (state.openTools.has(tool.name)) card.classList.add('is-open');

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
  title.textContent = humanize(tool.name);
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
  const schemaError = schemaErrorOf(tool);
  if (schemaError) {
    // A broken schema is not the same as a tool without parameters, and saying
    // "No input needed" here is what let the model invent its own arguments.
    needsText.className = 'tool-card__text schema-error';
    needsText.textContent = 'Could not read this tool’s input schema: ' + schemaError;
  } else {
    needsText.className = 'tool-card__text';
    needsText.textContent = describeNeeds(props, required);
  }
  needs.appendChild(needsText);

  inner.append(does, needs);

  if (props.length) {
    const params = makeSection('Parameters');
    const pills = document.createElement('div');
    pills.className = 'pills';
    for (const key of props) {
      const def = propertyDef(schema, key);
      const pill = document.createElement('span');
      pill.className = 'pill' + (required.includes(key) ? ' pill--required' : '');
      pill.textContent = key + (def.type ? ':' + def.type : '');
      if (def.description) pill.title = def.description;
      pills.appendChild(pill);
    }
    params.appendChild(pills);
    inner.appendChild(params);

    // Properties without declared choices keep the pill row above and nothing
    // else; only the constrained ones get a line here.
    const constrained = props
      .map((key) => ({ key, choices: S.getDisplayChoices(propertyDef(schema, key)) }))
      .filter((entry) => entry.choices.length);

    if (constrained.length) {
      const options = makeSection('Options');
      for (const entry of constrained) {
        const row = document.createElement('div');
        row.className = 'choice-row';

        const name = document.createElement('div');
        name.className = 'choice-row__name';
        name.textContent = entry.key;

        const values = document.createElement('div');
        values.className = 'pills';
        for (const choice of entry.choices) {
          const chip = document.createElement('span');
          chip.className = 'pill pill--choice';
          chip.textContent = S.formatChoice(choice);
          // The constant is what gets sent, so keep it reachable even when a
          // human-readable title is on show.
          chip.title = String(choice.value);
          values.appendChild(chip);
        }

        row.append(name, values);
        options.appendChild(row);
      }
      inner.appendChild(options);
    }
  }

  const foot = document.createElement('div');
  foot.className = 'tool-card__foot';
  const via = document.createElement('span');
  via.textContent = 'Registered via';
  const source = document.createElement('span');
  const registration = tool.registration || 'unknown';
  source.className = 'pill' + (registration === 'unknown' ? ' pill--muted' : '');
  source.textContent = S.registrationLabel(registration);
  source.title = S.registrationTitle(registration, tool.source);
  const run = document.createElement('button');
  run.type = 'button';
  run.className = 'tool-card__run';
  run.textContent = 'Run ▶';
  foot.append(via, source, run);

  card.append(head, details, foot);

  head.addEventListener('click', () => {
    const open = card.classList.toggle('is-open');
    head.setAttribute('aria-expanded', String(open));
    if (open) state.openTools.add(tool.name);
    else state.openTools.delete(tool.name);
  });

  // One execution UI only: Run hands over to the Execute tab.
  run.addEventListener('click', () => {
    selectTool(tool.name);
    setTab('execute');
  });

  return card;
}

function renderToolsList() {
  els.toolsList.textContent = '';
  els.toolsEmpty.hidden = state.tools.length > 0;
  for (const tool of state.tools) {
    els.toolsList.appendChild(createToolListItem(tool));
  }
}

// --- Execute tab -----------------------------------------------------------

function pad(value) {
  return String(value).padStart(2, '0');
}

function todayISO() {
  const now = new Date();
  return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
}

function nowHHMM() {
  const now = new Date();
  return pad(now.getHours()) + ':' + pad(now.getMinutes());
}

/**
 * Which control a property deserves. Name matching uses whole tokens on purpose:
 * a substring test would turn `update` into a date field.
 */
function controlFor(key, def) {
  const format = String(def.format || '').toLowerCase();
  const words = tokens(key);
  const has = (word) => words.includes(word);

  if (S.getDisplayChoices(def).length) return 'select';
  if (def.type === 'boolean') return 'checkbox';
  if (def.type === 'number' || def.type === 'integer') return 'number';
  if (def.type === 'array' || def.type === 'object') return 'json';
  if (format === 'date-time' || (has('datetime') || (has('date') && has('time')))) return 'datetime-local';
  if (format === 'date' || has('date') || has('day') || has('birthday')) return 'date';
  if (format === 'time' || has('time') || has('hour')) return 'time';
  if (format === 'email' || has('email') || has('mail')) return 'email';
  if (format === 'uri' || format === 'url' || has('url') || has('link') || has('href')) return 'url';
  if (def.maxLength && def.maxLength > 120) return 'textarea';
  return 'text';
}

/** Prefills the form with something plausible so Execute is one click away. */
function smartDefault(key, def, control) {
  if (def.default !== undefined) return def.default;
  if (control === 'select') {
    const choices = S.getDisplayChoices(def);
    return choices.length ? choices[0].value : '';
  }
  if (control === 'checkbox') return false;
  if (control === 'number') {
    if (typeof def.minimum === 'number') return def.minimum;
    return 1;
  }
  if (control === 'json') return def.type === 'array' ? [] : {};
  if (control === 'date') return todayISO();
  if (control === 'datetime-local') return todayISO() + 'T' + nowHHMM();
  if (control === 'time') return nowHHMM();
  if (control === 'email') return 'user@example.com';
  if (control === 'url') return 'https://example.com';

  const words = tokens(key);
  if (words.includes('phone') || words.includes('tel')) return '+1 555 0100';
  if (words.includes('name')) return 'Ada Lovelace';
  if (typeof def.example === 'string') return def.example;
  return '';
}

/** Field controllers for the currently selected tool. */
let execFields = [];
let syncingJson = false;

function selectedTool() {
  return state.tools.find((tool) => tool.name === state.selectedTool) || null;
}

function renderPicker() {
  els.execPicker.textContent = '';
  const hasTools = state.tools.length > 0;
  els.execEmpty.hidden = hasTools;
  els.execPicker.hidden = !hasTools;

  if (!hasTools) {
    els.execBody.hidden = true;
    return;
  }

  if (!state.tools.some((tool) => tool.name === state.selectedTool)) {
    state.selectedTool = state.tools[0].name;
  }

  for (const tool of state.tools) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'picker__item' + (tool.name === state.selectedTool ? ' is-selected' : '');
    item.textContent = tool.name;
    item.addEventListener('click', () => selectTool(tool.name));
    els.execPicker.appendChild(item);
  }

  renderExecForm();
}

function selectTool(name) {
  state.selectedTool = name;
  for (const item of els.execPicker.querySelectorAll('.picker__item')) {
    item.classList.toggle('is-selected', item.textContent === name);
  }
  renderExecForm();
}

function renderExecForm() {
  const tool = selectedTool();
  els.execBody.hidden = !tool;
  els.execResult.hidden = true;
  execFields = [];
  els.execForm.textContent = '';
  if (!tool) return;

  els.execIcon.textContent = iconForTool(tool);
  els.execName.textContent = humanize(tool.name);
  els.execDesc.textContent = tool.description || 'No description provided.';

  const schema = schemaOf(tool);
  const props = propertyNames(schema);
  const required = requiredNames(schema);

  const schemaError = schemaErrorOf(tool);
  if (schemaError) {
    const note = document.createElement('div');
    note.className = 'schema-error';
    note.textContent = 'Could not read this tool’s input schema: ' + schemaError
      + ' Arguments below are whatever you type; the page may reject them.';
    els.execForm.appendChild(note);
  } else if (!props.length) {
    const note = document.createElement('div');
    note.className = 'pane__empty';
    note.textContent = 'This tool takes no parameters.';
    els.execForm.appendChild(note);
  }

  for (const key of props) {
    const def = propertyDef(schema, key);
    const control = controlFor(key, def);
    const field = document.createElement('div');
    field.className = 'tool-form__field';

    const label = document.createElement('label');
    label.textContent = key + (required.includes(key) ? ' *' : '');
    field.appendChild(label);

    let input;
    if (control === 'select') {
      input = document.createElement('select');
      if (!required.includes(key)) input.appendChild(new Option('', ''));
      // Label for the human, constant for the payload.
      for (const choice of S.getDisplayChoices(def)) {
        input.appendChild(new Option(S.formatChoice(choice), String(choice.value)));
      }
    } else if (control === 'checkbox') {
      input = document.createElement('input');
      input.type = 'checkbox';
    } else if (control === 'json' || control === 'textarea') {
      input = document.createElement('textarea');
      input.rows = 2;
    } else {
      input = document.createElement('input');
      input.type = control === 'number' ? 'number' : control;
      if (def.type === 'integer') input.step = '1';
    }

    const initial = smartDefault(key, def, control);
    if (control === 'checkbox') input.checked = Boolean(initial);
    else if (control === 'json') input.value = JSON.stringify(initial);
    else input.value = initial === undefined || initial === null ? '' : String(initial);

    field.appendChild(input);

    if (def.description) {
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = def.description;
      field.appendChild(hint);
    }

    els.execForm.appendChild(field);

    execFields.push({
      key,
      def,
      control,
      required: required.includes(key),
      read() {
        if (control === 'checkbox') return input.checked;
        const raw = input.value;
        if (raw === '' && !this.required) return undefined;
        if (control === 'number') {
          const num = Number(raw);
          return Number.isNaN(num) ? raw : num;
        }
        if (control === 'json') {
          try {
            return JSON.parse(raw);
          } catch (_) {
            return raw;
          }
        }
        return raw;
      },
      write(value) {
        if (value === undefined) return;
        if (control === 'checkbox') input.checked = Boolean(value);
        else if (control === 'json') input.value = JSON.stringify(value);
        else input.value = String(value);
      },
    });

    input.addEventListener('input', syncJsonFromForm);
    input.addEventListener('change', syncJsonFromForm);
  }

  syncJsonFromForm();
}

function readForm() {
  const args = {};
  for (const field of execFields) {
    const value = field.read();
    if (value !== undefined) args[field.key] = value;
  }
  return args;
}

function markJson(valid) {
  els.execJson.classList.toggle('is-invalid', !valid);
  els.execJsonState.classList.toggle('is-invalid', !valid);
  els.execJsonState.textContent = valid ? 'valid' : 'invalid JSON';
  els.execRun.disabled = !valid;
}

function syncJsonFromForm() {
  if (syncingJson) return;
  syncingJson = true;
  els.execJson.value = JSON.stringify(readForm(), null, 2);
  markJson(true);
  syncingJson = false;
}

function syncFormFromJson() {
  if (syncingJson) return;
  syncingJson = true;
  try {
    const parsed = JSON.parse(els.execJson.value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const field of execFields) field.write(parsed[field.key]);
      markJson(true);
    } else {
      markJson(false);
    }
  } catch (_) {
    markJson(false);
  }
  syncingJson = false;
}

/** The JSON editor wins when it parses: it is the thing the user last edited. */
function execArguments() {
  try {
    const parsed = JSON.parse(els.execJson.value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (_) { /* fall through */ }
  return readForm();
}

async function executeSelectedTool() {
  const tool = selectedTool();
  if (!tool) return;

  const args = execArguments();
  els.execRun.disabled = true;
  els.execRun.textContent = 'Running…';
  els.execResult.hidden = false;
  els.execStatus.className = 'chip';
  els.execStatus.textContent = '…';
  els.execOutput.textContent = 'Running…';

  const started = performance.now();
  const answer = await executeOnPage(tool.name, args);
  const ms = performance.now() - started;
  const seconds = (ms / 1000).toFixed(2) + 's';

  const ok = !(!answer || answer.error);
  const output = ok
    ? resultToText(answer.result)
    : (answer && answer.error) || 'Unknown error.';

  els.execStatus.className = 'chip ' + (ok ? 'chip--ok' : 'chip--err');
  els.execStatus.textContent = (ok ? '✔ Success · ' : '✖ Error · ') + seconds;
  els.execOutput.textContent = ok ? pretty(maybeParseJson(answer.result)) : output;

  els.execRun.disabled = false;
  els.execRun.textContent = '▶ Execute Tool';

  recordExecution({ tool: tool.name, origin: 'manual', args, ok, output, ms });
}

// --- History tab -----------------------------------------------------------

async function loadHistory() {
  const stored = await chrome.storage.local.get('history');
  state.history = Array.isArray(stored.history) ? stored.history : [];
  renderHistory();
}

function recordExecution(entry) {
  state.history.unshift(Object.assign({ ts: Date.now() }, entry));
  if (state.history.length > HISTORY_LIMIT) state.history.length = HISTORY_LIMIT;
  chrome.storage.local.set({ history: state.history });
  renderHistory();
}

function renderHistory() {
  els.historyList.textContent = '';
  els.historyEmpty.hidden = state.history.length > 0;
  els.historyCount.textContent = state.history.length
    ? state.history.length + (state.history.length === 1 ? ' execution' : ' executions')
    : '';

  for (const entry of state.history) {
    const item = document.createElement('div');
    item.className = 'hist ' + (entry.ok ? 'hist--ok' : 'hist--err');

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'hist__head';

    const icon = document.createElement('span');
    icon.textContent = entry.ok ? '✔' : '✖';
    const name = document.createElement('span');
    name.className = 'hist__name';
    name.textContent = entry.tool;
    const origin = document.createElement('span');
    origin.className = 'hist__origin';
    origin.textContent = entry.origin === 'manual' ? 'manual' : entry.origin === 'suggestion' ? 'suggestion' : 'chat';
    const meta = document.createElement('span');
    meta.className = 'hist__meta';
    const when = new Date(entry.ts);
    meta.textContent = pad(when.getHours()) + ':' + pad(when.getMinutes()) + ':' + pad(when.getSeconds())
      + (typeof entry.ms === 'number' ? ' · ' + (entry.ms / 1000).toFixed(2) + 's' : '');
    head.append(icon, name, origin, meta);

    const body = document.createElement('div');
    body.className = 'hist__body';

    const argsLabel = document.createElement('div');
    argsLabel.className = 'field-label';
    argsLabel.textContent = 'Arguments';
    const argsPre = document.createElement('pre');
    argsPre.className = 'json-view';
    argsPre.textContent = pretty(entry.args || {});

    const outLabel = document.createElement('div');
    outLabel.className = 'field-label';
    outLabel.textContent = entry.ok ? 'Output' : 'Error';
    const outPre = document.createElement('pre');
    outPre.className = 'json-view';
    outPre.textContent = String(entry.output);

    body.append(argsLabel, argsPre, outLabel, outPre);
    item.append(head, body);
    head.addEventListener('click', () => item.classList.toggle('is-open'));
    els.historyList.appendChild(item);
  }
}

// --- Chat ------------------------------------------------------------------

function scrollToBottom() {
  els.chat.scrollTop = els.chat.scrollHeight;
}

function clearEmptyState() {
  const empty = els.chat.querySelector('.empty');
  if (empty) empty.remove();
}

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

/**
 * Mete las reglas del catálogo en el mensaje de sistema de la conversación.
 *
 * Hasta 0.6.22 `activeSystemContext` solo se usaba para redactar las
 * sugerencias: cargar un catálogo en Ajustes no cambiaba ni una palabra de lo
 * que se le enviaba al modelo, y en el chat no se veía nada. Se reconstruye el
 * mensaje 0 en cada turno porque las reglas dependen de la pestaña activa y
 * esta cambia a mitad de conversación.
 */
function systemMessageContent() {
  if (!state.activeSystemContext) return SYSTEM_PROMPT;
  return SYSTEM_PROMPT
    + '\n\nBUSINESS RULES FOR THIS PAGE (from the active knowledge catalog). '
    + 'They are authoritative: follow them when choosing tools and filling arguments.\n'
    + state.activeSystemContext;
}

function syncSystemMessage() {
  const content = systemMessageContent();
  if (state.messages.length && state.messages[0].role === 'system') {
    state.messages[0].content = content;
  } else {
    state.messages.unshift({ role: 'system', content });
  }
}

/** El chip sobre el compositor y el aviso en el hilo, cuando las reglas cambian. */
function renderCatalogActive() {
  const names = state.activeRuleNames || [];
  if (els.catalogActive) {
    els.catalogActive.hidden = !names.length;
    if (els.catalogActiveText && names.length) {
      els.catalogActiveText.textContent = names.length === 1
        ? 'Catalog rule active: ' + names[0]
        : names.length + ' catalog rules active: ' + names.join(', ');
    }
  }

  // Anunciarlo una vez por cambio: repetirlo en cada re-inspección llenaría el
  // hilo de avisos idénticos.
  const signature = state.activeSystemContext;
  if (signature === state.announcedContext) return;
  state.announcedContext = signature;
  if (!signature || state.tab !== 'chat') return;
  addMessage('note', 'Catalog rules for this page are now part of every message:\n'
    + state.activeSystemContext);
}

/** Shared by the 🗑 button and the "reset on tab switch" setting. */
function resetConversation() {
  state.messages = [{ role: 'system', content: systemMessageContent() }];
  els.chat.textContent = '';
  const empty = document.createElement('div');
  empty.className = 'empty';
  const title = document.createElement('h1');
  title.textContent = 'Conversation cleared';
  const hint = document.createElement('p');
  hint.textContent = 'Type a message to start over.';
  empty.append(title, hint);
  els.chat.appendChild(empty);
}

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

// Properties, required, enum, anyOf and const reach the model exactly as the
// page declared them; see lib/webmcp-schema.js and its regression tests.
const toOllamaTool = S.toOllamaTool;

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

async function ollamaChat(messages, tools, onDelta) {
  const body = { model: state.model, messages, stream: true };
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
  const accumulated = { content: '', thinking: '', tool_calls: [] };
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
    if (Array.isArray(message.tool_calls)) accumulated.tool_calls.push(...message.tool_calls);
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
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    let trimmed = raw.trim();
    if (trimmed.startsWith('```')) {
      trimmed = trimmed.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') {
        try {
          const second = JSON.parse(parsed.trim());
          if (second && typeof second === 'object' && !Array.isArray(second)) return second;
        } catch (_) { /* ignore */ }
      }
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
      try {
        const fixed = trimmed.replace(/'/g, '"');
        const parsed = JSON.parse(fixed);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch (_) {
        return {};
      }
    }
  }
  return {};
}

async function runToolCall(call) {
  const fn = call.function || {};
  const name = fn.name;
  const args = parseArguments(fn.arguments);
  const card = createToolCard(name || '(unnamed)', args);

  // tool_call_id is what OpenAI-shaped providers (Copilot) pair the result
  // with; Ollama pairs on tool_name and ignores the extra field. Every exit
  // below goes through this, so no path can forget the id.
  const toolMessage = (text) => ({
    role: 'tool',
    tool_name: String(name || 'unknown'),
    ...(call && call.id ? { tool_call_id: call.id } : {}),
    content: text,
  });

  const finish = (ok, output) => {
    recordExecution({ tool: String(name || 'unknown'), origin: 'chat', args, ok, output });
    return toolMessage(ok ? output : 'Error: ' + output);
  };

  const isBuiltinWait = name === 'wait';
  if (!name || (!isBuiltinWait && !state.tools.some((tool) => tool.name === name))) {
    const text = 'The page exposes no tool named "' + String(name) + '".';
    card.fail(text);
    return finish(false, text);
  }

  if (els.confirmTools.checked) {
    const approved = await card.confirm();
    if (!approved) {
      const text = 'The user cancelled this tool call.';
      card.cancelled(text);
      recordExecution({ tool: name || 'wait', origin: 'chat', args, ok: false, output: text });
      return toolMessage(text);
    }
  }

  if (isBuiltinWait) {
    const sec = Math.min(Math.max(Number(args && args.seconds) || 5, 1), 30);
    const started = performance.now();
    await new Promise((resolve) => setTimeout(resolve, sec * 1000));
    await detectPageTools();
    const ms = performance.now() - started;
    const text = `Waited ${sec} second(s) for page updates. Current page exposes ${state.tools.length} tool(s).`;
    card.done(text);
    recordExecution({ tool: 'wait', origin: 'chat', args, ok: true, output: text, ms });
    return toolMessage(text);
  }

  const started = performance.now();
  const answer = await executeOnPage(name, args);
  const ms = performance.now() - started;

  if (!answer || answer.error) {
    const text = (answer && answer.error) || 'Unknown error while running the tool.';
    card.fail(text);
    recordExecution({ tool: name, origin: 'chat', args, ok: false, output: text, ms });
    return toolMessage('Error: ' + text);
  }

  const text = resultToText(answer.result);
  card.done(text);
  recordExecution({ tool: name, origin: 'chat', args, ok: true, output: text, ms });
  return toolMessage(text);
}

async function copilotChat(messages, tools, onChunk) {
  const tokenRes = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_OR_REFRESH_COPILOT_TOKEN', forceRefresh: false }, resolve);
  });

  if (!tokenRes || !tokenRes.success || !tokenRes.token) {
    throw new Error((tokenRes && tokenRes.error) || 'Copilot session token invalid. Please reconnect Copilot in Settings.');
  }

  const Copilot = globalThis.__WebMCPCopilotService;
  if (!Copilot) {
    throw new Error('CopilotService library not loaded.');
  }

  const endpointUrl = tokenRes.endpoints && tokenRes.endpoints.api
    ? (tokenRes.endpoints.api.replace(/\/$/, '') + '/chat/completions')
    : undefined;

  const result = await Copilot.chatCompletion({
    model: state.model,
    messages,
    tools,
    sessionToken: tokenRes.token,
    endpointUrl,
  });

  if (result && result.message && result.message.content) {
    onChunk('text', result.message.content);
  }

  return result.message;
}

async function runAgent() {
  const isCopilot = state.model.startsWith('copilot:');
  syncSystemMessage();

  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    await detectPageTools();
    const tools = state.tools.map(toOllamaTool);
    tools.unshift(NATIVE_WAIT_TOOL);

    const bubble = createAssistantBubble();
    let reply;
    try {
      if (isCopilot) {
        reply = await copilotChat(state.messages, tools, (kind, delta) => bubble.append(kind, delta));
      } else {
        reply = await ollamaChat(state.messages, tools, (kind, delta) => bubble.append(kind, delta));
      }
    } catch (err) {
      if (err && err.status === 403) showStatus(CORS_HINT);
      bubble.fail('Failed to reach AI provider: ' + String((err && err.message) || err));
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

  clearSuggestions();
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
    saveCurrentChatSession();
    state.busy = false;
    updateSendState();
    els.input.focus();
  }

  // The turn just ended: offer contextual follow-ups. generatePromptSuggestions()
  // already no-ops cleanly when autoSuggest/Ollama/tools are not ready, so this
  // is safe to call unconditionally rather than duplicating its readiness checks.
  generatePromptSuggestions();
}

// --- Events ----------------------------------------------------------------

function autoGrow() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 160) + 'px';
}

for (const button of document.querySelectorAll('.tab')) {
  button.addEventListener('click', () => setTab(button.dataset.tab));
}

els.input.addEventListener('input', () => { autoGrow(); updateSendState(); });
els.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});
els.send.addEventListener('click', sendMessage);

els.refreshModels.addEventListener('click', async () => {
  await fetchRemoteCopilotModels();
  await fetchLocalModels();
});
els.modelSelect.addEventListener('change', () => {
  state.model = els.modelSelect.value;
  chrome.storage.local.set({ selectedModel: state.model });
  updateSendState();
  if (state.autoSuggest && state.tools.length > 0) {
    generatePromptSuggestions();
  } else {
    clearSuggestions();
  }
});

if (els.autoSuggestToggle) {
  els.autoSuggestToggle.addEventListener('change', () => {
    state.autoSuggest = els.autoSuggestToggle.checked;
    chrome.storage.local.set({ autoSuggest: state.autoSuggest });
    if (state.autoSuggest && state.tools.length > 0) {
      generatePromptSuggestions();
    } else {
      clearSuggestions();
    }
  });
}

if (els.resetChatOnTabToggle) {
  els.resetChatOnTabToggle.addEventListener('change', () => {
    state.resetChatOnTabSwitch = els.resetChatOnTabToggle.checked;
    chrome.storage.local.set({ resetChatOnTabSwitch: state.resetChatOnTabSwitch });
  });
}

if (els.catalogSourceNone && els.catalogSourceDemo && els.catalogSourceRemote) {
  const toggleSourceFields = () => {
    const isRemote = els.catalogSourceRemote.checked;
    if (els.catalogRemoteFields) els.catalogRemoteFields.hidden = !isRemote;
    syncCatalog();
  };
  els.catalogSourceNone.addEventListener('change', toggleSourceFields);
  els.catalogSourceDemo.addEventListener('change', toggleSourceFields);
  els.catalogSourceRemote.addEventListener('change', toggleSourceFields);
}

if (els.catalogSyncBtn) {
  els.catalogSyncBtn.addEventListener('click', syncCatalog);
}

els.refreshTools.addEventListener('click', detectPageTools);
els.toolsBadge.addEventListener('click', () => setTab('tools'));

els.execJson.addEventListener('input', syncFormFromJson);
els.execRun.addEventListener('click', executeSelectedTool);

els.historyClear.addEventListener('click', () => {
  state.history = [];
  chrome.storage.local.set({ history: [] });
  renderHistory();
  renderInChatHistoryDrawer();
});

els.clearChat.addEventListener('click', () => {
  resetConversation();

  // Back to a blank conversation: re-offer the same starting suggestions a
  // fresh page load would show, not stale follow-ups from the cleared chat.
  generatePromptSuggestions();
});

/**
 * One-shot question to whichever provider is selected. The tool-calling loop
 * lives in runAgent(); this is for the small side questions (suggestions,
 * conversation titles) that only need text back.
 */
async function askModel(prompt, signal) {
  if (!state.model) throw new Error('No model selected.');

  if (state.model.startsWith('copilot:')) {
    const reply = await copilotChat([{ role: 'user', content: prompt }], undefined, () => {});
    return (reply && reply.content) || '';
  }

  const response = await fetch(state.host + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: state.model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    }),
    signal,
  });
  if (!response.ok) {
    throw new Error('Model provider responded ' + response.status + '.');
  }
  const data = await response.json();
  return (data.message && data.message.content) || '';
}

function currentDomain() {
  try {
    return state.tabUrl ? new URL(state.tabUrl).hostname : '';
  } catch (_) {
    return '';
  }
}

function currentSession() {
  return (state.chatSessions || []).find((s) => s.id === state.currentSessionId) || null;
}

/** Title and origin of the thread on screen. */
function renderChatHeader() {
  const session = currentSession();
  const domain = currentDomain();

  // Never overwrite the input the user is typing a new name into.
  if (els.chatThreadTitle && els.chatThreadTitle.dataset.renaming !== '1') {
    els.chatThreadTitle.textContent = (session && session.title) || 'New conversation';
  }
  if (els.chatThreadDomain) {
    els.chatThreadDomain.textContent = (session && session.domain) || domain || '';
  }
  if (els.threadsDomain) {
    els.threadsDomain.textContent = domain || 'this page';
  }
}

/**
 * Renames a thread in place: the title becomes an input until Enter or blur
 * saves it, Escape cancels.
 */
function renameSessionInline(el, session, inputClass, afterSave) {
  if (!session || !el || el.dataset.renaming === '1') return;
  el.dataset.renaming = '1';

  const previous = session.title || '';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = inputClass;
  input.value = previous;
  input.maxLength = 80;
  el.textContent = '';
  el.appendChild(input);
  input.focus();
  input.select();

  let settled = false;
  const finish = (save) => {
    if (settled) return;
    settled = true;
    delete el.dataset.renaming;
    const next = input.value.trim();
    if (save && next && next !== previous) {
      applySessionTitle(session, next);
    }
    if (afterSave) afterSave();
  };

  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (event) => event.stopPropagation());
  input.addEventListener('dblclick', (event) => event.stopPropagation());
}

/**
 * A title the user chose — by hand or by asking the model — outranks the one
 * derived from the first message, which saveCurrentChatSession() rewrites on
 * every save and would otherwise undo the rename on the next message.
 */
function applySessionTitle(session, title) {
  session.title = title;
  session.titleCustom = true;
  session.updatedAt = Date.now();
  chrome.storage.local.set({ chatSessions: state.chatSessions });
  renderChatHeader();
}

/** Asks the model for a short name for a thread. */
async function generateSessionTitle(session, button) {
  const turns = (session.messages || [])
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content)
    .slice(0, 8)
    .map((m) => `${m.role}: ${String(m.content).slice(0, 300)}`)
    .join('\n');

  if (!turns) {
    showStatus('That conversation has nothing to summarize yet.');
    return;
  }
  if (!state.model) {
    showStatus('Pick a model first: the title is written by the model.');
    return;
  }

  const label = button ? button.textContent : null;
  if (button) {
    button.disabled = true;
    button.textContent = '⏳';
  }

  const prompt = 'Below is a conversation between a user and a web agent.\n\n'
    + turns
    + '\n\nWrite a title for it: at most 6 words, no quotes, no trailing period, '
    + 'in the same language the user is writing in. Answer with the title alone and nothing else.';

  try {
    const raw = await askModel(prompt);
    const title = String(raw)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)[0] || '';
    const clean = title.replace(/^["'\s]+/, '').replace(/["'\s.]+$/, '').slice(0, 60);
    if (!clean) {
      showStatus('The model returned no usable title.');
      return;
    }
    applySessionTitle(session, clean);
    renderChatThreadsView();
  } catch (err) {
    showStatus('Could not generate a title: ' + String((err && err.message) || err));
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = label || '✨';
    }
  }
}

/**
 * Leaves the current thread saved and starts a genuinely new one.
 *
 * resetConversation() only clears the messages: keeping the same
 * currentSessionId meant the next message overwrote the thread you had just
 * left instead of creating one beside it.
 */
function startNewSession() {
  saveCurrentChatSession();
  state.currentSessionId = 'session-' + Date.now();
  resetConversation();
  renderChatHeader();
  generatePromptSuggestions();
  setChatSubView('chat');
}

function saveCurrentChatSession() {
  const userMsgs = (state.messages || []).filter((m) => m.role === 'user');
  if (userMsgs.length === 0) return;

  const firstMsg = userMsgs[0].content;
  const title = firstMsg.slice(0, 45).replace(/\n/g, ' ');
  let domain = 'local';
  try {
    if (state.tabUrl) domain = new URL(state.tabUrl).hostname;
  } catch (_) { /* invalid url */ }

  let session = (state.chatSessions || []).find((s) => s.id === state.currentSessionId);
  if (session) {
    if (!session.titleCustom) session.title = title;
    session.messages = [...state.messages];
    session.updatedAt = Date.now();
    session.url = state.tabUrl;
    session.domain = domain;
  } else {
    session = {
      id: state.currentSessionId,
      title,
      messages: [...state.messages],
      updatedAt: Date.now(),
      url: state.tabUrl,
      domain,
    };
    state.chatSessions.unshift(session);
  }

  chrome.storage.local.set({ chatSessions: state.chatSessions });
  renderChatHeader();
}

function loadChatSession(session) {
  state.currentSessionId = session.id;
  state.messages = [...session.messages];

  els.chat.textContent = '';
  for (const m of session.messages) {
    if (m.role !== 'system') addMessage(m.role, m.content);
  }

  renderChatHeader();
  setChatSubView('chat');
}

function setChatSubView(subView) {
  state.chatSubView = subView;
  renderChatHeader();
  if (subView === 'threads') {
    if (els.chatThreadsView) els.chatThreadsView.hidden = false;
    if (els.chatActiveView) els.chatActiveView.hidden = true;
    if (els.composer) els.composer.hidden = true;
    renderChatThreadsView();
  } else {
    if (els.chatThreadsView) els.chatThreadsView.hidden = true;
    if (els.chatActiveView) els.chatActiveView.hidden = false;
    if (els.composer) els.composer.hidden = false;
  }
}

function renderChatThreadsView() {
  if (!els.chatThreadsList) return;
  els.chatThreadsList.textContent = '';

  saveCurrentChatSession();

  let domain = '';
  try {
    if (state.tabUrl) domain = new URL(state.tabUrl).hostname;
  } catch (_) { /* invalid url */ }

  const sessions = (state.chatSessions || []).filter((s) => !domain || s.domain === domain || (s.url && s.url.includes(domain)));

  if (sessions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.style.padding = '24px 12px';
    const h1 = document.createElement('h1');
    h1.style.fontSize = '15px';
    h1.textContent = 'No past conversations for this page';
    const p = document.createElement('p');
    p.textContent = 'Click "➕ New Chat" to start a thread on this page.';
    empty.append(h1, p);
    els.chatThreadsList.appendChild(empty);
    return;
  }

  for (const s of sessions) {
    const card = document.createElement('div');
    card.className = 'thread-card';
    if (s.id === state.currentSessionId) card.classList.add('is-active');

    const info = document.createElement('div');
    info.className = 'thread-card__info';

    const titleEl = document.createElement('div');
    titleEl.className = 'thread-card__title';
    titleEl.textContent = s.title || 'Untitled Thread';
    titleEl.title = 'Double-click to rename';
    titleEl.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      renameSessionInline(titleEl, s, 'thread-card__rename', renderChatThreadsView);
    });

    const metaEl = document.createElement('div');
    metaEl.className = 'thread-card__meta';
    const msgCount = (s.messages || []).filter((m) => m.role !== 'system').length;
    const time = new Date(s.updatedAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    // The domain is what makes a thread recognizable once you have several from
    // different pages; it has been stored all along but never shown.
    if (s.domain) {
      const domainEl = document.createElement('span');
      domainEl.className = 'thread-card__domain';
      domainEl.textContent = s.domain;
      metaEl.append(domainEl, document.createTextNode(` · ${msgCount} msg${msgCount === 1 ? '' : 's'} · ${time}`));
    } else {
      metaEl.textContent = `${msgCount} msg${msgCount === 1 ? '' : 's'} · ${time}`;
    }

    info.append(titleEl, metaEl);

    const genBtn = document.createElement('button');
    genBtn.type = 'button';
    genBtn.className = 'thread-card__gen';
    genBtn.textContent = '✨';
    genBtn.title = 'Name this conversation with the model';
    genBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      generateSessionTitle(s, genBtn);
    });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'thread-card__del';
    delBtn.textContent = '🗑';
    delBtn.title = 'Delete thread';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.chatSessions = state.chatSessions.filter((item) => item.id !== s.id);
      chrome.storage.local.set({ chatSessions: state.chatSessions });
      if (state.currentSessionId === s.id) {
        resetConversation();
      }
      renderChatThreadsView();
    });

    const actions = document.createElement('div');
    actions.className = 'thread-card__actions';
    actions.append(genBtn, delBtn);

    card.append(info, actions);
    card.addEventListener('click', () => loadChatSession(s));
    els.chatThreadsList.appendChild(card);
  }
}

if (els.chatBackBtn) {
  els.chatBackBtn.addEventListener('click', () => setChatSubView('threads'));
}

if (els.chatNewBtn) {
  els.chatNewBtn.addEventListener('click', startNewSession);
}

if (els.threadsNewBtn) {
  els.threadsNewBtn.addEventListener('click', startNewSession);
}

if (els.catalogActive) {
  els.catalogActive.addEventListener('click', () => setTab('settings'));
}

if (els.chatThreadTitle) {
  els.chatThreadTitle.addEventListener('dblclick', () => {
    const session = currentSession();
    if (!session) {
      showStatus('Send a message first: an empty conversation has nothing to name yet.');
      return;
    }
    renameSessionInline(els.chatThreadTitle, session, 'chat-header__rename', renderChatHeader);
  });
}

els.confirmTools.addEventListener('change', () => {
  chrome.storage.local.set({ confirmTools: els.confirmTools.checked });
});

chrome.tabs.onActivated.addListener(() => detectPageToolsTwice());
// Coming back to the panel after it was hidden: the active tab may have moved
// on without us.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) detectPageTools();
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === state.tabId && changeInfo.status === 'complete') detectPageTools();
});
chrome.runtime.onMessage.addListener((message) => {
  if (!message) return;
  if (message.type === 'tools-changed' && message.tabId === state.tabId) {
    detectPageTools();
    return;
  }
  // The service worker tells us the front tab changed. It knows before we do,
  // and by the time it says so its bridge to that tab is reachable.
  // Auth runs in the service worker, whose console the panel cannot see.
  if (message.type === 'BG_LOG') {
    appendLog(message.level || 'INFO', message.message);
    return;
  }
  if (message.type === 'active-tab') {
    if (message.windowId != null && state.windowId != null
        && message.windowId !== state.windowId) {
      return; // another window's side panel owns that one
    }
    detectPageToolsTwice();
  }
});

// --- GitHub Copilot Device Flow Auth Controller -----------------------------

function renderCopilotStatus() {
  if (!els.copilotStatusBox) return;

  if (state.copilotConnected) {
    if (els.copilotDisconnectedView) els.copilotDisconnectedView.hidden = true;
    if (els.copilotPendingView) els.copilotPendingView.hidden = true;
    if (els.copilotConnectedView) els.copilotConnectedView.hidden = false;
    if (els.copilotErrorMsg) els.copilotErrorMsg.hidden = true;
  } else if (state.copilotDeviceCode) {
    if (els.copilotDisconnectedView) els.copilotDisconnectedView.hidden = true;
    if (els.copilotPendingView) els.copilotPendingView.hidden = false;
    if (els.copilotConnectedView) els.copilotConnectedView.hidden = true;
  } else {
    if (els.copilotDisconnectedView) els.copilotDisconnectedView.hidden = false;
    if (els.copilotPendingView) els.copilotPendingView.hidden = true;
    if (els.copilotConnectedView) els.copilotConnectedView.hidden = true;
  }
}

function showCopilotError(message) {
  if (els.copilotErrorMsg) {
    els.copilotErrorMsg.textContent = message;
    els.copilotErrorMsg.hidden = false;
  }
  console.error('[Copilot] ' + message);
}

async function checkCopilotStatus() {
  const stored = await chrome.storage.local.get(['github_oauth_token', 'copilot_session_token']);
  if (!stored.github_oauth_token) {
    state.copilotConnected = false;
    renderCopilotStatus();
    renderModelOptions();
    return;
  }

  // The GitHub token outlives the Copilot session token, which expires in
  // ~25 minutes. Holding only the former is the normal state after a while, not
  // a disconnection: try the exchange before declaring us logged out.
  if (!stored.copilot_session_token) {
    const tokenRes = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'GET_OR_REFRESH_COPILOT_TOKEN', forceRefresh: true }, resolve);
    });
    if (!tokenRes || !tokenRes.success || !tokenRes.token) {
      state.copilotConnected = false;
      renderCopilotStatus();
      renderModelOptions();
      showCopilotError((tokenRes && tokenRes.error) || 'The stored GitHub token could not be exchanged for a Copilot session.');
      return;
    }
  }

  state.copilotConnected = true;
  renderCopilotStatus();
  await fetchRemoteCopilotModels();
}

async function startCopilotFlow() {
  if (els.copilotErrorMsg) els.copilotErrorMsg.hidden = true;
  if (els.copilotConnectBtn) els.copilotConnectBtn.disabled = true;

  try {
    const res = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'START_COPILOT_AUTH' }, resolve);
    });

    if (!res || !res.success) {
      throw new Error((res && res.error) || 'Failed to start GitHub device flow.');
    }

    state.copilotDeviceCode = res.device_code;
    state.copilotDeviceExpiresAt = Date.now() + ((res.expires_in || 900) * 1000);
    console.log('[Copilot] Device flow started. Enter ' + res.user_code + ' at ' + (res.verification_uri || 'https://github.com/login/device'));
    if (els.copilotUserCode) els.copilotUserCode.textContent = res.user_code;
    if (els.copilotVerifyLink) els.copilotVerifyLink.href = res.verification_uri || 'https://github.com/login/device';

    renderCopilotStatus();

    chrome.tabs.create({ url: res.verification_uri || 'https://github.com/login/device' }).catch(() => {});

    pollCopilotFlow(res.device_code, res.interval || 5);
  } catch (err) {
    showCopilotError(String(err.message || err));
  } finally {
    if (els.copilotConnectBtn) els.copilotConnectBtn.disabled = false;
  }
}

function cancelCopilotFlow() {
  if (state.copilotPollingTimer) {
    clearTimeout(state.copilotPollingTimer);
    state.copilotPollingTimer = null;
  }
  state.copilotDeviceCode = null;
  state.copilotDeviceExpiresAt = 0;
  renderCopilotStatus();
}

function pollCopilotFlow(deviceCode, intervalSec) {
  if (state.copilotPollingTimer) clearTimeout(state.copilotPollingTimer);

  state.copilotPollingTimer = setTimeout(async () => {
    if (!state.copilotDeviceCode || state.copilotDeviceCode !== deviceCode) return;

    if (state.copilotDeviceExpiresAt && Date.now() > state.copilotDeviceExpiresAt) {
      cancelCopilotFlow();
      showCopilotError('The device code expired before GitHub authorized it. Press Connect to get a new one.');
      return;
    }

    const res = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'POLL_COPILOT_AUTH', device_code: deviceCode }, resolve);
    });

    // res.success only says the worker answered. Whether GitHub is done is
    // res.status: 'pending' | 'success' | 'error'.
    if (!res || !res.success) {
      cancelCopilotFlow();
      showCopilotError((res && res.error) || 'The service worker did not answer the polling request.');
      return;
    }

    if (res.status === 'pending') {
      const wait = (res.interval || intervalSec) + (res.error === 'slow_down' ? 5 : 0);
      if (els.copilotPollingText) {
        els.copilotPollingText.textContent = res.error === 'slow_down'
          ? 'GitHub asked us to slow down; retrying in ' + wait + 's…'
          : 'Waiting for GitHub approval…';
      }
      pollCopilotFlow(deviceCode, wait);
      return;
    }

    if (res.status !== 'success') {
      cancelCopilotFlow();
      showCopilotError(res.error_description || res.error || 'Authorization failed.');
      return;
    }

    cancelCopilotFlow();
    state.copilotConnected = true;
    if (els.copilotErrorMsg) els.copilotErrorMsg.hidden = true;
    console.log('[Copilot] Device flow completed; session token stored.');
    renderCopilotStatus();
    await fetchRemoteCopilotModels();
    fetchLocalModels();
  }, intervalSec * 1000);
}

async function disconnectCopilot() {
  await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'REVOKE_COPILOT_AUTH' }, resolve);
  });
  state.copilotConnected = false;
  state.copilotModels = [];
  renderCopilotStatus();
  renderModelOptions();
}

if (els.copilotConnectBtn) {
  els.copilotConnectBtn.addEventListener('click', startCopilotFlow);
}
if (els.copilotCancelBtn) {
  els.copilotCancelBtn.addEventListener('click', cancelCopilotFlow);
}
if (els.copilotDisconnectBtn) {
  els.copilotDisconnectBtn.addEventListener('click', disconnectCopilot);
}
if (els.copilotCopyCodeBtn) {
  els.copilotCopyCodeBtn.addEventListener('click', () => {
    if (els.copilotUserCode && els.copilotUserCode.textContent) {
      navigator.clipboard.writeText(els.copilotUserCode.textContent.trim());
      els.copilotCopyCodeBtn.textContent = '✔ Copied!';
      setTimeout(() => {
        if (els.copilotCopyCodeBtn) els.copilotCopyCodeBtn.textContent = '📋 Copy Code';
      }, 2000);
    }
  });
}

// --- Bootstrap -------------------------------------------------------------

(async function init() {
  try {
    const window_ = await chrome.windows.getCurrent();
    state.windowId = window_ ? window_.id : null;
  } catch (_) { /* fall back to reacting to every window */ }

  await checkCopilotStatus();

  const stored = await chrome.storage.local.get([
    'confirmTools',
    'activeTab',
    'autoSuggest',
    'resetChatOnTabSwitch',
    'catalogSourceMode',
    'catalogUrl',
    'catalogToken',
    'catalogSyncedAt',
    'webmcp_catalog_cache',
    'chatSessions',
  ]);

  state.chatSessions = Array.isArray(stored.chatSessions) ? stored.chatSessions : [];
  els.confirmTools.checked = Boolean(stored.confirmTools);
  state.autoSuggest = Boolean(stored.autoSuggest);
  if (els.autoSuggestToggle) els.autoSuggestToggle.checked = state.autoSuggest;
  state.resetChatOnTabSwitch = Boolean(stored.resetChatOnTabSwitch);
  if (els.resetChatOnTabToggle) els.resetChatOnTabToggle.checked = state.resetChatOnTabSwitch;

  state.catalogSourceMode = stored.catalogSourceMode || 'none';
  state.catalogUrl = stored.catalogUrl || '';
  state.catalogToken = stored.catalogToken || '';
  state.catalogSyncedAt = stored.catalogSyncedAt || 0;

  if (els.catalogSourceRemote && state.catalogSourceMode === 'remote') {
    els.catalogSourceRemote.checked = true;
    if (els.catalogRemoteFields) els.catalogRemoteFields.hidden = false;
  } else if (els.catalogSourceDemo && state.catalogSourceMode === 'demo') {
    els.catalogSourceDemo.checked = true;
    if (els.catalogRemoteFields) els.catalogRemoteFields.hidden = true;
  } else if (els.catalogSourceNone) {
    els.catalogSourceNone.checked = true;
    if (els.catalogRemoteFields) els.catalogRemoteFields.hidden = true;
  }

  if (els.catalogUrl) els.catalogUrl.value = state.catalogUrl;
  if (els.catalogToken) els.catalogToken.value = state.catalogToken;

  if (stored.webmcp_catalog_cache) {
    state.catalogData = stored.webmcp_catalog_cache;
  } else if (state.catalogSourceMode === 'demo' && C) {
    state.catalogData = C.DEMO_SAMPLE_CATALOG;
  } else if (C) {
    state.catalogData = C.EMPTY_CATALOG;
  }

  renderCatalogStatus();
  renderCatalogRulesInspector();
  renderChatHeader();
  setTab(stored.activeTab || 'chat');

  await loadHistory();
  await fetchLocalModels();
  await detectPageTools();
  els.input.focus();
})();

// --- Logs & Debug System ---------------------------------------------------

const logLines = [];

function appendLog(type, message) {
  const time = new Date().toLocaleTimeString();
  const line = `[${time}] [${type}] ${message}\n`;
  logLines.push(line);
  if (logLines.length > 300) logLines.shift();
  if (els.logsOutput) {
    els.logsOutput.textContent = logLines.join('');
    els.logsOutput.scrollTop = els.logsOutput.scrollHeight;
  }
}

const rawLog = console.log;
const rawWarn = console.warn;
const rawError = console.error;

console.log = function (...args) {
  rawLog.apply(console, args);
  const msg = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  appendLog('INFO', msg);
};

console.warn = function (...args) {
  rawWarn.apply(console, args);
  const msg = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  appendLog('WARN', msg);
};

console.error = function (...args) {
  rawError.apply(console, args);
  const msg = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  appendLog('ERROR', msg);
};

if (els.logsCopyBtn) {
  els.logsCopyBtn.addEventListener('click', () => {
    if (els.logsOutput) {
      navigator.clipboard.writeText(els.logsOutput.textContent);
      els.logsCopyBtn.textContent = '✔ Copied!';
      setTimeout(() => {
        if (els.logsCopyBtn) els.logsCopyBtn.textContent = '📋 Copy Logs';
      }, 1500);
    }
  });
}

if (els.logsClearBtn) {
  els.logsClearBtn.addEventListener('click', () => {
    logLines.length = 0;
    if (els.logsOutput) els.logsOutput.textContent = 'Logs cleared.\n';
  });
}
