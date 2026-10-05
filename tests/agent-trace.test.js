'use strict';

const test = require('node:test');
const assert = require('node:assert');
const T = require('../lib/agent-trace.js');

test('a prompt is split into system, catalog, tools, history and tool results', () => {
  const system = 'x'.repeat(400) + 'c'.repeat(800); // 800 chars of it came from the catalog
  const parts = T.measurePrompt([
    { role: 'system', content: system },
    { role: 'user', content: 'u'.repeat(40) },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'a', arguments: {} } }] },
    { role: 'tool', content: 'r'.repeat(4000) },
  ], [{ type: 'function', function: { name: 'a', parameters: {} } }], 800);
  assert.strictEqual(parts.sys, 100);
  assert.strictEqual(parts.cat, 200);
  assert.strictEqual(parts.res, 1000);
  assert.ok(parts.hist > 10 && parts.tools > 5);
});

test('a reply is described by its calls or its words', () => {
  assert.strictEqual(T.describeReply({ content: 'Opening the form.', tool_calls: [{ function: { name: 'start_booking' } }] }),
    'tools: start_booking "Opening the form."');
  assert.strictEqual(T.describeReply({ content: '', tool_calls: [{ function: { name: 'a' } }, { function: { name: 'b' } }] }),
    'tools: a, b (no text)');
  assert.strictEqual(T.describeReply({ content: 'All done.' }), 'text "All done."');
  assert.strictEqual(T.describeReply({}), 'empty');
});

test('the trace is one header per turn and one line per model call', () => {
  const turns = T.appendTurn([], {
    at: '10:12', model: 'copilot:claude', request: 'Book the hotel', verdict: 'fail', nudges: 1, tools: 2,
    rounds: [
      { ms: 1200, usage: { input: 4100, output: 40, cached: 3000 }, parts: { sys: 900, cat: 500, tools: 1400, hist: 200, res: 0 }, reply: 'text "Opening"', choices: 1 },
      { ms: 800, nudge: true, usage: null, parts: { sys: 900, cat: 500, tools: 1400, hist: 260, res: 0 }, reply: 'tools: start_booking (no text)', choices: 2 },
    ],
  });
  const text = T.formatTrace(turns);
  const lines = text.split('\n');
  assert.match(lines[0], /^#1 10:12 copilot:claude "Book the hotel" -> fail \| 2 call\(s\), 1 nudge\(s\), 2 tool run\(s\) \| in 4\.1k \(cached 3k\) out 40$/);
  assert.match(lines[1], /^ {2}r1 1\.2s in 4\.1k\/3kc out 40 \[~sys 900 cat 500 tools 1\.4k hist 200 res 0\] -> text "Opening"$/);
  assert.match(lines[2], /^ {2}r2\* 0\.8s in \? out \? .* choices=2 -> tools: start_booking/);
});

test('the trace keeps the last turns only, numbered', () => {
  let turns = [];
  for (let i = 0; i < T.MAX_TURNS + 5; i++) turns = T.appendTurn(turns, { rounds: [] });
  assert.strictEqual(turns.length, T.MAX_TURNS);
  assert.strictEqual(turns[turns.length - 1].n, T.MAX_TURNS + 5);
});

test('a call cut by Stop is a line of its own, not a missing call', () => {
  const turns = T.appendTurn([], {
    at: '12:37', model: 'gemma4:e2b', request: 'Book', verdict: 'warn "Stopped by you"', nudges: 0, tools: 0,
    rounds: [{ ms: 12300, usage: null, parts: { sys: 600, cat: 650, tools: 460, hist: 270, res: 0 }, reply: 'stopped before the answer', choices: 1 }],
  });
  const lines = T.formatTrace(turns).split('\n');
  assert.match(lines[0], /\| 1 call\(s\) \(1 unanswered\), 0 nudge\(s\)/);
  assert.match(lines[1], /^ {2}r1 12\.3s in \? out \? .* -> stopped before the answer$/);
});
