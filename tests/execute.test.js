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
