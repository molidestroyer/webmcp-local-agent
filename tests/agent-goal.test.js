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
  // A realistic sentence of 14 words is no longer cut.
  assert.strictEqual(
    G.goalFromText('Searching for the cheapest available hotel room in Barcelona for next weekend'),
    'Searching for the cheapest available hotel room in Barcelona for next weekend',
  );
  const long = 'please keep adding more and more words to this sentence until it clearly runs far past any sensible limit for a goal line';
  assert.strictEqual(G.goalFromText(long).split(/\s+/).length, G.MAX_WORDS);
  assert.ok(G.goalFromText(long).endsWith('...'));
  assert.strictEqual(G.goalFromText('one two three four', 2), 'one two...');
});

test('a wait explains itself from the step before it', () => {
  assert.strictEqual(G.goalForWait(5, 'complete_booking'), 'Waiting 5s for the page to update after complete booking...');
  assert.strictEqual(G.goalForWait(undefined, null), 'Waiting 5s for the page to settle...');
  assert.strictEqual(G.goalForWait(99, 'submitForm'), 'Waiting 30s for the page to update after submit form...');
});

test('what the model wrote next to the call is shown whole, not cut to a few words', () => {
  const said = 'The search returned three rooms, so I am opening the cheapest one to check its cancellation terms before booking.';
  assert.ok(said.split(/\s+/).length > G.MAX_WORDS);
  assert.strictEqual(G.goalFromModel(said), said);
  assert.strictEqual(G.goalFromModel('First line.\nSecond line, with **bold** text.'), 'First line. Second line, with bold text.');
});

test('model text has only a safety cap, cut at a word, and still ignores non-prose', () => {
  const huge = 'word '.repeat(300);
  const out = G.goalFromModel(huge);
  assert.ok(out.length <= G.MAX_MODEL_CHARS + 3 && out.endsWith('...'));
  assert.ok(!/\bwor\.\.\.$/.test(out));
  assert.strictEqual(G.goalFromModel('{"a":1}'), '');
  assert.strictEqual(G.goalFromModel(''), '');
});

test('pickGoal: the model first, then the wait reason, then the request, then the tool', () => {
  const base = { toolName: 'complete_booking', previousTool: 'search_hotels', request: 'Book a hotel in Barcelona for three nights. Pay by card.' };
  assert.strictEqual(pick({ ...base, content: 'Filling in the guest details now.' }), 'Filling in the guest details now.');
  // Reasoning is a fallback and stays a short first sentence; the visible text wins over it.
  assert.strictEqual(pick({ ...base, thinking: 'The form needs a surname before it can be submitted. More.' }), 'The form needs a surname before it can be submitted');
  assert.strictEqual(pick({ ...base, thinking: 'Reasoning text.', content: 'Visible reason.' }), 'Visible reason.');
  // No words from the model: the request, not an echo of the tool card.
  assert.strictEqual(pick(base), 'Book a hotel in Barcelona for three nights');
  assert.notStrictEqual(pick(base), G.goalFromTool('complete_booking'));
  assert.strictEqual(
    pick({ ...base, toolName: 'wait', toolArgs: { seconds: 10 } }),
    'Waiting 10s for the page to update after search hotels...',
  );
  // No request either: the tool label is the last resort.
  assert.strictEqual(pick({ toolName: 'complete_booking' }), 'Completing booking...');
});

function pick(input) { return G.pickGoal(input); }

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
