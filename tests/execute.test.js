'use strict';

const test = require('node:test');
const assert = require('node:assert');
const S = require('../lib/webmcp-schema.js');

const PARSE_ERROR = "Failed to parse input string as JSON.";

function makeContext(options) {
  const calls = [];
  return {
    calls,
    getTools: async () => [{ name: 'createFeature' }],
    executeTool: async (tool, args) => {
      calls.push(args);
      if (options.wantsString && typeof args !== 'string') throw new TypeError(PARSE_ERROR);
      if (options.alwaysThrows) throw new Error(options.alwaysThrows);
      return 'ok';
    },
  };
}

test('an implementation taking an object gets the object', async () => {
  const context = makeContext({});
  const args = { title: 'x', priority: 'P2' };
  assert.strictEqual(await S.callExecuteTool(context, {}, args), 'ok');
  assert.strictEqual(context.calls.length, 1, 'no retry when the first form works');
  assert.strictEqual(context.calls[0], args, 'the object is passed through by reference');
});

test('an implementation taking a JSON string gets a JSON string', async () => {
  const context = makeContext({ wantsString: true });
  const args = { title: 'x', priority: 'P2' };
  assert.strictEqual(await S.callExecuteTool(context, {}, args), 'ok');
  assert.strictEqual(context.calls.length, 2, 'object first, then the string');
  assert.strictEqual(typeof context.calls[1], 'string');
  assert.deepStrictEqual(JSON.parse(context.calls[1]), args, 'nothing is lost in the retry');
});

test('the accepted form is remembered, so a page is probed once', async () => {
  const context = makeContext({ wantsString: true });
  await S.callExecuteTool(context, {}, { a: 1 });
  context.calls.length = 0;
  await S.callExecuteTool(context, {}, { a: 2 });
  assert.strictEqual(context.calls.length, 1, 'the second call skips the failing form');
  assert.strictEqual(typeof context.calls[0], 'string');
});

test('any other rejection propagates without a retry', async () => {
  // The retry exists because the platform rejects the arguments before the tool
  // runs. A failure from the tool itself must never be replayed.
  const context = makeContext({ alwaysThrows: 'Missing required fields: triggerType' });
  await assert.rejects(
    () => S.callExecuteTool(context, {}, { a: 1 }),
    /Missing required fields/
  );
  assert.strictEqual(context.calls.length, 1, 'a real failure must not run twice');
});

test('the parse error is not retried a second time once the style is known', async () => {
  const context = makeContext({});
  await S.callExecuteTool(context, {}, { a: 1 });      // learns 'object'
  context.executeTool = async () => { throw new TypeError(PARSE_ERROR); };
  await assert.rejects(() => S.callExecuteTool(context, {}, { a: 2 }), /Failed to parse/);
});

test('forgetArgumentStyle resets what was learned', async () => {
  const context = makeContext({ wantsString: true });
  await S.callExecuteTool(context, {}, { a: 1 });
  S.forgetArgumentStyle(context);
  context.calls.length = 0;
  await S.callExecuteTool(context, {}, { a: 2 });
  assert.strictEqual(context.calls.length, 2, 'probing starts over');
});

test('the retry also fires for the "input arguments" wording', async () => {
  // Chrome has phrased this two ways; both are the platform rejecting the
  // arguments before the tool runs.
  const context = {
    getTools: async () => [{ name: 't' }],
    executeTool: async (tool, args) => {
      if (typeof args !== 'string') {
        throw new TypeError(
          "Failed to execute 'executeTool' on 'ModelContext': Failed to parse input arguments."
        );
      }
      return 'ok';
    },
  };
  assert.strictEqual(await S.callExecuteTool(context, {}, { a: 1 }), 'ok');
});

test('when neither form works, both messages are reported', async () => {
  const context = {
    getTools: async () => [{ name: 't' }],
    executeTool: async (tool, args) => {
      throw new TypeError(typeof args === 'string'
        ? 'Failed to parse input arguments: still no'
        : 'Failed to parse input arguments');
    },
  };
  await assert.rejects(
    () => S.callExecuteTool(context, {}, { a: 1 }),
    (err) => {
      assert.match(err.message, /both argument forms/);
      assert.match(err.message, /as an object:/);
      assert.match(err.message, /as a JSON string: .*still no/);
      return true;
    }
  );
});

test('a tool that rejects on its own merits is never replayed', async () => {
  let calls = 0;
  const context = {
    getTools: async () => [{ name: 't' }],
    executeTool: async () => { calls++; throw new Error('Missing required fields: triggerType'); },
  };
  await assert.rejects(() => S.callExecuteTool(context, {}, { a: 1 }), /Missing required/);
  assert.strictEqual(calls, 1, 'a createFeature that half-failed must not run twice');
});

// --- Picking the right RegisteredTool -------------------------------------

test('the tool belonging to this window wins over a same-named one elsewhere', () => {
  const here = { name: 'createFeature', window: 'top', origin: 'https://app.test' };
  const framed = { name: 'createFeature', window: 'iframe', origin: 'https://app.test' };
  // Listing asks with fromOrigins, so getTools() can return both.
  assert.strictEqual(S.matchRegisteredTool([framed, here], 'createFeature', null, 'top'), here);
  assert.strictEqual(S.matchRegisteredTool([here, framed], 'createFeature', null, 'iframe'), framed);
});

test('without a window to match, origin still decides', () => {
  const a = { name: 't', origin: 'https://a.test' };
  const b = { name: 't', origin: 'https://b.test' };
  assert.strictEqual(S.matchRegisteredTool([a, b], 't', 'https://b.test', null), b);
});

test('a cached form that later stops working is retried the other way', async () => {
  let wantsString = true;
  const context = {
    getTools: async () => [{ name: 't' }],
    executeTool: async (tool, args) => {
      const isString = typeof args === 'string';
      if (wantsString !== isString) throw new TypeError('Failed to parse input arguments');
      return isString ? 'string-ok' : 'object-ok';
    },
  };

  assert.strictEqual(await S.callExecuteTool(context, {}, { a: 1 }), 'string-ok');
  // The page changes its mind; the cached answer must not become a dead end.
  wantsString = false;
  assert.strictEqual(await S.callExecuteTool(context, {}, { a: 1 }), 'object-ok');
});
