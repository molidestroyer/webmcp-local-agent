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

  // Whether we were in place before the page could register anything. If we
  // arrived late (rescue injection into an already-loaded tab) then "the
  // wrapper never saw it" proves nothing, and registration stays unknown.
  const installedEarly = document.readyState === 'loading';
  /** Tool names seen going through the wrapped script API. */
  const registeredByScript = new Set();
  const patchedObjects = new WeakSet();

  const isFn = (value) => typeof value === 'function';
  const S = window.__WebMCPLocalAgentSchema;

  function rawSchemaOf(tool) {
    if (!tool || typeof tool !== 'object') return null;
    if (tool.inputSchema !== undefined) return tool.inputSchema;
    if (tool.input_schema !== undefined) return tool.input_schema;
    if (tool.parameters !== undefined) return tool.parameters;
    if (tool.params !== undefined) return tool.params;
    if (tool.schema !== undefined) return tool.schema;
    if (tool.properties !== undefined && typeof tool.properties === 'object') {
      return { type: 'object', properties: tool.properties, required: tool.required || [] };
    }
    return null;
  }

  function executorOf(tool) {
    for (const key of ['execute', 'callback', 'handler', 'run', 'invoke']) {
      if (isFn(tool[key])) return tool[key].bind(tool);
    }
    return null;
  }

  /**
   * A declaratively registered tool is a <form toolname="..."> in the document.
   * RegisteredTool exposes nothing about its own registration, so the markup is
   * the only evidence available.
   */
  function findDeclarativeForm(name) {
    try {
      for (const form of document.querySelectorAll('form[toolname]')) {
        if (form.getAttribute('toolname') === name) return form;
      }
    } catch (_) { /* noop */ }
    return null;
  }

  function parseFormToTool(form) {
    if (!form || !(form instanceof Element)) return null;
    const name = form.getAttribute('toolname');
    if (!name) return null;

    const description = form.getAttribute('tooldescription') ||
      form.getAttribute('description') ||
      form.getAttribute('title') ||
      '';

    const properties = {};
    const required = [];

    const elements = form.querySelectorAll('input, select, textarea');
    for (const el of elements) {
      const fieldName = el.getAttribute('name') || el.id;
      if (!fieldName) continue;

      const fieldType = (el.getAttribute('type') || el.tagName.toLowerCase()).toLowerCase();
      if (['submit', 'button', 'reset', 'image'].includes(fieldType)) continue;

      const fieldDesc = el.getAttribute('tooldescription') ||
        el.getAttribute('toolparamdescription') ||
        el.getAttribute('placeholder') ||
        el.title ||
        '';

      const isRequired = el.hasAttribute('required') || el.required;
      if (isRequired) required.push(fieldName);

      const prop = {
        type: fieldType === 'number' || fieldType === 'range' ? 'number' :
              fieldType === 'checkbox' ? 'boolean' : 'string',
        description: fieldDesc,
      };

      if (el.tagName.toLowerCase() === 'select') {
        const options = [...el.querySelectorAll('option')].map((opt) => opt.value || opt.textContent.trim()).filter(Boolean);
        if (options.length) prop.enum = options;
      }

      properties[fieldName] = prop;
    }

    return {
      name,
      description,
      inputSchema: {
        type: 'object',
        properties,
        ...(required.length ? { required } : {}),
      },
    };
  }

  function scanDeclarativeForms() {
    const found = [];
    try {
      const forms = document.querySelectorAll('form[toolname]');
      for (const form of forms) {
        const parsed = parseFormToTool(form);
        if (parsed) found.push(parsed);
      }
    } catch (_) { /* noop */ }
    return found;
  }

  function executeDeclarativeForm(form, params) {
    if (!form) return { success: false, error: 'Form not found in document.' };
    const inputs = form.querySelectorAll('input, select, textarea');
    for (const el of inputs) {
      const fieldName = el.getAttribute('name') || el.id;
      if (!fieldName || !(fieldName in params)) continue;
      const val = params[fieldName];

      if (el.type === 'checkbox') {
        el.checked = Boolean(val);
      } else if (el.type === 'radio') {
        if (el.value === String(val)) el.checked = true;
      } else {
        el.value = val === undefined || val === null ? '' : String(val);
      }

      try {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (_) { /* noop */ }
    }

    try {
      if (typeof form.requestSubmit === 'function') {
        form.requestSubmit();
      } else if (typeof form.submit === 'function') {
        form.submit();
      } else {
        const submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
        if (submitBtn) submitBtn.click();
      }
    } catch (err) {
      return { success: false, error: String((err && err.message) || err) };
    }

    return { success: true, message: 'Declarative form submitted.' };
  }

  function registrationOf(name) {
    if (registeredByScript.has(name)) return 'javascript';
    if (findDeclarativeForm(name)) return 'declarative';
    // Never claim "JavaScript API" just because nothing else matched: that is
    // exactly the guess that mislabelled declarative forms before.
    return 'unknown';
  }

  function remember(tool, source, options) {
    const keepExisting = Boolean(options && options.keepExisting);
    if (!tool || typeof tool !== 'object' || typeof tool.name !== 'string') return;
    if (options && options.viaScript) registeredByScript.add(tool.name);
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
        registration: registrationOf(tool.name),
        installedEarly,
        source,
      },
      execute: executorOf(tool),
      viaScript: Boolean(options && options.viaScript),
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
            // provideContext() replaces the whole *script-registered* set.
            // Wiping the map wholesale also removed declarative tools, which
            // only ever come from getTools(), until the next listing.
            for (const [name, item] of registry) {
              if (item.viaScript) registry.delete(name);
            }
            const tools = config && config.tools;
            if (Array.isArray(tools)) tools.forEach((tool) => remember(tool, label, { viaScript: true }));
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
              remember(Object.assign({}, config, { name, execute: handler }), label, { viaScript: true });
            } else {
              remember(args[0], label, { viaScript: true });
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
    try { push(navigator.modelContextTesting, 'navigator.modelContextTesting'); } catch (_) { /* noop */ }
    try { push(document.modelContextTesting, 'document.modelContextTesting'); } catch (_) { /* noop */ }
    try { push(window.modelContextTesting, 'window.modelContextTesting'); } catch (_) { /* noop */ }
    try { push(window.agent && window.agent.modelContext, 'window.agent.modelContext'); } catch (_) { /* noop */ }
    try { push(window.agent, 'window.agent'); } catch (_) { /* noop */ }
    return found;
  }

  function patchAll() {
    for (const entry of contextObjects()) patch(entry.obj, entry.label);
    listenEverywhere();
    patchHistory();
  }

  function patchHistory() {
    if (window.history && !patchedObjects.has(window.history)) {
      patchedObjects.add(window.history);
      for (const method of ['pushState', 'replaceState']) {
        if (isFn(window.history[method])) {
          const original = window.history[method].bind(window.history);
          try {
            window.history[method] = function (...args) {
              const res = original(...args);
              notifyToolsChanged();
              return res;
            };
          } catch (_) { /* noop */ }
        }
      }
    }
    try { window.addEventListener('popstate', notifyToolsChanged); } catch (_) { /* noop */ }
    try { window.addEventListener('hashchange', notifyToolsChanged); } catch (_) { /* noop */ }
  }

  // The platform announces every registration and unregistration with a
  // `toolchange` event. The spec fires it at the document's relevant global
  // object and puts an `ontoolchange` handler on ModelContext, so listen in
  // both places plus the context objects themselves — whichever exists wins.
  //
  // This is the signal that covers declaratively registered tools: nothing
  // calls provideContext()/registerTool() for a <form toolname>, so the
  // wrappers above never see them, and the browser is the only thing that
  // knows when the markup produced or destroyed a tool.
  const toolChangeTargets = new WeakSet();

  function onToolChange() {
    notifyToolsChanged();
  }

  function listenForToolChange(target) {
    if (!target || toolChangeTargets.has(target)) return;
    if (typeof target.addEventListener !== 'function') return;
    toolChangeTargets.add(target);
    try {
      target.addEventListener('toolchange', onToolChange);
    } catch (_) { /* noop */ }
  }

  function listenEverywhere() {
    try { listenForToolChange(window); } catch (_) { /* noop */ }
    try { listenForToolChange(document); } catch (_) { /* noop */ }
    for (const entry of contextObjects()) listenForToolChange(entry.obj);
  }

  // A polyfilled page has no such event, and neither does a browser without
  // WebMCP, so the DOM watch below stays as the fallback for those.
  let lastFormSignature = '';
  let formCheckTimer = null;

  function formSignature() {
    try {
      return [...document.querySelectorAll('form[toolname]')]
        .map((form) => form.getAttribute('toolname'))
        .sort()
        .join('|');
    } catch (_) {
      return '';
    }
  }

  function scheduleFormCheck() {
    // Throttled: a busy SPA mutates constantly and the query is not free.
    if (formCheckTimer) return;
    formCheckTimer = setTimeout(() => {
      formCheckTimer = null;
      const signature = formSignature();
      if (signature !== lastFormSignature) {
        lastFormSignature = signature;
        notifyToolsChanged();
      }
    }, 400);
  }

  try {
    new MutationObserver(scheduleFormCheck)
      .observe(document.documentElement, { childList: true, subtree: true });
  } catch (_) { /* noop */ }

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

  async function snapshot(options) {
    patchAll();

    // Clean up stale declarative form tools whose <form toolname="..."> is no longer in the DOM
    for (const [name, item] of registry) {
      if (item.source === 'form[toolname]' || item.descriptor.registration === 'declarative') {
        if (!findDeclarativeForm(name)) {
          registry.delete(name);
        }
      }
    }

    const fromOrigins = options && Array.isArray(options.fromOrigins) && options.fromOrigins.length
      ? options.fromOrigins
      : null;
    const errors = [];
    let discovered = 0;

    for (const entry of contextObjects()) {
      // Script registrations already sit in the registry, put there by the
      // wrappers. Declaratively registered tools exist nowhere but here, so a
      // failure in this loop makes them silently disappear while JavaScript
      // ones carry on working — which is exactly how it looked from outside.
      for (const key of ['tools', 'getTools', 'listTools']) {
        try {
          let value = entry.obj[key];
          if (value === undefined) continue;
          if (isFn(value)) {
            // getTools() answers only for its own document unless the origins
            // of the other frames are named. Older shapes take no argument, so
            // fall back rather than lose the whole listing.
            value = fromOrigins && key === 'getTools'
              ? await value.call(entry.obj, { fromOrigins }).catch(() => value.call(entry.obj))
              : await value.call(entry.obj);
          } else {
            value = await value;
          }
          const list = Array.isArray(value)
            ? value
            : (value && Array.isArray(value.tools) ? value.tools : null);
          if (list) {
            discovered += list.length;
            list.forEach((tool) => remember(tool, entry.label, { keepExisting: true }));
          }
        } catch (err) {
          errors.push(entry.label + '.' + key + ': ' + String((err && err.message) || err));
        }
      }
    }

    for (const tool of scanDeclarativeForms()) {
      discovered++;
      remember(tool, 'form[toolname]', { keepExisting: true });
    }

    return {
      tools: [...registry.values()].map((item) => item.descriptor),
      // Reported, not swallowed: without this the panel cannot tell "this page
      // has no declarative tools" from "asking for them threw".
      errors,
      discovered,
      formsInDom: formSignature().split('|').filter(Boolean).length,
    };
  }

  async function executeTool(name, args, origin) {
    const params = args && typeof args === 'object' ? args : {};
    const contexts = contextObjects().map((entry) => entry.obj);

    // Primary path: the current API takes the RegisteredTool object, not its
    // name. That object is realm-bound, so it is looked up again right now
    // rather than cached from discovery or sent across extension messaging.
    const resolved = await S.resolveRegisteredTool(contexts, name, origin, window);
    if (resolved) {
      try {
        return await S.callExecuteTool(resolved.context, resolved.tool, params);
      } catch (_) {
        // Native execution failed, try fallback callback or form submission
      }
    }

    // Imperative registration: the page handed us the callback itself.
    const entry = registry.get(name);
    if (entry && entry.execute) {
      try {
        return await entry.execute(params);
      } catch (err1) {
        try {
          const payload = Object.assign({}, params);
          if (!('arguments' in payload)) payload.arguments = params;
          if (!('name' in payload)) payload.name = name;
          return await entry.execute(payload);
        } catch (err2) {
          try {
            return await entry.execute(JSON.stringify(params));
          } catch (_) {
            throw err1;
          }
        }
      }
    }

    // Declarative form fallback in DOM
    const form = findDeclarativeForm(name);
    if (form) {
      return executeDeclarativeForm(form, params);
    }

    // Older shapes, and only for contexts that do not implement the current
    // one: calling these first and swallowing the resulting TypeError would
    // hide real failures.
    for (const context of contexts) {
      if (S.supportsRegisteredToolApi(context)) continue;
      if (isFn(context.callTool)) {
        try { return await context.callTool(name, params); } catch (_) { return await context.callTool(name, JSON.stringify(params)); }
      }
      if (isFn(context.executeTool)) {
        try { return await context.executeTool(name, params); } catch (_) { return await context.executeTool(name, JSON.stringify(params)); }
      }
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
    if (typeof Node !== 'undefined' && value instanceof Node) {
      return value.outerHTML || value.textContent || String(value);
    }
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
        reply(serializable(await snapshot(data.payload)));
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
