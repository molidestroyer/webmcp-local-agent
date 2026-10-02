'use strict';

const test = require('node:test');
const assert = require('node:assert');
const G = require('../lib/agent-goal.js');

test('a goal is derived from the tool name when the model said nothing', () => {
  assert.strictEqual(G.goalFromTool('complete_booking'), 'Completing booking...');
  assert.strictEqual(G.goalFromTool('searchHotels'), 'Searching hotels...');
  assert.strictEqual(G.goalFromTool('get-todo-list'), 'Getting todo list...');
  assert.strictEqual(G.goalFromTool('wait'), 'Waiting for the page...');
  // An unknown verb is not guessed at.
  assert.strictEqual(G.goalFromTool('hotel_search'), 'Running hotel search...');
  assert.strictEqual(G.goalFromTool(''), '');
});

test('the goal from the model is its first sentence, short', () => {
  assert.strictEqual(G.goalFromText('I need to find hotels in Barcelona first. Then I will book one.'), 'I need to find hotels in Barcelona first');
  assert.strictEqual(
    G.goalFromText('Searching for the cheapest available hotel room in Barcelona for next weekend please'),
    'Searching for the cheapest available hotel room in Barcelona for...',
  );
  assert.ok(G.goalFromText('x '.repeat(40)).split(/\s+/).length <= G.MAX_WORDS);
});

test('anything that is not prose is ignored, so the tool label wins', () => {
  assert.strictEqual(G.goalFromText(''), '');
  assert.strictEqual(G.goalFromText(undefined), '');
  assert.strictEqual(G.goalFromText('{"a":1}'), '');
  assert.strictEqual(G.goalFromText('```js\nconst a = 1;\n```'), '');
  assert.strictEqual(G.goalFromText('12345 67890 !!!'), '');
});

test('markdown is stripped from the phrase', () => {
  assert.strictEqual(G.goalFromText('**Checking** the `cart` now.'), 'Checking the cart now');
});
