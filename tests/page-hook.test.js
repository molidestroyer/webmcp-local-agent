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
function bootHook({ modelContext = null, forms = [], readyState = 'loading', console: consoleShim } = {}) {
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
    ...(consoleShim ? { console: consoleShim } : {}),
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
    AbortController,
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

test('a tool removed from the live listing is not retained across an SPA route change', async () => {
  let liveTools = [{ name: 'routeTool', origin: 'https://app.test', inputSchema: '{}' }];
  const hook = bootHook({
    modelContext: {
      getTools: async () => liveTools,
      executeTool: async () => 'ok',
    },
  });

  const beforeNavigation = await hook.ask('list', null);
  assert.deepStrictEqual(named(beforeNavigation.result), ['routeTool']);

  // The same document and ModelContext survive an SPA navigation, but the
  // platform's current tool set is now empty.
  liveTools = [];
  const afterNavigation = await hook.ask('list', null);
  assert.deepStrictEqual(named(afterNavigation.result), []);
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

// --- Console capture --------------------------------------------------------

function consoleEvents(hook) {
  const seen = [];
  hook.windowShim.addEventListener('message', (event) => {
    const data = event.data;
    if (data && data.channel === FROM_PAGE && data.event === 'console') seen.push(data.entry);
  });
  return seen;
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test('console capture is off until asked, and leaves console untouched', async () => {
  const calls = [];
  const fake = { error: (...a) => calls.push(a), warn: () => {} };
  const original = fake.error;
  const hook = bootHook({ console: fake });
  const seen = consoleEvents(hook);
  assert.strictEqual(fake.error, original);
  fake.error('before');
  await tick();
  assert.deepStrictEqual(seen, []);
});

test('console capture reports errors and warnings, still calls the real console, and restores it', async () => {
  const calls = [];
  const fake = { error: (...a) => calls.push(['error', ...a]), warn: (...a) => calls.push(['warn', ...a]) };
  const original = fake.error;
  const hook = bootHook({ console: fake });
  const seen = consoleEvents(hook);
  await hook.ask('console-capture', { enabled: true });

  fake.error('boom', { id: 3 });
  fake.warn('careful');
  await tick();
  assert.deepStrictEqual(seen.map((e) => [e.level, e.text]), [['error', 'boom {"id":3}'], ['warn', 'careful']]);
  assert.strictEqual(calls.length, 2);

  await hook.ask('console-capture', { enabled: false });
  assert.strictEqual(fake.error, original);
  fake.error('after');
  await tick();
  assert.strictEqual(seen.length, 2);
});

test('console capture reports uncaught errors, rejections and failed resources', async () => {
  const hook = bootHook({ console: { error() {}, warn() {} } });
  const seen = consoleEvents(hook);
  await hook.ask('console-capture', { enabled: true });
  const fire = (type, props) => {
    const event = new Event(type);
    for (const [key, value] of Object.entries(props)) Object.defineProperty(event, key, { value });
    hook.windowShim.dispatchEvent(event);
  };
  fire('error', { error: new Error('kaput'), filename: 'app.js', lineno: 7 });
  fire('unhandledrejection', { reason: 'nope' });
  fire('error', { target: { tagName: 'IMG', src: 'https://x.test/a.png' } });
  await tick();
  assert.match(seen[0].text, /^Uncaught .*kaput[\s\S]*\(app\.js:7\)$/);
  assert.strictEqual(seen[1].text, 'Unhandled promise rejection: nope');
  assert.strictEqual(seen[2].text, 'Failed to load <img> https://x.test/a.png');
});

// --- Unregistering with an AbortSignal --------------------------------------

test('a tool registered with { signal } disappears when the signal aborts, even without getTools()', async () => {
  // A polyfill shaped like Google's use-webmcp-tool expects: registerTool only.
  const hook = bootHook({ modelContext: { registerTool() {} } });
  const first = new AbortController();
  hook.documentShim.modelContext.registerTool({ name: 'start_booking', execute: () => 'ok' }, { signal: first.signal });
  assert.deepStrictEqual(named((await hook.ask('list', null)).result), ['start_booking']);

  // React re-registers: the old registration is aborted around the new one, in either order.
  const second = new AbortController();
  hook.documentShim.modelContext.registerTool({ name: 'start_booking', execute: () => 'ok' }, { signal: second.signal });
  first.abort();
  assert.deepStrictEqual(named((await hook.ask('list', null)).result), ['start_booking'], 'the newer registration survives');

  // Route change: unmount aborts it for good.
  second.abort();
  assert.deepStrictEqual(named((await hook.ask('list', null)).result), []);

  const gone = new AbortController();
  gone.abort();
  hook.documentShim.modelContext.registerTool({ name: 'late', execute: () => 'ok' }, { signal: gone.signal });
  assert.deepStrictEqual(named((await hook.ask('list', null)).result), [], 'an already-aborted signal registers nothing');
});

// --- Declarative forms ------------------------------------------------------

/** A field whose value lives behind a prototype setter, the way React's tracker sees it. */
class TrackedInput {
  constructor(name) { this._name = name; this._value = ''; this.type = 'text'; this.viaSetter = 0; }
  getAttribute(attr) { return attr === 'name' ? this._name : null; }
  get value() { return this._value; }
  set value(v) { this._value = v; this.viaSetter++; }
  dispatchEvent() { return true; }
}

function bookingForm({ autosubmit = null } = {}) {
  const fields = [new TrackedInput('firstName'), new TrackedInput('email')];
  const form = {
    isConnected: true,
    submits: 0,
    fields,
    getAttribute: (name) => (name === 'toolname' ? 'complete_booking' : name === 'toolautosubmit' ? autosubmit : null),
    hasAttribute: (name) => name === 'toolautosubmit' && autosubmit !== null,
    querySelectorAll: (selector) => (/input/.test(selector) ? fields : []),
    querySelector: () => null,
    requestSubmit() { this.submits++; this.isConnected = false; }, // the page swaps in a confirmation
  };
  return form;
}

test('a declarative form that waits for review is filled, not submitted, and says so', async () => {
  const form = bookingForm();
  const hook = bootHook({ forms: [form] });
  const { result } = await hook.ask('execute', { name: 'complete_booking', args: { firstName: 'Carlos', email: 'c@x.test' } });
  assert.strictEqual(form.submits, 0);
  assert.strictEqual(result.submitted, false);
  assert.match(result.message, /NOT submitted/);
  // Through the prototype setter, so frameworks that track values see the change.
  assert.strictEqual(form.fields[0].value, 'Carlos');
  assert.strictEqual(form.fields[0].viaSetter, 1);
});

test('the E2E setting, or toolautosubmit, submits the form and reports what the page did', async () => {
  const testing = bookingForm();
  let hook = bootHook({ forms: [testing] });
  let { result } = await hook.ask('execute', { name: 'complete_booking', args: { firstName: 'Carlos' }, submitForms: true }, 3000);
  assert.strictEqual(testing.submits, 1);
  assert.strictEqual(result.submitted, true);
  assert.match(result.message, /replaced it/);

  const declared = bookingForm({ autosubmit: '' });
  hook = bootHook({ forms: [declared] });
  ({ result } = await hook.ask('execute', { name: 'complete_booking', args: {} }, 3000));
  assert.strictEqual(declared.submits, 1);

  const reviewOnly = bookingForm({ autosubmit: 'false' });
  hook = bootHook({ forms: [reviewOnly] });
  ({ result } = await hook.ask('execute', { name: 'complete_booking', args: {} }, 3000));
  assert.strictEqual(reviewOnly.submits, 0, 'toolautosubmit="false" means review, not submit');
});
