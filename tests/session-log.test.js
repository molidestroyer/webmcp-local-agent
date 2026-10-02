'use strict';

const test = require('node:test');
const assert = require('node:assert');
const SL = require('../lib/session-log.js');

const T0 = Date.UTC(2026, 9, 2, 10, 0, 0);
const log = (lines) => ({ startedAt: T0, url: 'https://app.test/', lines });

test('a tool line carries its full arguments and, underneath, its result', () => {
  const entry = SL.toolEntry({
    name: 'complete_booking',
    args: { firstName: 'Carlos', lastName: 'Ruiz', email: 'carlos@example.com', nights: 3 },
    ok: true,
    output: '{"confirmationId":"HB-7821", "status": "confirmed", "success": true}',
    ms: 2.6,
  });
  assert.strictEqual(
    entry.text,
    'complete_booking({"firstName":"Carlos","lastName":"Ruiz","email":"carlos@example.com","nights":3}) -> ok in 3 ms',
  );
  // JSON results are compacted, never cut.
  assert.strictEqual(entry.detail, 'Result: {"confirmationId":"HB-7821","status":"confirmed","success":true}');
});

test('the formatted file shows the result indented under the call', () => {
  const entry = SL.toolEntry({ name: 'ping', args: {}, ok: true, output: 'pong', ms: 1 });
  const text = SL.formatSessionLog(
    log([{ t: T0 + 30100, kind: 'tool', text: entry.text, detail: entry.detail }]),
    T0 + 40000,
  );
  assert.match(text, /^\[\+  30\.1s\] \[tool\] ping\(\{\}\) -> ok in 1 ms\n {10}Result: pong$/m);
});

test('a failed tool logs the error and says FAILED', () => {
  const entry = SL.toolEntry({ name: 'book', args: { id: 1 }, ok: false, output: 'Room 4 is not available', ms: 12 });
  assert.strictEqual(entry.text, 'book({"id":1}) -> FAILED in 12 ms');
  assert.strictEqual(entry.detail, 'Error: Room 4 is not available');
});

test('built-in and refused calls are traced the same way', () => {
  const wait = SL.toolEntry({ name: 'wait', args: { seconds: 5 }, ok: true, output: 'Waited 5 second(s).', ms: 5003 });
  assert.match(wait.text, /^wait\(\{"seconds":5\}\) -> ok in 5003 ms$/);
  const cancelled = SL.toolEntry({ name: 'delete_all', args: {}, ok: false, output: 'The user cancelled this tool call.', note: 'CANCELLED' });
  assert.strictEqual(cancelled.text, 'delete_all({}) -> CANCELLED');
});

test('a chat message is kept whole, line breaks included', () => {
  const message = 'Book a hotel:\n- Barcelona\n- 3 nights\n' + 'x'.repeat(1500);
  const text = SL.formatSessionLog(
    log([{ t: T0 + 1000, kind: 'chat', text: 'User: ' + SL.clip(message, SL.LIMITS.chat) }]),
    T0 + 2000,
  );
  assert.ok(text.includes('x'.repeat(1500)));
  assert.match(text, /\[chat\] User: Book a hotel:\n {10}- Barcelona\n {10}- 3 nights\n/);
  assert.ok(!text.includes('truncated'));
});

test('a cut says how much was dropped', () => {
  const clipped = SL.clip('a'.repeat(4010), SL.LIMITS.chat);
  assert.match(clipped, /\.\.\. \[truncated 10 chars\]$/);
  assert.strictEqual(SL.clip('short', 10), 'short');
});

test('entries are ordered by time and console errors are counted', () => {
  const text = SL.formatSessionLog(
    log([
      { t: T0 + 5000, kind: 'error', text: 'Uncaught TypeError: x' },
      { t: T0 + 1000, kind: 'internal', text: 'settleTools: settled after 250 ms, 3 -> 4 tool(s)' },
    ]),
    T0 + 9000,
  );
  assert.ok(text.indexOf('[internal]') < text.indexOf('[error]'));
  assert.match(text, /Page console errors: 1/);
  assert.match(SL.formatSessionLog(log([]), T0), /nothing was logged/);
});
