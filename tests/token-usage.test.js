'use strict';

const test = require('node:test');
const assert = require('node:assert');
const U = require('../lib/token-usage.js');

test('Ollama usage comes from the final chunk counters', () => {
  assert.deepStrictEqual(U.fromOllama({ done: true, prompt_eval_count: 1200, eval_count: 80 }),
    { input: 1200, output: 80, cached: null });
  // Intermediate chunks carry no counters: that is "not reported", not zero.
  assert.strictEqual(U.fromOllama({ message: { content: 'hi' } }), null);
  assert.strictEqual(U.fromOllama(null), null);
});

test('OpenAI-shaped usage keeps cached tokens apart, and only when reported', () => {
  assert.deepStrictEqual(U.fromOpenAI({
    prompt_tokens: 1420, completion_tokens: 85, total_tokens: 1505,
    prompt_tokens_details: { cached_tokens: 1024 },
  }), { input: 1420, output: 85, cached: 1024 });
  assert.deepStrictEqual(U.fromOpenAI({ prompt_tokens: 10, completion_tokens: 2 }),
    { input: 10, output: 2, cached: null });
  assert.strictEqual(U.fromOpenAI(undefined), null);
  assert.strictEqual(U.fromOpenAI({}), null);
});

test('a turn adds its calls and says when the provider reported nothing', () => {
  const turn = U.emptyTurn();
  assert.strictEqual(U.formatTurn(turn), '');
  U.addCall(turn, null);
  assert.strictEqual(U.formatTurn(turn), 'Tokens not reported by the provider · 1 model call');

  U.addCall(turn, { input: 2000, output: 120, cached: 1500 });
  U.addCall(turn, { input: 1400, output: 160, cached: null });
  assert.strictEqual(U.formatTurn(turn), '3.4k in (1.5k cached) · 280 out · 3 model calls (1 without usage)');
});

test('compact numbers', () => {
  assert.strictEqual(U.compact(999), '999');
  assert.strictEqual(U.compact(1000), '1k');
  assert.strictEqual(U.compact(12345), '12k');
  assert.strictEqual(U.compact(2500000), '2.5M');
});
