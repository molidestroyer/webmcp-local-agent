'use strict';

/**
 * page-hook.js runs in a page's MAIN world, which is why it went untested while
 * bug after bug landed in it. It only needs a handful of DOM surfaces, so a
 * small shim plus `vm` exercises the real file — discovery, fromOrigins,
 * toolchange and the postMessage protocol included.
 */

const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const HOOK_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'page-hook.js'), 'utf8');
const LIB_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'lib', 'webmcp-schema.js'), 'utf8');

const TO_PAGE = 'webmcp-local-agent:to-page';
const FROM_PAGE = 'webmcp-local-agent:from-page';

function fakeForm(toolname) {
  return { getAttribute: (name) => (name === 'toolname' ? toolname : null) };
}

/** Boots page-hook.js against a minimal document/window. */
function bootHook({ modelContext = null, forms = [], readyState = 'loading' } = {}) {
  const windowTarget = new EventTarget();
  const documentTarget = new EventTarget();
  const formList = forms.slice();

  const documentShim = {
    readyState,
    documentElement: {},
    modelContext,
    querySelectorAll: (selector) => (selector === 'form[toolname]' ? formList.slice() : []),
    addEventListener: documentTarget.addEventListener.bind(documentTarget),
    removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
    dispatchEvent: documentTarget.dispatchEvent.bind(documentTarget),
  };

  const windowShim = {
    addEventListener: windowTarget.addEventListener.bind(windowTarget),
    removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
    dispatchEvent: windowTarget.dispatchEvent.bind(windowTarget),
    postMessage(data) {
      // Delivered asynchronously, with source === window, as a page would.
      setTimeout(() => {
        const event = new Event('message');
        event.data = data;
        event.source = windowShim;
        windowTarget.dispatchEvent(event);
      }, 0);
    },
  };

  const context = {
    window: windowShim,
    document: documentShim,
    navigator: {},
    Event,
    EventTarget,
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    JSON,
    Promise,
    Object,
    Array,
    Map,
    Set,
    WeakSet,
    WeakMap,
    String,
    Number,
    Boolean,
    TypeError,
    Error,
    SyntaxError,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(LIB_SOURCE, context);
  // In a real page `window` *is* the global, so the library the hook looks for
  // on `window` is the one the library published on `globalThis`. The shim has
  // to reproduce that, not the vm's split between the two.
  windowShim.__WebMCPLocalAgentSchema = context.__WebMCPLocalAgentSchema;
  vm.runInContext(HOOK_SOURCE, context);

  let seq = 0;
  function ask(action, payload, timeoutMs = 1000) {
    return new Promise((resolve, reject) => {
      const id = 'test-' + (++seq);
      const timer = setTimeout(() => reject(new Error('the hook never answered ' + action)), timeoutMs);
      const onMessage = (event) => {
        const data = event.data;
        if (!data || data.channel !== FROM_PAGE || data.id !== id) return;
        clearTimeout(timer);
        windowTarget.removeEventListener('message', onMessage);
        resolve({ result: data.result, error: data.error });
      };
      windowTarget.addEventListener('message', onMessage);
      windowShim.postMessage({ channel: TO_PAGE, id, action, payload });
    });
  }

  function onToolsChanged(handler) {
    windowTarget.addEventListener('message', (event) => {
      const data = event.data;
      if (data && data.channel === FROM_PAGE && data.event === 'tools-changed') handler();
    });
  }

  return { ask, onToolsChanged, windowShim, documentShim, formList };
}

const named = (listing) => listing.tools.map((tool) => tool.name).sort();

// --- Discovery ------------------------------------------------------------

test('reads tools from document.modelContext.getTools()', async () => {
  const hook = bootHook({
    modelContext: {
      getTools: async () => [
        { name: 'createFeature', description: 'x', origin: 'https://app.test', inputSchema: '{"type":"object","properties":{"a":{"type":"string"}}}' },
      ],
      executeTool: async () => 'ok',
    },
  });
  const { result } = await hook.ask('list', null);
  assert.deepStrictEqual(named(result), ['createFeature']);
  // The serialized schema arrives parsed.
  assert.deepStrictEqual(result.tools[0].inputSchema.properties.a, { type: 'string' });
});

test('a page with no WebMCP surface answers an empty listing, not an error', async () => {
  const hook = bootHook({});
  const { result, error } = await hook.ask('list', null);
  assert.strictEqual(error, null);
  assert.deepStrictEqual(result.tools, []);
});

// --- fromOrigins ----------------------------------------------------------

test('getTools() is asked for the origins of the other frames', async () => {
  const seen = [];
  const hook = bootHook({
    modelContext: {
      getTools: async (options) => {
        seen.push(options);
        const own = [{ name: 'topTool', origin: 'https://app.test', inputSchema: '{}' }];
        const framed = options && (options.fromOrigins || []).includes('https://frame.test')
          ? [{ name: 'iframeTool', origin: 'https://frame.test', inputSchema: '{}' }]
          : [];
        return [...own, ...framed];
      },
      executeTool: async () => 'ok',
    },
  });

  const plain = await hook.ask('list', null);
  assert.deepStrictEqual(named(plain.result), ['topTool'], 'without origins, only this document');

  const framed = await hook.ask('list', { fromOrigins: ['https://frame.test'] });
  assert.deepStrictEqual(
    named(framed.result),
    ['iframeTool', 'topTool'],
    'a tool registered in a subframe is invisible unless its origin is named'
  );
  // Serialized first: objects built inside the vm carry that realm's
  // prototypes, which deepStrictEqual refuses to match.
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(seen[seen.length - 1])),
    { fromOrigins: ['https://frame.test'] }
  );
});

test('an implementation whose getTools() takes no options still works', async () => {
  const hook = bootHook({
    modelContext: {
      getTools: async (options) => {
        if (options !== undefined) throw new TypeError('takes no arguments');
        return [{ name: 'oldStyle', origin: null, inputSchema: '{}' }];
      },
      executeTool: async () => 'ok',
    },
  });
  const { result } = await hook.ask('list', { fromOrigins: ['https://frame.test'] });
  assert.deepStrictEqual(named(result), ['oldStyle'], 'falls back instead of losing the listing');
});

// --- toolchange -----------------------------------------------------------

test('the native toolchange event triggers a tools-changed notification', async () => {
  const context = new EventTarget();
  context.getTools = async () => [];
  context.executeTool = async () => 'ok';

  const hook = bootHook({ modelContext: context });
  await hook.ask('list', null); // let the hook attach its listeners

  const changed = new Promise((resolve) => hook.onToolsChanged(resolve));
  context.dispatchEvent(new Event('toolchange'));
  await changed;
});

test('toolchange fired at the global object is heard too', async () => {
  const hook = bootHook({
    modelContext: { getTools: async () => [], executeTool: async () => 'ok' },
  });
  await hook.ask('list', null);

  const changed = new Promise((resolve) => hook.onToolsChanged(resolve));
  hook.windowShim.dispatchEvent(new Event('toolchange'));
  await changed;
});

// --- Declarative tools ----------------------------------------------------

test('a declarative tool is labelled from the markup, not guessed', async () => {
  const hook = bootHook({
    modelContext: {
      getTools: async () => [{ name: 'createFeature', origin: 'https://app.test', inputSchema: '{}' }],
      executeTool: async () => 'ok',
    },
    forms: [fakeForm('createFeature')],
  });
  const { result } = await hook.ask('list', null);
  assert.strictEqual(result.tools[0].registration, 'declarative');
  assert.strictEqual(result.formsInDom, 1);
});

test('a script registration survives alongside a declarative one', async () => {
  const modelContext = {
    tools: [],
    provideContext(config) { this.tools = config.tools || []; },
    getTools: async () => [{ name: 'createFeature', origin: 'https://app.test', inputSchema: '{}' }],
    executeTool: async () => 'ok',
  };
  const hook = bootHook({ modelContext, forms: [fakeForm('createFeature')] });

  await hook.ask('list', null);
  modelContext.provideContext({ tools: [{ name: 'scriptTool', description: 's', execute: () => 'x' }] });
  const { result } = await hook.ask('list', null);

  assert.deepStrictEqual(
    named(result),
    ['createFeature', 'scriptTool'],
    'provideContext() must not take the declarative tool with it'
  );
});

// --- Errors are reported --------------------------------------------------

test('a throwing getTools() is reported instead of looking like an empty page', async () => {
  const hook = bootHook({
    modelContext: {
      getTools: async () => { throw new Error('boom'); },
      executeTool: async () => 'ok',
    },
  });
  const { result } = await hook.ask('list', null);
  assert.deepStrictEqual(result.tools, []);
  assert.strictEqual(result.errors.length, 1);
  assert.match(result.errors[0], /getTools: boom/);
});

// --- Execution ------------------------------------------------------------

test('execution hands over the live RegisteredTool object', async () => {
  const live = { name: 'createFeature', origin: 'https://app.test', inputSchema: '{}' };
  let received = null;
  const hook = bootHook({
    modelContext: {
      getTools: async () => [live],
      executeTool: async (tool, args) => {
        if (typeof tool === 'string') throw new TypeError("not of type 'RegisteredTool'");
        received = { tool, args };
        return 'done';
      },
    },
  });
  const { result, error } = await hook.ask('execute', { name: 'createFeature', args: { a: 1 }, origin: 'https://app.test' });
  assert.strictEqual(error, null);
  assert.strictEqual(result, 'done');
  assert.strictEqual(received.tool.name, 'createFeature');
  assert.deepStrictEqual(received.args, { a: 1 });
});

test('an unknown tool reports why', async () => {
  const hook = bootHook({
    modelContext: { getTools: async () => [], executeTool: async () => 'ok' },
  });
  const { error } = await hook.ask('execute', { name: 'nope', args: {} });
  assert.match(error, /no longer registered/);
});
