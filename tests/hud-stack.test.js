'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createHudStack } = require('../virtual-cursor.js');

test('a tool that resolves in milliseconds still stays on screen for the minimum', () => {
  const stack = createHudStack({ minVisibleMs: 2800, okLingerMs: 1500, failLingerMs: 3000 });
  stack.add('a', 1000);
  const stay = stack.finish('a', true, 1003); // done after 3 ms
  assert.strictEqual(1003 + stay, 1000 + 2800);
});

test('a slow tool keeps its card until it ends, then lingers', () => {
  const stack = createHudStack({ minVisibleMs: 2800, okLingerMs: 1500, failLingerMs: 3000 });
  stack.add('a', 0);
  assert.strictEqual(stack.finish('a', true, 10000), 1500);
  stack.add('b', 0);
  assert.strictEqual(stack.finish('b', false, 10000), 3000);
});

test('a failure never leaves sooner than a success would', () => {
  const stack = createHudStack();
  stack.add('ok', 0);
  stack.add('bad', 0);
  assert.ok(stack.finish('bad', false, 5) >= stack.finish('ok', true, 5));
});

test('at most maxVisible cards: the oldest finished one goes first', () => {
  const stack = createHudStack({ maxVisible: 4 });
  for (const id of ['1', '2', '3', '4']) stack.add(id, 0);
  stack.finish('2', true, 1); // 2 is done; 1 is still running
  assert.deepStrictEqual(stack.add('5', 2), ['2']);
  assert.deepStrictEqual(stack.ids(), ['1', '3', '4', '5']);
});

test('when everything is still running the oldest goes, never the new card', () => {
  const stack = createHudStack({ maxVisible: 3 });
  for (const id of ['1', '2', '3']) stack.add(id, 0);
  assert.deepStrictEqual(stack.add('4', 1), ['1']);
  assert.ok(stack.ids().includes('4'));
});

test('a burst of actions never exceeds the limit', () => {
  const stack = createHudStack({ maxVisible: 4 });
  for (let i = 0; i < 10; i++) {
    stack.add(String(i), i);
    assert.ok(stack.size() <= 4);
  }
  assert.deepStrictEqual(stack.ids(), ['6', '7', '8', '9']);
});

test('finishing an unknown or removed card is harmless', () => {
  const stack = createHudStack();
  assert.strictEqual(stack.finish('nope', true, 0), null);
  stack.add('a', 0);
  assert.strictEqual(stack.remove('a'), true);
  assert.strictEqual(stack.remove('a'), false);
  assert.strictEqual(stack.finish('a', true, 5), null);
});
