'use strict';

const test = require('node:test');
const assert = require('node:assert');
const R = require('../lib/turn-report.js');

const ok = (name, output = 'done') => ({ name, ok: true, output });
const bad = (name, output = 'boom') => ({ name, ok: false, output });

test('tool outcomes read the text, not only the transport', () => {
  assert.strictEqual(R.classifyTool(ok('a')), 'ok');
  assert.strictEqual(R.classifyTool(bad('a')), 'failed');
  assert.strictEqual(R.classifyTool(ok('a', 'Status: FAILED (quota)')), 'failed');
  assert.strictEqual(R.classifyTool(ok('a', 'Error: no such row')), 'failed');
  assert.strictEqual(R.classifyTool(ok('form', 'Filled 3 field(s); NOT submitted.')), 'unsubmitted');
  assert.strictEqual(R.classifyTool({ name: 'a', ok: false, note: 'STOPPED' }), 'stopped');
  assert.strictEqual(R.classifyTool({ name: 'a', ok: false, note: 'CANCELLED' }), 'cancelled');
});

test('a clean run is Done and counts only page tools', () => {
  const r = R.buildTurnReport({ end: 'answered', reply: 'Booked.', tools: [ok('wait'), ok('search'), ok('book')] });
  assert.strictEqual(r.level, 'ok');
  assert.strictEqual(r.title, 'Done');
  assert.deepStrictEqual(r.items, ['2 of 2 page tool call(s) succeeded.']);
});

test('page errors during the turn downgrade a success', () => {
  const r = R.buildTurnReport({ end: 'answered', reply: 'Done.', tools: [ok('save')],
    pageErrors: [{ level: 'error', text: 'Uncaught TypeError: x is undefined' }, { level: 'warn', text: 'deprecated' }] });
  assert.strictEqual(r.level, 'warn');
  assert.match(r.items.join('\n'), /1 page error\(s\) during the turn\. First: Uncaught TypeError/);
  assert.match(r.items.join('\n'), /1 page warning\(s\)/);
});

test('a failure the model recovered from is a warning; one it did not is a failure', () => {
  const recovered = R.buildTurnReport({ end: 'answered', reply: 'Saved.', tools: [bad('save'), ok('save')] });
  assert.strictEqual(recovered.level, 'warn');
  const lastFailed = R.buildTurnReport({ end: 'answered', reply: 'All done!', tools: [ok('search'), bad('save', 'quota exceeded')] });
  assert.strictEqual(lastFailed.level, 'fail');
  assert.match(lastFailed.items.join('\n'), /Failed: save — quota exceeded/);
  // The model saying "done" does not change the verdict.
  const unrecovered = R.buildTurnReport({ end: 'answered', reply: 'Done', tools: [bad('save'), ok('list')] });
  assert.strictEqual(unrecovered.level, 'fail');
});

test('a form left unsubmitted is flagged', () => {
  const r = R.buildTurnReport({ end: 'answered', reply: 'Booked!', tools: [ok('book', 'Filled 3 field(s); NOT submitted.')] });
  assert.strictEqual(r.level, 'warn');
  assert.match(r.items.join('\n'), /NOT submitted: book/);
});

test('how the loop ended', () => {
  assert.strictEqual(R.buildTurnReport({ end: 'stopped', tools: [] }).title, 'Stopped by you');
  const limit = R.buildTurnReport({ end: 'limit', limit: 100, tools: [ok('a')] });
  assert.strictEqual(limit.level, 'fail');
  assert.match(limit.items.join('\n'), /round limit \(100\)/);
  assert.strictEqual(R.buildTurnReport({ end: 'provider-error' }).level, 'fail');
  assert.strictEqual(R.buildTurnReport({ end: 'answered', reply: 'Which date do you want?', tools: [ok('a')] }).level, 'info');
});

test('an answer with no page tool says nothing backs it', () => {
  const r = R.buildTurnReport({ end: 'answered', reply: 'I created the contact.', tools: [] });
  assert.strictEqual(r.level, 'info');
  assert.match(r.items.join('\n'), /No page tool ran/);
});

test('a question never hides a problem: the worst issue is the title, the question a suffix', () => {
  // The real hotel run: the form was filled, not sent, and the model asked the user to confirm.
  const r = R.buildTurnReport({ end: 'answered', reply: '¿Quieres que pulse Confirm Reservation?',
    tools: [ok('search_location'), ok('start_booking'), ok('complete_booking', 'Fields filled in but NOT submitted: this form waits for the user.')] });
  assert.strictEqual(r.level, 'warn');
  assert.strictEqual(r.title, 'Not submitted: complete_booking · waiting for you');

  const errs = R.buildTurnReport({ end: 'answered', reply: 'Which date?', tools: [ok('a')],
    pageErrors: [{ level: 'error', text: 'x' }, { level: 'error', text: 'y' }] });
  assert.strictEqual(errs.title, '2 page error(s) · waiting for you');
});

test('a failure names the tool and the reason in the title', () => {
  const r = R.buildTurnReport({ end: 'answered', reply: 'Done', tools: [ok('search'), bad('save', 'Error: 429 rate limit exceeded, retry in 30s')] });
  assert.strictEqual(r.level, 'fail');
  assert.strictEqual(r.title, 'Failed: save — 429 rate limit exceeded, retry in 30s');

  const two = R.buildTurnReport({ end: 'answered', reply: 'Done', tools: [bad('a', 'x'), bad('b', 'y'), ok('c')] });
  assert.strictEqual(two.title, 'Failed: a — x (+1 more)');

  const recovered = R.buildTurnReport({ end: 'answered', reply: 'Saved.', tools: [bad('save'), ok('save')] });
  assert.strictEqual(recovered.title, 'Recovered from 1 failure(s)');

  // Severity, not order: a failure outranks an unsubmitted form found earlier.
  const mixed = R.buildTurnReport({ end: 'answered', reply: 'Done', tools: [ok('f', 'NOT submitted'), bad('pay', 'card declined')] });
  assert.strictEqual(mixed.level, 'fail');
  assert.strictEqual(mixed.title, 'Failed: pay — card declined (+1 more)');
});

test('the round limit and Stop keep their own titles', () => {
  assert.strictEqual(R.buildTurnReport({ end: 'limit', limit: 100, tools: [ok('a')] }).title, 'Round limit reached (100)');
  const stopped = R.buildTurnReport({ end: 'stopped', tools: [{ name: 'wait', ok: false, note: 'STOPPED' }] });
  assert.strictEqual(stopped.title, 'Stopped by you');
  assert.strictEqual(stopped.level, 'warn');
});
