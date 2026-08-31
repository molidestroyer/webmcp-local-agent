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
const TABS = ['chat', 'tools', 'execute', 'history', 'settings'];

// Ollama answers 403 to any origin missing from OLLAMA_ORIGINS, and
// chrome-extension:// is not allowed by default. Chrome does not attach an
// Origin header to the GET on /api/tags (it carries no headers of its own) but
// it does to the POST on /api/chat, hence the confusing symptom: "the models
// load fine but sending a message returns 403".
const CORS_HINT = 'Ollama is rejecting the extension origin (403). Allow it: on Windows run '
  + '  setx OLLAMA_ORIGINS "chrome-extension://*"  and restart Ollama from the tray icon '
  + '(setx only affects newly started processes).';

const SYSTEM_PROMPT = [
  'You are a web navigation and interaction agent embedded in a Chrome extension side panel.',
  'Your goal is to fulfill user requests by calling WebMCP tools exposed by the active web page and your native tools.',
  'OPERATING RULES:',
  '1. Tool Discovery & Chaining: Call available WebMCP tools to act on or query the page. Read input schemas carefully.',
  '2. Asynchronous Processes & Waiting: If a tool call triggers a background process, returns an in-progress status (e.g. PENDING, RUNNING, IN_PROGRESS, QUEUED), or initiates page navigation, invoke the built-in "wait" tool to pause execution (5-15s). After waiting, re-query the status or use the updated page tools.',
  '3. Dynamic Tool Set: Page tools update automatically as you navigate or as SPA views change. Re-evaluate available tools at each step.',
  '4. Completion: Once a terminal state (SUCCESS, COMPLETED, FAILED) is reached, stop tool calls and summarize the final result clearly.',
  'Never invent tools or results. Reply in the user\'s language and be concise.',
].join(' ');

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
  tabId: null,
  windowId: null,
  busy: false,
  ollamaOk: false,
  autoSuggest: false,
  suggesting: false,
  suggestions: [],
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

function renderModelOptions(placeholder) {
  els.modelSelect.textContent = '';
  if (placeholder) {
    els.modelSelect.appendChild(new Option(placeholder, ''));
    els.modelSelect.disabled = true;
    return;
  }
  els.modelSelect.disabled = false;
  for (const model of state.models) {
    const gb = model.size ? ' · ' + (model.size / 1e9).toFixed(1) + ' GB' : '';
    const tools = model.capabilities.includes('tools') ? ' · tools' : '';
    els.modelSelect.appendChild(new Option(model.name + gb + tools, model.name));
  }
}

// --- Bridge to the page ----------------------------------------------------

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

// --- Prompt suggestions ---------------------------------------------------

let suggestAbortController = null;

function clearSuggestions() {
  if (suggestAbortController) {
    suggestAbortController.abort();
    suggestAbortController = null;
  }
  state.suggesting = false;
  state.suggestions = [];
  if (els.suggestions) {
    els.suggestions.hidden = true;
    if (els.suggestionsLoading) els.suggestionsLoading.hidden = true;
    if (els.suggestionsChips) els.suggestionsChips.textContent = '';
  }
}

function renderSuggestions() {
  if (!els.suggestionsChips) return;
  els.suggestionsChips.textContent = '';
  if (!state.suggestions.length) {
    if (els.suggestions) els.suggestions.hidden = true;
    return;
  }

  if (els.suggestions) els.suggestions.hidden = false;
  if (els.suggestionsLoading) els.suggestionsLoading.hidden = !state.suggesting;

  for (const text of state.suggestions) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip-suggestion';
    chip.textContent = '💡 ' + text;
    chip.addEventListener('click', () => {
      els.input.value = text;
      autoGrow();
      updateSendState();
      sendMessage();
    });
    els.suggestionsChips.appendChild(chip);
  }
}

async function generatePromptSuggestions() {
  if (!state.autoSuggest || !state.ollamaOk || !state.model || !state.tools.length || state.busy) {
    clearSuggestions();
    return;
  }

  if (suggestAbortController) {
    suggestAbortController.abort();
  }
  suggestAbortController = new AbortController();
  const signal = suggestAbortController.signal;

  state.suggesting = true;
  if (els.suggestions) els.suggestions.hidden = false;
  if (els.suggestionsLoading) els.suggestionsLoading.hidden = false;

  const toolSummary = state.tools.map((t) => `- ${t.name}: ${t.description || 'No description'}`).join('\n');
  const prompt = `Available page tools:\n${toolSummary}\n\nSuggest between 1 and 3 short, direct user questions or actions that can be requested using these tools. Output MUST be ONLY a JSON array of strings, e.g. ["Suggestion 1", "Suggestion 2"]. Do NOT include any markdown code blocks, explanation, or extra text.`;

  try {
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
      clearSuggestions();
      return;
    }

    const data = await response.json();
    if (signal.aborted) return;

    let content = (data.message && data.message.content) || '';
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
      clearSuggestions();
      return;
    }

    const validSuggestions = parsed
      .filter((item) => typeof item === 'string' && item.trim())
      .map((item) => item.trim())
      .slice(0, 3);

    if (!validSuggestions.length) {
      clearSuggestions();
      return;
    }

    state.suggestions = validSuggestions;
    renderSuggestions();
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    clearSuggestions();
  } finally {
    state.suggesting = false;
    if (els.suggestionsLoading) els.suggestionsLoading.hidden = true;
  }
}

async function detectPageTools() {
  els.refreshTools.classList.add('is-spinning');
  try {
    await currentTabId();
    const answer = state.tabId == null ? null : await bridge('list', null);
    const failed = !answer || answer.error;
    state.tools = failed ? [] : S.toolsFromListing(answer.result);

    // A page whose getTools() throws looks identical to one with no tools,
    // which is how declarative tools went missing without a word.
    const problems = failed ? [] : S.listingErrors(answer.result);
    if (problems.length) showStatus('Reading the page tools failed: ' + problems.join(' | '));

    renderToolsBadge(state.tabId == null ? 'no tab' : null);
    renderToolsList();
    renderPicker();

    if (state.autoSuggest && state.tools.length > 0 && state.ollamaOk && state.model && !state.busy) {
      generatePromptSuggestions();
    } else if (!state.tools.length || !state.autoSuggest) {
      clearSuggestions();
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
    origin.textContent = entry.origin === 'manual' ? 'manual' : 'chat';
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

  const finish = (ok, output) => {
    recordExecution({ tool: String(name || 'unknown'), origin: 'chat', args, ok, output });
    return { role: 'tool', tool_name: String(name || 'unknown'), content: ok ? output : 'Error: ' + output };
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
      return { role: 'tool', tool_name: name || 'wait', content: text };
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
    return { role: 'tool', tool_name: 'wait', content: text };
  }

  const started = performance.now();
  const answer = await executeOnPage(name, args);
  const ms = performance.now() - started;

  if (!answer || answer.error) {
    const text = (answer && answer.error) || 'Unknown error while running the tool.';
    card.fail(text);
    recordExecution({ tool: name, origin: 'chat', args, ok: false, output: text, ms });
    return { role: 'tool', tool_name: name, content: 'Error: ' + text };
  }

  const text = resultToText(answer.result);
  card.done(text);
  recordExecution({ tool: name, origin: 'chat', args, ok: true, output: text, ms });
  return { role: 'tool', tool_name: name, content: text };
}

async function runAgent() {
  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    await detectPageTools();
    const tools = state.tools.map(toOllamaTool);
    tools.unshift(NATIVE_WAIT_TOOL);

    const bubble = createAssistantBubble();
    let reply;
    try {
      reply = await ollamaChat(state.messages, tools, (kind, delta) => bubble.append(kind, delta));
    } catch (err) {
      // A 403 will not fix itself on retry: Ollama has to be reconfigured, so
      // keep the hint pinned in the status bar as well as in the chat.
      if (err && err.status === 403) showStatus(CORS_HINT);
      bubble.fail('Failed to reach Ollama: ' + String((err && err.message) || err));
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

els.refreshModels.addEventListener('click', fetchLocalModels);
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

els.refreshTools.addEventListener('click', detectPageTools);
els.toolsBadge.addEventListener('click', () => setTab('tools'));

els.execJson.addEventListener('input', syncFormFromJson);
els.execRun.addEventListener('click', executeSelectedTool);

els.historyClear.addEventListener('click', () => {
  state.history = [];
  chrome.storage.local.set({ history: [] });
  renderHistory();
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
  if (message.type === 'active-tab') {
    if (message.windowId != null && state.windowId != null
        && message.windowId !== state.windowId) {
      return; // another window's side panel owns that one
    }
    detectPageToolsTwice();
  }
});

// --- Bootstrap -------------------------------------------------------------

(async function init() {
  try {
    const window_ = await chrome.windows.getCurrent();
    state.windowId = window_ ? window_.id : null;
  } catch (_) { /* fall back to reacting to every window */ }

  const stored = await chrome.storage.local.get(['confirmTools', 'activeTab', 'autoSuggest']);
  els.confirmTools.checked = Boolean(stored.confirmTools);
  state.autoSuggest = Boolean(stored.autoSuggest);
  if (els.autoSuggestToggle) els.autoSuggestToggle.checked = state.autoSuggest;
  setTab(stored.activeTab || 'chat');

  await loadHistory();
  await fetchLocalModels();
  await detectPageTools();
  els.input.focus();
})();
