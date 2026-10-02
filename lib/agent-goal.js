/**
 * WebMCP Local Agent - lib/agent-goal.js (side panel + node)
 *
 * The short "what is the agent doing now" line shown over the recorded page. It costs the
 * model nothing: it reads what the model already emitted (its reasoning, or the sentence it
 * wrote before calling a tool) and otherwise derives a label from the tool's own name.
 * The model is never asked for a structured "goal" field.
 */
(function (root, factory) {
  const api = factory();
  root.__WebMCPAgentGoal = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_MODEL_CHARS = 400; // safety net only: the prompt asks for under 15 words
  const MAX_WORDS = 16; // the pill wraps to two lines; ten words cut most real sentences short

  // Explicit rather than computed: "get" -> "Getting" and "plan" -> "Planning" are what a
  // gerund rule gets wrong, and these are the verbs tool names actually start with.
  const VERBS = {
    add: 'Adding', apply: 'Applying', book: 'Booking', browse: 'Browsing', cancel: 'Cancelling',
    check: 'Checking', choose: 'Choosing', clear: 'Clearing', click: 'Clicking', close: 'Closing',
    complete: 'Completing', confirm: 'Confirming', create: 'Creating', delete: 'Deleting',
    edit: 'Editing', enter: 'Entering', fetch: 'Fetching', fill: 'Filling', filter: 'Filtering',
    find: 'Finding', get: 'Getting', go: 'Going to', list: 'Listing', load: 'Loading',
    login: 'Logging in', logout: 'Logging out', navigate: 'Navigating to', open: 'Opening',
    pay: 'Paying', read: 'Reading', register: 'Registering', remove: 'Removing', reserve: 'Reserving',
    run: 'Running', save: 'Saving', search: 'Searching', select: 'Selecting', send: 'Sending',
    set: 'Setting', show: 'Showing', sort: 'Sorting', start: 'Starting', stop: 'Stopping',
    submit: 'Submitting', toggle: 'Toggling', update: 'Updating', view: 'Viewing', wait: 'Waiting for',
  };

  function words(name) {
    return String(name || '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[^A-Za-z0-9]+/g, ' ')
      .trim()
      .toLowerCase()
      .split(' ')
      .filter(Boolean);
  }

  /** "complete_booking" -> "Completing booking...". Never empty for a named tool. */
  function goalFromTool(name) {
    const parts = words(name);
    if (!parts.length) return '';
    const verb = VERBS[parts[0]];
    if (parts[0] === 'wait') return 'Waiting for the page...';
    if (verb) return verb + (parts.length > 1 ? ' ' + parts.slice(1).join(' ') : '') + '...';
    return 'Running ' + parts.join(' ') + '...';
  }

  /**
   * First sentence of something the model wrote, trimmed to MAX_WORDS. Returns '' for
   * anything that is not prose (JSON, code, a bare list) so it falls back to the tool label.
   */
  function goalFromText(text, maxWords = MAX_WORDS) {
    let value = String(text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[`*_#>]+/g, '')
      .trim();
    if (!value) return '';
    const first = value.split(/(?<=[.!?…])\s+|\n+/).map((s) => s.trim()).find(Boolean) || '';
    value = first.replace(/[.:;,\s]+$/, '');
    if (!value || /^[{[<]/.test(value)) return '';
    const letters = (value.match(/\p{L}/gu) || []).length;
    if (letters < value.length * 0.5) return '';
    const list = value.split(/\s+/);
    if (list.length <= maxWords) return value;
    return list.slice(0, maxWords).join(' ') + '...';
  }

  /**
   * What the model wrote next to its tool call, shown whole: it is the model's own reason,
   * and cutting it mid-thought hides exactly the part the viewer wants. Only a safety cap
   * (the prompt already asks for one short sentence) and the same not-prose filter.
   */
  function goalFromModel(text) {
    const value = String(text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[`*_#>]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!value || /^[{[<]/.test(value)) return '';
    const letters = (value.match(/\p{L}/gu) || []).length;
    if (letters < value.length * 0.5) return '';
    if (value.length <= MAX_MODEL_CHARS) return value;
    const cut = value.slice(0, MAX_MODEL_CHARS);
    return cut.slice(0, Math.max(cut.lastIndexOf(' '), 1)) + '...';
  }

  /**
   * Why the agent is pausing. `wait` carries only a duration, so the reason is what just
   * happened: the previous step's tool. Costs the model nothing.
   */
  function goalForWait(seconds, previousTool) {
    const n = Math.min(Math.max(Math.round(Number(seconds)) || 5, 1), 30);
    const prev = words(previousTool).join(' ');
    return prev
      ? `Waiting ${n}s for the page to update after ${prev}...`
      : `Waiting ${n}s for the page to settle...`;
  }

  /**
   * One goal for a model reply that is about to call tools, best source first:
   *  1. what the model wrote next to the call, whole (the prompt asks for one short reason);
   *     failing that, the first sentence of its reasoning;
   *  2. for \`wait\`, the reason derived from the previous step;
   *  3. the user's request: the overall objective, which stays steady through the turn
   *     and says something the tool card next to it does not;
   *  4. only if there is no request, a label from the tool name.
   * Never an extra model request or a field the model has to fill in.
   */
  function pickGoal({ thinking, content, toolName, toolArgs, previousTool, request }) {
    const said = goalFromModel(content) || goalFromText(thinking);
    if (said) return said;
    if (toolName === 'wait') return goalForWait(toolArgs && toolArgs.seconds, previousTool);
    return goalFromText(request) || goalFromTool(toolName);
  }

  return { goalFromTool, goalFromText, goalFromModel, goalForWait, pickGoal, MAX_WORDS, MAX_MODEL_CHARS };
});
