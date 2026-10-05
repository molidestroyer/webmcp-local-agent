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

  const TITLE_DETAIL = 60;

  /** "a, b" or "a, b and 2 more", for a title that must stay one line. */
  function names(list, max = 2) {
    const unique = [...new Set(list.map((t) => t.name))];
    return unique.length > max ? unique.slice(0, max).join(', ') + ' and ' + (unique.length - max) + ' more' : unique.join(', ');
  }

  /**
   * @param {object} turn
   *   end: 'answered' | 'stopped' | 'limit' | 'provider-error'
   *   reply: the last assistant text (to tell an answer from a question)
   *   tools: [{ name, ok, note, output }] in call order ("wait" included)
   *   pageErrors: [{ level: 'error' | 'warn', text }] logged by the page during the turn
   *   limit: the round limit, for the message
   * @returns {{ level: 'ok'|'warn'|'fail'|'info', title: string, items: string[] }}
   *
   * The level is the worst thing that happened, and the title names it: a QA reads the
   * title, not the list. A question from the model never lowers the level. "Which date?"
   * after a form that was not sent is still a booking that did not happen, so the question
   * becomes a suffix ("· waiting for you") instead of the verdict.
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
    for (const t of failed) items.push('Failed: ' + t.name + ' \u2014 ' + clip(t.output, MAX_DETAIL));
    for (const t of unsubmitted) items.push('Form filled but NOT submitted: ' + t.name + '.');
    for (const t of interrupted) items.push((t.outcome === 'stopped' ? 'Stopped: ' : 'Cancelled by you: ') + t.name + '.');
    if (errors.length) {
      items.push(errors.length + ' page error(s) during the turn. First: ' + clip(errors[0].text, MAX_DETAIL));
    }
    if (warnings.length) items.push(warnings.length + ' page warning(s) during the turn.');

    // A later success of the same tool means the model recovered from the failure.
    const unrecovered = failed.filter((f) => !pageTools.some((t) => t.name === f.name && t.outcome === 'ok'
      && calls.indexOf(t) > calls.indexOf(f)));
    const last = pageTools[pageTools.length - 1];
    if (last && last.outcome === 'failed' && !unrecovered.includes(last)) unrecovered.push(last);
    const recovered = failed.filter((f) => !unrecovered.includes(f));

    // Every problem, worst first. The first one becomes the title.
    const issues = [];
    if (end === 'provider-error') issues.push({ level: 'fail', title: 'The model could not be reached' });
    if (end === 'limit') {
      items.push('Ended at the round limit (' + limit + '), not by the model.');
      issues.push({ level: 'fail', title: 'Round limit reached (' + limit + ')' });
    }
    if (unrecovered.length) {
      const first = unrecovered[0];
      issues.push({ level: 'fail', title: 'Failed: ' + first.name + ' \u2014 ' + clip(String(first.output || '').replace(/^Error:\s*/, ''), TITLE_DETAIL) });
      if (unrecovered.length > 1) issues.push({ level: 'fail', title: (unrecovered.length - 1) + ' more failure(s)' });
    }
    if (end === 'stopped') issues.push({ level: 'warn', title: 'Stopped by you' });
    if (unsubmitted.length) issues.push({ level: 'warn', title: 'Not submitted: ' + names(unsubmitted) });
    if (errors.length) issues.push({ level: 'warn', title: errors.length + ' page error(s)' });
    const cancelled = count('cancelled');
    if (cancelled.length && end !== 'stopped') issues.push({ level: 'warn', title: 'Cancelled by you: ' + names(cancelled) });
    if (recovered.length) issues.push({ level: 'warn', title: 'Recovered from ' + recovered.length + ' failure(s)' });

    const asking = end === 'answered' && endsWithQuestion(reply);
    if (issues.length) {
      const level = issues.some((i) => i.level === 'fail') ? 'fail' : 'warn';
      let title = issues[0].title;
      if (issues.length > 1) title += ' (+' + (issues.length - 1) + ' more)';
      if (asking) title += ' \u00b7 waiting for you';
      return { level, title, items };
    }
    if (asking) return { level: 'info', title: 'Waiting for your answer', items };
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
