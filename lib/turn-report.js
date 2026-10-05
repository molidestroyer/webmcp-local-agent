/**
 * WebMCP Local Agent - lib/turn-report.js (side panel + node)
 *
 * The verdict shown under each agent turn, computed from what actually happened (tool
 * outcomes, how the loop ended, errors the page logged meanwhile) and never from what the
 * model says about itself. Costs no request: it reads data the panel already has.
 */
(function (root, factory) {
  const api = factory();
  root.__WebMCPTurnReport = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_DETAIL = 160;

  function clip(text, max) {
    const flat = String(text || '').replace(/\s+/g, ' ').trim();
    return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
  }

  /** Same test the nudge uses: a question near the end means the model is waiting on the user. */
  function endsWithQuestion(text) {
    return /[?¿]/.test(String(text || '').trim().slice(-240));
  }

  /**
   * What one tool call came to. `ok` is the transport (did the call return); the text is
   * read too, because a tool can return normally and still say it failed, and a form can
   * be filled without being sent.
   */
  function classifyTool({ ok, note, output }) {
    if (note === 'STOPPED') return 'stopped';
    if (note === 'CANCELLED') return 'cancelled';
    if (!ok) return 'failed';
    const text = String(output || '');
    if (/^Error:/.test(text) || /\b(FAILED|ERROR)\b/.test(text)) return 'failed';
    if (/\bNOT submitted\b/i.test(text)) return 'unsubmitted';
    return 'ok';
  }

  /**
   * @param {object} turn
   *   end: 'answered' | 'stopped' | 'limit' | 'provider-error'
   *   reply: the last assistant text (to tell an answer from a question)
   *   tools: [{ name, ok, note, output }] in call order ("wait" included)
   *   pageErrors: [{ level: 'error' | 'warn', text }] logged by the page during the turn
   *   limit: the round limit, for the message
   * @returns {{ level: 'ok'|'warn'|'fail'|'info', title: string, items: string[] }}
   */
  function buildTurnReport({ end, reply, tools = [], pageErrors = [], limit } = {}) {
    const calls = tools.map((t) => ({ ...t, outcome: classifyTool(t) }));
    const pageTools = calls.filter((t) => t.name !== 'wait');
    const count = (outcome) => calls.filter((t) => t.outcome === outcome);
    const failed = count('failed');
    const unsubmitted = count('unsubmitted');
    const interrupted = count('stopped').concat(count('cancelled'));
    const errors = pageErrors.filter((e) => e.level !== 'warn');
    const warnings = pageErrors.filter((e) => e.level === 'warn');

    const items = [];
    const okCount = pageTools.filter((t) => t.outcome === 'ok').length;
    if (pageTools.length) items.push(okCount + ' of ' + pageTools.length + ' page tool call(s) succeeded.');
    for (const t of failed) items.push('Failed: ' + t.name + ' — ' + clip(t.output, MAX_DETAIL));
    for (const t of unsubmitted) items.push('Form filled but NOT submitted: ' + t.name + '.');
    for (const t of interrupted) items.push((t.outcome === 'stopped' ? 'Stopped: ' : 'Cancelled by you: ') + t.name + '.');
    if (errors.length) {
      items.push(errors.length + ' page error(s) during the turn. First: ' + clip(errors[0].text, MAX_DETAIL));
    }
    if (warnings.length) items.push(warnings.length + ' page warning(s) during the turn.');

    // A later success of the same tool means the model recovered from the failure.
    const last = pageTools[pageTools.length - 1];
    const lastFailed = Boolean(last && last.outcome === 'failed');
    const unrecovered = failed.filter((f) => !pageTools.some((t) => t.name === f.name && t.outcome === 'ok'
      && calls.indexOf(t) > calls.indexOf(f)));

    if (end === 'provider-error') {
      return { level: 'fail', title: 'The model could not be reached', items };
    }
    if (end === 'stopped') {
      return { level: 'warn', title: 'Stopped by you', items };
    }
    if (end === 'limit') {
      items.push('Ended at the round limit (' + limit + '), not by the model.');
      return { level: 'fail', title: 'Round limit reached', items };
    }
    if (lastFailed || unrecovered.length) {
      return { level: 'fail', title: 'A tool call failed', items };
    }
    if (endsWithQuestion(reply)) {
      return { level: 'info', title: 'Waiting for your answer', items };
    }
    if (unsubmitted.length || errors.length || interrupted.length || failed.length) {
      return { level: 'warn', title: 'Done, with issues', items };
    }
    if (!pageTools.length) {
      // Nothing on the page backs the answer: fine for a question, suspicious for a task.
      items.push('No page tool ran, so nothing on the page backs this answer.');
      return { level: 'info', title: 'Answer only', items };
    }
    return { level: 'ok', title: 'Done', items };
  }

  /** Plain text, for the session log. */
  function formatReport(report) {
    return [report.title].concat(report.items.map((item) => '  ' + item)).join('\n');
  }

  return { classifyTool, endsWithQuestion, buildTurnReport, formatReport };
});
