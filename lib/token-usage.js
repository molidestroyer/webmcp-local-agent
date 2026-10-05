/**
 * WebMCP Local Agent - lib/token-usage.js (side panel + node)
 *
 * Token accounting for one agent turn. Each provider reports usage in its own shape and
 * either may leave it out, so everything here distinguishes "zero" from "not reported":
 * a turn whose provider said nothing must read "not reported", never "0 tokens".
 */
(function (root, factory) {
  const api = factory();
  root.__WebMCPTokenUsage = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const count = (value) => (Number.isFinite(value) && value >= 0 ? value : null);

  /**
   * Ollama's final NDJSON chunk (`done: true`). `prompt_eval_count` counts the prompt tokens
   * Ollama had to evaluate, which can be fewer than the whole prompt when it reuses its
   * cache from the previous request.
   */
  function fromOllama(chunk) {
    if (!chunk || typeof chunk !== 'object') return null;
    const input = count(chunk.prompt_eval_count);
    const output = count(chunk.eval_count);
    if (input === null && output === null) return null;
    return { input: input || 0, output: output || 0, cached: null };
  }

  /** OpenAI-shaped `usage` (Copilot's /chat/completions). */
  function fromOpenAI(usage) {
    if (!usage || typeof usage !== 'object') return null;
    const input = count(usage.prompt_tokens);
    const output = count(usage.completion_tokens);
    if (input === null && output === null) return null;
    const details = usage.prompt_tokens_details;
    return {
      input: input || 0,
      output: output || 0,
      cached: count(details && details.cached_tokens),
    };
  }

  function emptyTurn() {
    return { calls: 0, reported: 0, input: 0, output: 0, cached: 0, cachedReported: false };
  }

  /** Adds one model call to the turn. `usage` is null when the provider reported nothing. */
  function addCall(turn, usage) {
    turn.calls++;
    if (!usage) return turn;
    turn.reported++;
    turn.input += usage.input;
    turn.output += usage.output;
    if (usage.cached !== null && usage.cached !== undefined) {
      turn.cached += usage.cached;
      turn.cachedReported = true;
    }
    return turn;
  }

  function compact(n) {
    if (n < 1000) return String(n);
    if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    if (n < 1e6) return Math.round(n / 1000) + 'k';
    return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  }

  /** One line for the chat: "3.4k in (1.2k cached) · 280 out · 3 model calls". */
  function formatTurn(turn) {
    if (!turn || !turn.calls) return '';
    const calls = turn.calls + (turn.calls === 1 ? ' model call' : ' model calls');
    if (!turn.reported) return 'Tokens not reported by the provider · ' + calls;
    let text = compact(turn.input) + ' in';
    if (turn.cachedReported && turn.cached) text += ' (' + compact(turn.cached) + ' cached)';
    text += ' · ' + compact(turn.output) + ' out · ' + calls;
    if (turn.reported < turn.calls) text += ' (' + (turn.calls - turn.reported) + ' without usage)';
    return text;
  }

  return { fromOllama, fromOpenAI, emptyTurn, addCall, compact, formatTurn };
});
