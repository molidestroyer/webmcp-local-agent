/**
 * WebMCP Local Agent - page-hook.js
 *
 * Runs in the page's MAIN world (document_start) so it can see the real
 * `navigator.modelContext` / `window.modelContext` object, which is invisible
 * from a content script's isolated world.
 *
 * The technique of wrapping `provideContext()` / `registerTool()` to discover
 * the tools a page declares follows the approach of François Beaufort's
 * "Model Context Tool Inspector":
 *   https://github.com/beaufortfrancois/model-context-tool-inspector
 * See the README for full credits.
 */
(() => {
  'use strict';

  const TO_PAGE = 'webmcp-local-agent:to-page';
  const FROM_PAGE = 'webmcp-local-agent:from-page';
  const FLAG = '__webmcpLocalAgentHook__';

  if (window[FLAG]) return;
  window[FLAG] = true;

  /** @type {Map<string, {descriptor: object, execute: Function|null, source: string}>} */
  const registry = new Map();
  const patchedObjects = new WeakSet();

  const isFn = (value) => typeof value === 'function';
  const S = window.__WebMCPLocalAgentSchema;

  function rawSchemaOf(tool) {
    if (tool.inputSchema !== undefined) return tool.inputSchema;
    if (tool.input_schema !== undefined) return tool.input_schema;
    if (tool.parameters !== undefined) return tool.parameters;
    if (tool.params !== undefined) return tool.params;
    return null;
  }

  function executorOf(tool) {
    for (const key of ['execute', 'callback', 'handler', 'run', 'invoke']) {
      if (isFn(tool[key])) return tool[key].bind(tool);
    }
    return null;
  }

  function remember(tool, source, options) {
    const keepExisting = Boolean(options && options.keepExisting);
    if (!tool || typeof tool !== 'object' || typeof tool.name !== 'string') return;
    if (keepExisting && registry.has(tool.name)) return;

    // The native API serialises inputSchema to a JSON string; imperative
    // registrations pass an object. Normalise here so nothing downstream has to
    // care, and keep the parse failure instead of pretending the tool takes no
    // input.
    const normalized = S.safeNormalizeInputSchema(rawSchemaOf(tool));

    registry.set(tool.name, {
      descriptor: {
        name: tool.name,
        description: tool.description || tool.title || '',
        inputSchema: normalized.schema,
        schemaError: normalized.error,
        annotations: tool.annotations || null,
        origin: typeof tool.origin === 'string' ? tool.origin : null,
        source,
      },
      execute: executorOf(tool),
      source,
    });
  }

  let notifyTimer = null;
  function notifyToolsChanged() {
    clearTimeout(notifyTimer);
    notifyTimer = setTimeout(() => {
      window.postMessage({ channel: FROM_PAGE, event: 'tools-changed' }, '*');
    }, 120);
  }

  // --- Wrapping the page API ----------------------------------------------

  function patch(target, label) {
    if (!target || typeof target !== 'object' || patchedObjects.has(target)) return;
    patchedObjects.add(target);

    if (isFn(target.provideContext)) {
      const original = target.provideContext.bind(target);
      try {
        target.provideContext = function (config, ...rest) {
          try {
            // provideContext() replaces the whole tool set.
            registry.clear();
            const tools = config && config.tools;
            if (Array.isArray(tools)) tools.forEach((tool) => remember(tool, label));
            notifyToolsChanged();
          } catch (_) { /* never break the page */ }
          return original(config, ...rest);
        };
      } catch (_) { /* non-writable property */ }
    }

    if (isFn(target.registerTool)) {
      const original = target.registerTool.bind(target);
      try {
        target.registerTool = function (...args) {
          try {
            // Shape A: registerTool({ name, description, inputSchema, execute })
            // Shape B: registerTool(name, config, handler)  (MCP SDK style)
            if (typeof args[0] === 'string') {
              const name = args[0];
              const config = args[1] || {};
              const handler = args[2];
              remember(Object.assign({}, config, { name, execute: handler }), label);
            } else {
              remember(args[0], label);
            }
            notifyToolsChanged();
          } catch (_) { /* noop */ }
          return original(...args);
        };
      } catch (_) { /* noop */ }
    }

    if (isFn(target.unregisterTool)) {
      const original = target.unregisterTool.bind(target);
      try {
        target.unregisterTool = function (name, ...rest) {
          try {
            registry.delete(typeof name === 'string' ? name : name && name.name);
            notifyToolsChanged();
          } catch (_) { /* noop */ }
          return original(name, ...rest);
        };
      } catch (_) { /* noop */ }
    }
  }

  function contextObjects() {
    const found = [];
    const push = (obj, label) => {
      if (obj && typeof obj === 'object' && !found.some((entry) => entry.obj === obj)) {
        found.push({ obj, label });
      }
    };
    // document.modelContext is where the current native API lives; the others
    // are earlier drafts and polyfills still found in the wild.
    try { push(document.modelContext, 'document.modelContext'); } catch (_) { /* noop */ }
    try { push(navigator.modelContext, 'navigator.modelContext'); } catch (_) { /* noop */ }
    try { push(window.modelContext, 'window.modelContext'); } catch (_) { /* noop */ }
    try { push(window.agent && window.agent.modelContext, 'window.agent.modelContext'); } catch (_) { /* noop */ }
    try { push(window.agent, 'window.agent'); } catch (_) { /* noop */ }
    return found;
  }

  function patchAll() {
    for (const entry of contextObjects()) patch(entry.obj, entry.label);
  }

  // The API may show up later (polyfills, deferred bundles), so keep retrying.
  patchAll();
  document.addEventListener('DOMContentLoaded', patchAll, { once: true });
  window.addEventListener('load', patchAll, { once: true });
  let retries = 0;
  const retryTimer = setInterval(() => {
    patchAll();
    if (++retries > 30) clearInterval(retryTimer); // ~15 s
  }, 500);

  // --- Discovery and execution --------------------------------------------

  async function snapshot() {
    patchAll();
    for (const entry of contextObjects()) {
      // If the page registered its tools before we could wrap the API, we can
      // still read them when the implementation exposes them.
      for (const key of ['tools', 'getTools', 'listTools']) {
        try {
          let value = entry.obj[key];
          if (value === undefined) continue;
          value = isFn(value) ? await value.call(entry.obj) : await value;
          const list = Array.isArray(value)
            ? value
            : (value && Array.isArray(value.tools) ? value.tools : null);
          if (list) list.forEach((tool) => remember(tool, entry.label, { keepExisting: true }));
        } catch (_) { /* noop */ }
      }
    }
    return [...registry.values()].map((entry) => entry.descriptor);
  }

  async function executeTool(name, args, origin) {
    const params = args && typeof args === 'object' ? args : {};
    const contexts = contextObjects().map((entry) => entry.obj);

    // Primary path: the current API takes the RegisteredTool object, not its
    // name. That object is realm-bound, so it is looked up again right now
    // rather than cached from discovery or sent across extension messaging.
    const resolved = await S.resolveRegisteredTool(contexts, name, origin);
    if (resolved) return resolved.context.executeTool(resolved.tool, params);

    // Imperative registration: the page handed us the callback itself.
    const entry = registry.get(name);
    if (entry && entry.execute) {
      // Implementations differ: some expect `execute(args)`, others
      // `execute({ name, arguments })`. Pass both shapes at once.
      const payload = Object.assign({}, params);
      if (!('arguments' in payload)) payload.arguments = params;
      if (!('name' in payload)) payload.name = name;
      return entry.execute(payload);
    }

    // Older shapes, and only for contexts that do not implement the current
    // one: calling these first and swallowing the resulting TypeError would
    // hide real failures.
    for (const context of contexts) {
      if (S.supportsRegisteredToolApi(context)) continue;
      if (isFn(context.callTool)) return context.callTool(name, params);
      if (isFn(context.executeTool)) return context.executeTool(name, params);
    }

    if (contexts.some(S.supportsRegisteredToolApi)) {
      throw new Error('WebMCP tool "' + name + '" is no longer registered on this page.');
    }
    throw new Error('The page exposes no tool named "' + name + '".');
  }

  /** Makes the value safe for structuredClone (postMessage). */
  function serializable(value) {
    if (value === undefined || value === null) return null;
    const type = typeof value;
    if (type === 'string' || type === 'number' || type === 'boolean') return value;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return String(value);
    }
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== TO_PAGE || typeof data.id !== 'string') return;

    const reply = (result, error) => {
      window.postMessage({ channel: FROM_PAGE, id: data.id, result, error: error || null }, '*');
    };

    try {
      if (data.action === 'list') {
        reply(serializable(await snapshot()));
      } else if (data.action === 'execute') {
        const payload = data.payload || {};
        reply(serializable(await executeTool(payload.name, payload.args, payload.origin)));
      } else {
        reply(null, 'Unknown action: ' + String(data.action));
      }
    } catch (err) {
      reply(null, String((err && err.message) || err));
    }
  });
})();
