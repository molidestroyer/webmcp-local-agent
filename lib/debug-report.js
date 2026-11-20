/**
 * WebMCP Local Agent - lib/debug-report.js (extension pages + node)
 *
 * Pure helpers for aggregating per-conversation telemetry (tokens, WebMCP prompt
 * footprint, tool calls, console errors, linked recordings) and formatting a
 * copyable Markdown debug bundle for external AI coding agents.
 */
(function (root, factory) {
  const api = factory();
  root.__WebMCPDebugReport = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_RECORDINGS = 100;

  const PART_LABELS = {
    sys: 'System prompt',
    cat: 'Catalog rules',
    tools: 'WebMCP tool schemas',
    hist: 'Chat history',
    res: 'Tool results',
  };

  function num(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  }

  function formatCompact(n) {
    if (n === null || n === undefined) return '0';
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k';
    return String(Math.round(n));
  }

  function appendRecordingMeta(list, entry, max = MAX_RECORDINGS) {
    const next = Array.isArray(list) ? list.slice() : [];
    if (!entry || typeof entry !== 'object') return next;
    const item = {
      id: entry.id || ('rec-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)),
      sessionId: entry.sessionId || null,
      stem: String(entry.stem || ''),
      storage: entry.storage || 'downloads',
      downloadId: typeof entry.downloadId === 'number' ? entry.downloadId : null,
      sizeBytes: num(entry.sizeBytes),
      durationMs: num(entry.durationMs),
      startedAt: num(entry.startedAt) || Date.now(),
      endedAt: num(entry.endedAt) || Date.now(),
      url: String(entry.url || ''),
      domain: String(entry.domain || ''),
      pageErrors: num(entry.pageErrors),
      verdict: String(entry.verdict || ''),
      logText: typeof entry.logText === 'string' ? entry.logText : '',
    };
    next.unshift(item);
    return next.slice(0, max);
  }

  function summarizeSessionTokens(turns) {
    const list = Array.isArray(turns) ? turns : [];
    const parts = { sys: 0, cat: 0, tools: 0, hist: 0, res: 0 };
    const lastParts = { sys: 0, cat: 0, tools: 0, hist: 0, res: 0 };
    let roundsCount = 0;
    let input = 0;
    let cached = 0;
    let output = 0;
    let hasUsage = false;
    let ms = 0;
    let nudges = 0;
    let tools = 0;
    let pageErrors = 0;

    for (const t of list) {
      if (!t) continue;
      nudges += num(t.nudges);
      tools += num(t.tools);
      pageErrors += num(t.pageErrors);
      const rounds = Array.isArray(t.rounds) ? t.rounds : [];
      for (const r of rounds) {
        if (!r) continue;
        roundsCount++;
        ms += num(r.ms);
        if (r.usage) {
          hasUsage = true;
          input += num(r.usage.input);
          cached += num(r.usage.cached);
          output += num(r.usage.output);
        }
        if (r.parts) {
          for (const k of Object.keys(parts)) {
            parts[k] += num(r.parts[k]);
            lastParts[k] = num(r.parts[k]);
          }
        }
      }
    }

    const partsTotal = Object.values(parts).reduce((a, b) => a + b, 0);
    return {
      turnsCount: list.length,
      roundsCount,
      input,
      cached,
      output,
      hasUsage,
      ms,
      nudges,
      tools,
      pageErrors,
      parts,
      lastParts,
      partsTotal,
    };
  }

  function topTokenDrivers(turns) {
    const summary = summarizeSessionTokens(turns);
    const total = summary.partsTotal;
    const drivers = Object.keys(summary.parts).map((key) => {
      const tokens = summary.parts[key];
      const pct = total > 0 ? Math.round((tokens / total) * 100) : 0;
      return { key, label: PART_LABELS[key] || key, tokens, pct };
    }).sort((a, b) => b.tokens - a.tokens);

    const hints = [];
    const byKey = Object.fromEntries(drivers.map((d) => [d.key, d]));
    if (byKey.tools && byKey.tools.pct >= 35) {
      hints.push(`WebMCP tool schemas take ${byKey.tools.pct}% of estimated prompt tokens — trim verbose parameter descriptions or split unrelated tools.`);
    }
    if (byKey.res && byKey.res.pct >= 35) {
      hints.push(`Tool results take ${byKey.res.pct}% of estimated prompt tokens — tools may be returning oversized JSON/DOM payloads.`);
    }
    if (byKey.cat && byKey.cat.pct >= 30) {
      hints.push(`Catalog business rules take ${byKey.cat.pct}% of estimated prompt tokens — tighten urlPattern/requiredTools scoping or rule copy.`);
    }
    if (summary.nudges > 0) {
      hints.push(`Agent needed ${summary.nudges} nudge(s) to continue multi-step work — clearer tool return messages can cut extra rounds.`);
    }
    if (summary.pageErrors > 0) {
      hints.push(`${summary.pageErrors} page console error(s) occurred during agent turns — check Page Console to separate web app bugs from model issues.`);
    }

    return { summary, drivers, hints };
  }

  function clipBlock(text, max = 4000) {
    const s = String(text === undefined || text === null ? '' : text);
    if (s.length <= max) return s;
    return s.slice(0, max) + `\n... [truncated ${s.length - max} chars]`;
  }

  function formatDebugMarkdown({
    session = null,
    turns = [],
    recordings = [],
    consoleLogs = [],
    extensionLogs = [],
  } = {}) {
    const { summary, drivers, hints } = topTokenDrivers(turns);
    const title = (session && session.title) || 'Active / Unsaved Conversation';
    const url = (session && session.url) || (turns[turns.length - 1] && turns[turns.length - 1].tabUrl) || '(unknown)';
    const domain = (session && session.domain) || '(unknown)';
    const model = (turns[turns.length - 1] && turns[turns.length - 1].model) || '(unknown)';

    const lines = [
      `# WebMCP Debug Report: ${title}`,
      '',
      `- **Session ID**: \`${(session && session.id) || 'current'}\``,
      `- **Domain**: \`${domain}\``,
      `- **URL**: ${url}`,
      `- **Model**: \`${model}\``,
      `- **Exported**: ${new Date().toISOString()}`,
      '',
      '## 1. Summary & Token Footprint',
      '',
      `- **Turns**: ${summary.turnsCount} | **Model rounds**: ${summary.roundsCount} | **Nudges**: ${summary.nudges}`,
      `- **Tool calls**: ${summary.tools} | **Page console errors**: ${summary.pageErrors} | **Total model latency**: ${(summary.ms / 1000).toFixed(1)}s`,
      `- **Provider tokens**: in \`${formatCompact(summary.input)}\`${summary.cached ? ` (cached \`${formatCompact(summary.cached)}\`)` : ''}, out \`${formatCompact(summary.output)}\`${summary.hasUsage ? '' : ' (provider did not report usage)'}`,
      '',
      '| Prompt Component | Est. Tokens | Share |',
      '| --- | ---: | ---: |',
      ...drivers.map((d) => `| ${d.label} (\`${d.key}\`) | ~${formatCompact(d.tokens)} | ${d.pct}% |`),
    ];

    if (hints.length) {
      lines.push('', '### WebMCP Optimization Signals', '');
      for (const h of hints) lines.push(`- ${h}`);
    }

    lines.push('', '## 2. Goals, Turns & Tool Calls', '');
    if (!turns.length) {
      lines.push('_No recorded turns for this conversation yet._');
    } else {
      for (const t of turns) {
        const goal = t.goal || t.request || '(no goal)';
        lines.push(`### Turn #${t.n || '?'} (${t.at || ''}) — ${t.verdict || t.end || '?'}`);
        lines.push(`- **Goal / Request**: ${clipBlock(goal, 600)}`);
        lines.push(`- **Model**: \`${t.model || ''}\` | **Nudges**: ${num(t.nudges)} | **Tools**: ${num(t.tools)} | **Page Errors**: ${num(t.pageErrors)}`);
        const rounds = Array.isArray(t.rounds) ? t.rounds : [];
        if (rounds.length) {
          lines.push('', '**Rounds:**');
          rounds.forEach((r, idx) => {
            const u = r.usage ? `in ${formatCompact(r.usage.input)}${r.usage.cached ? `/${formatCompact(r.usage.cached)}c` : ''} out ${formatCompact(r.usage.output)}` : 'usage ?';
            const p = r.parts || {};
            lines.push(`- \`r${idx + 1}${r.nudge ? '*' : ''}\` ${(num(r.ms) / 1000).toFixed(1)}s · ${u} · [~sys ${formatCompact(p.sys)} cat ${formatCompact(p.cat)} tools ${formatCompact(p.tools)} hist ${formatCompact(p.hist)} res ${formatCompact(p.res)}] -> ${r.reply || ''}`);
          });
        }
        const toolCalls = Array.isArray(t.toolCalls) ? t.toolCalls : [];
        if (toolCalls.length) {
          lines.push('', '**Tool Calls:**');
          for (const tc of toolCalls) {
            const status = tc.note || (tc.ok ? 'OK' : 'FAILED');
            const timing = typeof tc.ms === 'number' ? ` (${Math.round(tc.ms)}ms)` : '';
            const argsStr = tc.args !== undefined ? ` args=${clipBlock(typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args), 300)}` : '';
            lines.push(`- \`${tc.name}\` -> **${status}**${timing}${argsStr}`);
            if (tc.output) {
              lines.push(`  - Result: \`${clipBlock(String(tc.output).replace(/\s+/g, ' '), 400)}\``);
            }
          }
        }
        lines.push('');
      }
    }

    lines.push('## 3. Page Console Errors & Warnings', '');
    if (!consoleLogs.length) {
      lines.push('_No page console errors or warnings captured._');
    } else {
      for (const err of consoleLogs) {
        const ts = err.at ? `[${new Date(err.at).toISOString()}] ` : '';
        lines.push(`- ${ts}**[${(err.level || 'error').toUpperCase()}]** ${clipBlock(err.text, 500)}`);
      }
    }

    lines.push('', '## 4. Linked Recordings', '');
    if (!recordings.length) {
      lines.push('_No video recordings linked to this conversation._');
    } else {
      for (const rec of recordings) {
        const kb = rec.sizeBytes ? `${Math.round(rec.sizeBytes / 1024)} KB` : 'size ?';
        const dur = rec.durationMs ? `${(rec.durationMs / 1000).toFixed(1)}s` : 'duration ?';
        lines.push(`- \`${rec.stem}.webm\` (${rec.storage}, ${dur}, ${kb}${rec.verdict ? ', ' + rec.verdict : ''})`);
        if (rec.logText) {
          lines.push('', '```text', clipBlock(rec.logText, 4000), '```');
        }
      }
    }

    const msgs = session && Array.isArray(session.messages)
      ? session.messages.filter((m) => m && m.role !== 'system' && !m.synthetic)
      : [];
    lines.push('', '## 5. Conversation Transcript', '');
    if (!msgs.length) {
      lines.push('_No saved transcript messages._');
    } else {
      for (const m of msgs) {
        if (m.role === 'user') {
          lines.push(`**User:**\n${clipBlock(m.content, 2000)}\n`);
        } else if (m.role === 'assistant') {
          const calls = Array.isArray(m.tool_calls) && m.tool_calls.length
            ? ` *(called: ${m.tool_calls.map((c) => (c.function && c.function.name) || c.name || '?').join(', ')})*`
            : '';
          lines.push(`**Assistant${calls}:**\n${clipBlock(m.content || '(tool calls only)', 2000)}\n`);
        } else if (m.role === 'tool') {
          lines.push(`**Tool result (\`${m.name || 'tool'}\`):**\n\`\`\`\n${clipBlock(m.content, 1000)}\n\`\`\`\n`);
        }
      }
    }

    if (extensionLogs && extensionLogs.length) {
      lines.push('## 6. Extension Logs (recent)', '', '```text', clipBlock(extensionLogs.slice(-60).join('\n'), 4000), '```');
    }

    return lines.join('\n').trim() + '\n';
  }

  return {
    MAX_RECORDINGS,
    PART_LABELS,
    formatCompact,
    appendRecordingMeta,
    summarizeSessionTokens,
    topTokenDrivers,
    formatDebugMarkdown,
  };
});
