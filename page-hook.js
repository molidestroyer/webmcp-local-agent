/**
 * WebMCP Local Agent - page-hook.js
 *
 * Se ejecuta en el MAIN world de la pagina (document_start) para poder ver el
 * objeto real `navigator.modelContext` / `window.modelContext`, que es invisible
 * desde el mundo aislado de un content script.
 *
 * La tecnica de interceptar `provideContext()` / `registerTool()` para descubrir
 * las tools declaradas por la pagina esta tomada del enfoque de
 * "Model Context Tool Inspector" de Francois Beaufort:
 *   https://github.com/beaufortfrancois/model-context-tool-inspector
 * Ver los creditos completos en el README.
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

  function schemaOf(tool) {
    return (
      tool.inputSchema ||
      tool.input_schema ||
      tool.parameters ||
      tool.params ||
      { type: 'object', properties: {} }
    );
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
    registry.set(tool.name, {
      descriptor: {
        name: tool.name,
        description: tool.description || tool.title || '',
        inputSchema: schemaOf(tool),
        annotations: tool.annotations || null,
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

  // --- Interceptacion de la API de la pagina -------------------------------

  function patch(target, label) {
    if (!target || typeof target !== 'object' || patchedObjects.has(target)) return;
    patchedObjects.add(target);

    if (isFn(target.provideContext)) {
      const original = target.provideContext.bind(target);
      try {
        target.provideContext = function (config, ...rest) {
          try {
            // provideContext() reemplaza el conjunto completo de tools.
            registry.clear();
            const tools = config && config.tools;
            if (Array.isArray(tools)) tools.forEach((tool) => remember(tool, label));
            notifyToolsChanged();
          } catch (_) { /* nunca romper la pagina */ }
          return original(config, ...rest);
        };
      } catch (_) { /* propiedad no escribible */ }
    }

    if (isFn(target.registerTool)) {
      const original = target.registerTool.bind(target);
      try {
        target.registerTool = function (...args) {
          try {
            // Forma A: registerTool({ name, description, inputSchema, execute })
            // Forma B: registerTool(name, config, handler)  (estilo SDK de MCP)
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
    try { push(navigator.modelContext, 'navigator.modelContext'); } catch (_) { /* noop */ }
    try { push(window.modelContext, 'window.modelContext'); } catch (_) { /* noop */ }
    try { push(window.agent && window.agent.modelContext, 'window.agent.modelContext'); } catch (_) { /* noop */ }
    try { push(window.agent, 'window.agent'); } catch (_) { /* noop */ }
    return found;
  }

  function patchAll() {
    for (const entry of contextObjects()) patch(entry.obj, entry.label);
  }

  // La API puede aparecer despues (polyfills, bundles diferidos): reintentamos.
  patchAll();
  document.addEventListener('DOMContentLoaded', patchAll, { once: true });
  window.addEventListener('load', patchAll, { once: true });
  let retries = 0;
  const retryTimer = setInterval(() => {
    patchAll();
    if (++retries > 30) clearInterval(retryTimer); // ~15 s
  }, 500);

  // --- Descubrimiento y ejecucion -----------------------------------------

  async function snapshot() {
    patchAll();
    for (const entry of contextObjects()) {
      // Si la pagina registro tools antes de que pudieramos interceptar, aun
      // podemos leerlas si la implementacion las expone.
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

  async function executeTool(name, args) {
    const params = args && typeof args === 'object' ? args : {};
    const entry = registry.get(name);

    if (entry && entry.execute) {
      // Distintas implementaciones esperan `execute(args)` o
      // `execute({ name, arguments })`. Pasamos ambas formas a la vez.
      const payload = Object.assign({}, params);
      if (!('arguments' in payload)) payload.arguments = params;
      if (!('name' in payload)) payload.name = name;
      return entry.execute(payload);
    }

    for (const candidate of contextObjects()) {
      if (isFn(candidate.obj.callTool)) return candidate.obj.callTool(name, params);
      if (isFn(candidate.obj.executeTool)) return candidate.obj.executeTool(name, params);
    }

    throw new Error('La pagina no expone ninguna herramienta llamada "' + name + '".');
  }

  /** Deja el valor listo para structuredClone (postMessage). */
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
        reply(serializable(await executeTool(payload.name, payload.args)));
      } else {
        reply(null, 'Accion desconocida: ' + String(data.action));
      }
    } catch (err) {
      reply(null, String((err && err.message) || err));
    }
  });
})();
