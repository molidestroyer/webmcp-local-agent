/**
 * WebMCP Local Agent - lib/session-log.js (side panel + node)
 *
 * Formats the .log saved next to a recording. Pure, so the shape of the file is tested:
 * a log is only useful if it keeps what was actually said and returned, so nothing is
 * cut at a few characters; the caps below exist only to keep a runaway payload from
 * producing a huge file, and a cut always says how much was dropped.
 */
(function (root, factory) {
  const api = factory();
  root.__WebMCPSessionLog = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LIMITS = { chat: 4000, args: 4000, result: 8000 };
  const INDENT = ' '.repeat(10);

  function clip(text, max) {
    const value = String(text === undefined || text === null ? '' : text);
    if (value.length <= max) return value;
    return value.slice(0, max) + ` ... [truncated ${value.length - max} chars]`;
  }

  /** Tool output is usually JSON text; compact it so one result stays one line. */
  function serializeResult(output) {
    const text = String(output === undefined || output === null ? '' : output).trim();
    if (!text) return '(empty)';
    if (text[0] === '{' || text[0] === '[') {
      try {
        return clip(JSON.stringify(JSON.parse(text)), LIMITS.result);
      } catch (_) { /* not JSON after all: keep it verbatim */ }
    }
    return clip(text, LIMITS.result);
  }

  function stringifyArgs(args) {
    try {
      const json = JSON.stringify(args === undefined ? {} : args);
      return clip(json === undefined ? '{}' : json, LIMITS.args);
    } catch (_) {
      return '[unserializable arguments]';
    }
  }

  /**
   * One line per tool call, whatever ran it: page tools, the built-in `wait`, calls to a
   * tool that does not exist, calls the user cancelled. `output` is the result text on
   * success and the error message on failure.
   */
  function toolEntry({ name, args, ok, output, ms, note }) {
    const timing = typeof ms === 'number' ? ` in ${Math.round(ms)} ms` : '';
    const status = note || (ok ? 'ok' : 'FAILED');
    return {
      text: `${name}(${stringifyArgs(args)}) -> ${status}${timing}`,
      detail: `${ok ? 'Result' : 'Error'}: ${ok ? serializeResult(output) : clip(output, LIMITS.result)}`,
    };
  }

  function formatEntry(line, startedAt) {
    const offset = '+' + ((line.t - startedAt) / 1000).toFixed(1).padStart(6, ' ') + 's';
    const [first, ...rest] = String(line.text).split('\n');
    const out = [`[${offset}] [${line.kind}] ${first}`];
    for (const more of rest) out.push(INDENT + more);
    if (line.detail) {
      for (const more of String(line.detail).split('\n')) out.push(INDENT + more);
    }
    return out.join('\n');
  }

  function formatSessionLog(log, endedAt) {
    const errors = log.lines.filter((l) => l.kind === 'error').length;
    const head = [
      'WebMCP Local Agent - session log',
      'Started: ' + new Date(log.startedAt).toISOString(),
      'Ended:   ' + new Date(endedAt).toISOString(),
      'Page:    ' + (log.url || '(unknown)'),
      'Page console errors: ' + errors,
      '',
    ];
    const body = log.lines
      .slice()
      .sort((a, b) => a.t - b.t)
      .map((l) => formatEntry(l, log.startedAt));
    if (!body.length) body.push('(nothing was logged during the session)');
    return head.concat(body).join('\n') + '\n';
  }

  return { LIMITS, clip, serializeResult, toolEntry, formatSessionLog };
});
