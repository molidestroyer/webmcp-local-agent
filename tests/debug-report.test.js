'use strict';

const test = require('node:test');
const assert = require('node:assert');
const DR = require('../lib/debug-report.js');

test('appendRecordingMeta prepends newest first and respects cap', () => {
  let list = [];
  for (let i = 1; i <= 5; i++) {
    list = DR.appendRecordingMeta(list, {
      id: `rec-${i}`,
      sessionId: 's1',
      stem: `clip-${i}`,
      storage: 'folder',
      sizeBytes: i * 1000,
    }, 3);
  }
  assert.strictEqual(list.length, 3);
  assert.deepStrictEqual(list.map((r) => r.stem), ['clip-5', 'clip-4', 'clip-3']);
});

test('summarizeSessionTokens and topTokenDrivers highlight heavy prompt components', () => {
  const turns = [
    {
      n: 1,
      nudges: 2,
      tools: 1,
      pageErrors: 1,
      rounds: [
        {
          ms: 1200,
          usage: { input: 2000, cached: 500, output: 150 },
          parts: { sys: 200, cat: 100, tools: 1200, hist: 100, res: 400 },
          reply: 'tools: search_location',
        },
        {
          ms: 800,
          usage: { input: 2500, cached: 1000, output: 100 },
          parts: { sys: 200, cat: 100, tools: 1200, hist: 200, res: 800 },
          reply: 'text "Done"',
        },
      ],
    },
  ];

  const { summary, ctxDrivers, drivers, hints } = DR.topTokenDrivers(turns);
  assert.strictEqual(summary.turnsCount, 1);
  assert.strictEqual(summary.roundsCount, 2);
  assert.strictEqual(summary.input, 4500);
  assert.strictEqual(summary.peakInput, 2500);
  assert.strictEqual(summary.lastInput, 2500);
  assert.strictEqual(summary.cached, 1500);
  assert.strictEqual(summary.output, 250);
  assert.strictEqual(summary.nudges, 2);
  assert.strictEqual(summary.pageErrors, 1);
  assert.strictEqual(drivers[0].key, 'tools');
  assert.strictEqual(ctxDrivers[0].key, 'tools');
  assert.ok(hints.some((h) => h.includes('WebMCP tool schemas')));
  assert.ok(hints.some((h) => h.includes('2 nudge(s)')));
  assert.ok(hints.some((h) => h.includes('1 page console error(s)')));
});

test('formatDebugMarkdown produces complete agent-ready Markdown report with tool name resolution and untrimmed mode', () => {
  const longOut = 'X'.repeat(5000);
  const md = DR.formatDebugMarkdown({
    session: {
      id: 'session-1',
      title: 'Hotel booking test',
      domain: 'example.com',
      url: 'https://example.com/book',
      messages: [
        { role: 'user', content: 'Book Paris hotel' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', function: { name: 'inspect_view' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: longOut },
        { role: 'assistant', content: 'Booked!' },
      ],
    },
    turns: [
      {
        n: 1,
        at: '2026-11-20 10:00',
        model: 'ollama:qwen3',
        userPrompt: 'Book Paris hotel',
        goal: 'Running inspect_view...',
        verdict: 'ok "Done"',
        nudges: 0,
        tools: 1,
        pageErrors: 0,
        rounds: [
          { ms: 900, usage: { input: 1000, output: 50 }, parts: { sys: 300, cat: 0, tools: 500, hist: 100, res: 100 }, reply: 'tools: book' },
        ],
        toolCalls: [
          { name: 'book', ok: true, ms: 120, args: { city: 'Paris' }, output: longOut },
        ],
      },
    ],
    consoleLogs: [
      { at: 1700000000000, level: 'error', text: 'Uncaught TypeError: x is null' },
    ],
    recordings: [
      { stem: '2026-clip', storage: 'folder', durationMs: 4200, sizeBytes: 51200, logText: '[+0.1s] [tool] book' },
    ],
    extensionLogs: [{ sessionId: 'session-1', at: 1700000000000, line: '[INFO] Extension ready' }],
    untrimmed: true,
  });

  assert.ok(md.includes('# WebMCP Debug Report: Hotel booking test'));
  assert.ok(md.includes('Context Window (`ctx`)'));
  assert.ok(md.includes('Cumulative Billed (1 calls)'));
  assert.ok(md.includes('**User Prompt**: Book Paris hotel'));
  assert.ok(md.includes('**Last Agent Goal**: Running inspect_view...'));
  assert.ok(md.includes('Tool result (`inspect_view`)'));
  assert.ok(md.includes(longOut));
  assert.ok(!md.includes('[truncated'));
  assert.ok(md.includes('## 6. Extension Logs (session)'));
});
