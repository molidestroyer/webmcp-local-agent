/**
 * WebMCP Local Agent - lib/agent-trace.js (side panel + node)
 *
 * A compact trace of how the agent spent each turn, small enough to paste into a chat for a
 * review: one line per model call with its tokens and what the prompt was made of (system
 * prompt, catalog rules, tool schemas, conversation, tool results), and what came back.
 * No message text beyond a short clip of the request and of the model's words, so it can
 * be shared without leaking a whole conversation. Everything here is pure and tested.
 */
(function (root, factory) {
  const api = factory();
  root.__WebMCPAgentTrace = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_TURNS = 20;
  const CLIP = 60;
  // A rough, provider-neutral estimate: ~4 characters per token. Only used to split the
  // prompt into parts; the totals shown are the provider's own numbers.
  const CHARS_PER_TOKEN = 4;

  const est = (chars) => Math.round(chars / CHARS_PER_TOKEN);

  function clip(text, max = CLIP) {
    const flat = String(text || '').replace(/\s+/g, ' ').trim();
    return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
  }

  function size(value) {
    if (value === undefined || value === null) return 0;
    if (typeof value === 'string') return value.length;
    try { return JSON.stringify(value).length; } catch (_) { return 0; }
  }

  /**
   * What one request is made of, in estimated tokens. `catalogChars` is the part of the
   * system message that came from the catalog, so the two can be told apart.
   */
  function measurePrompt(messages, tools, catalogChars = 0) {
    const parts = { sys: 0, cat: 0, tools: 0, hist: 0, res: 0 };
    for (const m of messages || []) {
      if (!m) continue;
      if (m.role === 'system') {
        const total = size(m.content);
        const cat = Math.min(catalogChars, total);
        parts.cat += cat;
        parts.sys += total - cat;
      } else if (m.role === 'tool') {
        parts.res += size(m.content);
      } else {
        parts.hist += size(m.content) + size(m.tool_calls);
      }
    }
    parts.tools = size(tools);
    for (const key of Object.keys(parts)) parts[key] = est(parts[key]);
    return parts;
  }

  /** "tools: a, b" or "text" (plus a clip of the words, which is what the overlay shows). */
  function describeReply(reply) {
    const calls = (reply && reply.tool_calls) || [];
    const names = calls.map((c) => (c.function && c.function.name) || c.name || '?');
    const said = clip(reply && reply.content, 50);
    if (names.length) return 'tools: ' + names.join(', ') + (said ? ` "${said}"` : ' (no text)');
    return said ? `text "${said}"` : 'empty';
  }

  function k(n) {
    if (n === null || n === undefined) return '?';
    return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(n);
  }

  /** The trace as plain text: a header per turn, one indented line per model call. */
  function formatTrace(turns) {
    const out = [];
    for (const t of turns || []) {
      const rounds = t.rounds || [];
      const sum = (key) => rounds.reduce((acc, r) => acc + (r.usage ? r.usage[key] || 0 : 0), 0);
      const cached = sum('cached');
      const unanswered = rounds.filter((r) => !r.usage && /^(stopped|error)/.test(r.reply || '')).length;
      out.push(`#${t.n} ${t.at} ${t.model} "${clip(t.request)}" -> ${t.verdict || t.end || '?'}`
        + ` | ${rounds.length} call(s)${unanswered ? ` (${unanswered} unanswered)` : ''}, ${t.nudges || 0} nudge(s), ${t.tools || 0} tool run(s)`
        + ` | in ${k(sum('input'))}${cached ? ` (cached ${k(cached)})` : ''} out ${k(sum('output'))}`
        + (t.pageErrors ? ` | ${t.pageErrors} page error(s)` : ''));
      rounds.forEach((r, i) => {
        const p = r.parts || {};
        const u = r.usage;
        out.push(`  r${i + 1}${r.nudge ? '*' : ''} ${(r.ms / 1000).toFixed(1)}s`
          + ` in ${u ? k(u.input) : '?'}${u && u.cached ? `/${k(u.cached)}c` : ''} out ${u ? k(u.output) : '?'}`
          + ` [~sys ${k(p.sys)} cat ${k(p.cat)} tools ${k(p.tools)} hist ${k(p.hist)} res ${k(p.res)}]`
          + (r.choices > 1 ? ` choices=${r.choices}` : '')
          + ` -> ${r.reply}`);
      });
    }
    if (out.length) {
      out.push('(r = model call, * = after a nudge, c = cached; parts in ~ are estimates at 4 chars/token)');
    }
    return out.join('\n');
  }

  /** Newest last, at most MAX_TURNS, numbered so a pasted trace can refer to a turn. */
  function appendTurn(turns, turn) {
    const list = Array.isArray(turns) ? turns.slice() : [];
    const last = list[list.length - 1];
    list.push({ ...turn, n: last && last.n ? last.n + 1 : 1 });
    return list.slice(-MAX_TURNS);
  }

  return { MAX_TURNS, clip, measurePrompt, describeReply, formatTrace, appendTurn };
});
