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

  const MAX_WORDS = 10;

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
  function goalFromText(text) {
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
    if (list.length <= MAX_WORDS) return value;
    return list.slice(0, MAX_WORDS).join(' ') + '...';
  }

  return { goalFromTool, goalFromText, MAX_WORDS };
});
