/**
 * WebMCP Local Agent - lib/copilot-service.js
 *
 * Provider interface for GitHub Copilot API completions & model listing.
 * Supports OpenAI-style chat completions with function / tool calling.
 */
(() => {
  'use strict';

  const COPILOT_DEFAULT_MODELS = [];

  /**
   * Turns whatever the caller has — the bare API endpoint, a /models URL or a
   * /chat/completions one — into "<base>/<path>". Callers used to append the
   * path themselves and this function appended it again, producing
   * .../models/models, so only the hardcoded fallbacks below ever answered.
   */
  function endpointFor(endpointUrl, path) {
    if (!endpointUrl) return null;
    const base = String(endpointUrl)
      .replace(/\/+$/, '')
      .replace(/\/chat\/completions$/, '')
      .replace(/\/models$/, '');
    return base + path;
  }

  /**
   * Whether a listed model can be used from /chat/completions.
   *
   * GitHub lists everything the account can reach — embeddings models, models
   * the editor uses internally, and newer ones that only answer on /responses.
   * Offering those in the picker means the chat dies at send time with
   * `unsupported_api_for_model`, which is what happened with gpt-5.4-mini.
   */
  function isChatCompletionsModel(m) {
    if (typeof m === 'string') return true;
    if (!m || typeof m !== 'object') return false;
    if (m.model_picker_enabled === false) return false;
    const caps = m.capabilities || {};
    if (caps.type && caps.type !== 'chat') return false;
    const endpoints = m.supported_endpoints || caps.supported_endpoints;
    if (Array.isArray(endpoints) && endpoints.length
        && !endpoints.some((e) => String(e).includes('/chat/completions'))) {
      return false;
    }
    return true;
  }

  function supportsToolCalls(m) {
    return Boolean(m && typeof m === 'object' && m.capabilities
      && m.capabilities.supports && m.capabilities.supports.tool_calls);
  }

  async function fetchCopilotModels(sessionToken, oauthToken, endpointUrl) {
    const urlsToTry = [];
    const fromEndpoint = endpointFor(endpointUrl, '/models');
    if (fromEndpoint) urlsToTry.push(fromEndpoint);
    urlsToTry.push('https://api.individual.githubcopilot.com/models');
    urlsToTry.push('https://api.githubcopilot.com/models');

    const authHeaders = [];
    if (sessionToken) authHeaders.push(`Bearer ${sessionToken}`);
    if (oauthToken) {
      authHeaders.push(`Bearer ${oauthToken}`);
      authHeaders.push(`token ${oauthToken}`);
    }

    for (const url of [...new Set(urlsToTry)]) {
      for (const authHeader of authHeaders) {
        try {
          console.log(`[CopilotService] Fetching models from ${url} with auth (${authHeader.substring(0, 10)}...)`);
          const res = await fetch(url, {
            method: 'GET',
            headers: {
              'Authorization': authHeader,
              'Editor-Version': 'vscode/1.96.2',
              'Editor-Plugin-Version': 'copilot/1.250.0',
              'User-Agent': 'GitHubCopilot/1.250.0',
              'Copilot-Integration-Id': 'vscode-chat',
              'Accept': 'application/json',
            },
          });
          console.log(`[CopilotService] ${url} status: ${res.status}`);
          if (res.ok) {
            const data = await res.json();
            console.log('[CopilotService] Raw models data:', data);
            const items = data.data || data.models || (Array.isArray(data) ? data : null);
            if (Array.isArray(items) && items.length) {
              const usable = items.filter(isChatCompletionsModel);
              if (usable.length !== items.length) {
                console.log(`[CopilotService] Skipped ${items.length - usable.length} model(s) not usable from /chat/completions.`);
              }
              // Never end up with an empty picker because the shape of the
              // listing changed: an unusable model at least fails loudly.
              const listed = usable.length ? usable : items;
              const mapped = listed.map((m) => {
                const name = typeof m === 'string' ? m : (m.id || m.name);
                const label = typeof m === 'object' && (m.name || m.id) ? (m.name || m.id) : name;
                return {
                  id: 'copilot:' + name,
                  rawName: name,
                  displayName: label + ' (Copilot)' + (supportsToolCalls(m) ? ' · tools' : ''),
                  provider: 'copilot',
                  toolCalls: supportsToolCalls(m),
                };
              });
              console.log('[CopilotService] Parsed Copilot models:', mapped);
              return mapped;
            }
          } else {
            const errText = await res.text().catch(() => '');
            console.warn(`[CopilotService] ${url} returned ${res.status}: ${errText}`);
          }
        } catch (err) {
          console.warn(`[CopilotService] Models fetch failed for ${url}: ${String((err && err.message) || err)}`);
        }
      }
    }
    console.error('[CopilotService] No Copilot models returned by any endpoint. '
      + `Tried: ${[...new Set(urlsToTry)].join(', ')} with ${authHeaders.length} auth header(s).`);
    return [];
  }

  /**
   * Accepts both tool shapes on purpose.
   *
   * runAgent() maps the page's tools through toOllamaTool() and prepends the
   * native wait tool, so what arrives here is already
   * `{ type, function: { name, parameters } }` — reading `t.name` off that gave
   * every tool an undefined name and the API rejected the whole turn with
   * "tools.0.custom.name: String should have at least 1 character". The flat
   * WebMCP descriptor (`{ name, inputSchema }`) still works.
   */
  function formatToolsForCopilot(tools) {
    if (!Array.isArray(tools) || !tools.length) return undefined;
    const formatted = [];
    for (const t of tools) {
      const fn = (t && t.type === 'function' && t.function) ? t.function : t;
      const name = fn && fn.name;
      if (!name) {
        console.warn('[CopilotService] Dropping a tool with no name:', JSON.stringify(t));
        continue;
      }
      formatted.push({
        type: 'function',
        function: {
          name,
          description: fn.description || '',
          parameters: fn.parameters || fn.inputSchema || { type: 'object', properties: {} },
        },
      });
    }
    return formatted.length ? formatted : undefined;
  }

  function formatMessagesForCopilot(messages) {
    if (!Array.isArray(messages)) return [];

    // A tool result must name the call it answers or the API rejects the whole
    // turn. Conversations built for Ollama only carry tool_name, so keep the
    // ids of the last assistant turn around to pair them up by name.
    let pendingCalls = [];

    return messages.map((msg) => {
      const formatted = { role: msg.role, content: msg.content || '' };
      if (msg.tool_calls) {
        formatted.tool_calls = msg.tool_calls.map((tc) => ({
          id: tc.id || `call_${Math.random().toString(36).substring(2, 9)}`,
          type: 'function',
          function: {
            name: tc.function ? tc.function.name : tc.name,
            arguments: typeof tc.function?.arguments === 'string'
              ? tc.function.arguments
              : JSON.stringify(tc.function?.arguments || tc.args || {}),
          },
        }));
        pendingCalls = formatted.tool_calls.map((tc) => ({ id: tc.id, name: tc.function.name, used: false }));
      }
      if (msg.role === 'tool') {
        let id = msg.tool_call_id;
        if (!id) {
          const match = pendingCalls.find((c) => !c.used && c.name === msg.tool_name)
            || pendingCalls.find((c) => !c.used);
          if (match) {
            match.used = true;
            id = match.id;
          }
        }
        formatted.tool_call_id = id;
      }
      return formatted;
    });
  }

  /**
   * Reads the tool calls out of a completion message.
   *
   * The gate used to be `tc.type === 'function' && tc.function`. The Copilot
   * proxy translates OpenAI tool definitions into the vendor's own format and
   * back — the 400 it once returned named `tools.0.custom.name`, which is
   * Anthropic's wording — and what comes back does not always carry the
   * `type` discriminator. Anything missing it was dropped in silence, and since
   * a tool-calling turn usually has empty `content`, the panel rendered an empty
   * bubble and simply did nothing. Match on the payload, not on the label.
   */
  function extractToolCalls(message) {
    const raw = Array.isArray(message && message.tool_calls) ? message.tool_calls : [];
    const calls = [];
    for (const tc of raw) {
      if (!tc || typeof tc !== 'object') continue;
      const fn = tc.function || tc;
      const name = fn.name;
      if (!name) {
        console.warn('[CopilotService] Ignoring a tool call with no name:', JSON.stringify(tc));
        continue;
      }
      // Anthropic-shaped calls carry `input`; OpenAI-shaped ones `arguments`,
      // as a JSON string.
      const rawArgs = fn.arguments !== undefined ? fn.arguments : fn.input;
      let parsedArgs = {};
      try {
        parsedArgs = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : (rawArgs || {});
      } catch (_) {
        console.warn(`[CopilotService] Tool call ${name} carried unparseable arguments: ${String(rawArgs).slice(0, 200)}`);
        parsedArgs = {};
      }
      calls.push({ id: tc.id, function: { name, arguments: parsedArgs } });
    }
    return calls;
  }

  /** Content can come back as a string or as vendor content blocks. */
  function contentToText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => (typeof part === 'string' ? part : (part && part.text) || ''))
        .join('');
    }
    return '';
  }

  /** Unwraps the API's JSON error body and names the ones worth explaining. */
  function describeCopilotError(url, status, body) {
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch (_) {
      // Not JSON: the raw body is the best detail available.
    }
    const err = parsed && parsed.error;
    const detail = err ? (err.message || JSON.stringify(err)) : (body || status);
    if (err && err.code === 'unsupported_api_for_model') {
      return `${detail} GitHub lists it, but it does not answer on /chat/completions — pick another Copilot model.`;
    }
    return `Copilot API (${url}) error ${status}: ${detail}`;
  }

  async function chatCompletion({ model, messages, tools, sessionToken, endpointUrl, signal }) {
    const rawModel = model.replace(/^copilot:/, '');
    const urlsToTry = [];
    const fromEndpoint = endpointFor(endpointUrl, '/chat/completions');
    if (fromEndpoint) urlsToTry.push(fromEndpoint);
    urlsToTry.push('https://api.individual.githubcopilot.com/chat/completions');
    urlsToTry.push('https://api.githubcopilot.com/chat/completions');

    const formattedMessages = formatMessagesForCopilot(messages);
    const formattedTools = formatToolsForCopilot(tools);

    const body = {
      model: rawModel,
      messages: formattedMessages,
      ...(formattedTools ? { tools: formattedTools, tool_choice: 'auto' } : {}),
      stream: false,
    };

    console.log(`[CopilotService] ${rawModel}: sending ${formattedMessages.length} message(s) and `
      + `${formattedTools ? formattedTools.length : 0} tool(s)`
      + `${formattedTools ? ' [' + formattedTools.map((t) => t.function.name).join(', ') + ']' : ''}.`);

    let lastError = null;
    for (const url of [...new Set(urlsToTry)]) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${sessionToken}`,
            'Editor-Version': 'vscode/1.96.2',
            'Editor-Plugin-Version': 'copilot/1.250.0',
            'User-Agent': 'GitHubCopilot/1.250.0',
            'Copilot-Integration-Id': 'vscode-chat',
            'Openai-Organization': 'github-copilot',
            'Openai-Intent': 'conversation-panel',
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify(body),
          signal,
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          throw new Error(describeCopilotError(url, res.status, errText));
        }

        const data = await res.json();
        const choice = data.choices && data.choices[0];
        if (!choice) {
          throw new Error('Copilot API returned no choice.');
        }

        const message = choice.message || {};
        const resultToolCalls = extractToolCalls(message);
        const text = contentToText(message.content);

        console.log(`[CopilotService] ${rawModel}: finish_reason=${choice.finish_reason || 'n/a'}, `
          + `${resultToolCalls.length} tool call(s)`
          + `${resultToolCalls.length ? ' [' + resultToolCalls.map((c) => c.function.name).join(', ') + ']' : ''}, `
          + `${text.length} char(s) of text.`);

        // Silence is the one answer we cannot show the user, and it is what a
        // dropped tool call looks like.
        if (!resultToolCalls.length && !text) {
          console.warn('[CopilotService] Empty answer. Raw message: ' + JSON.stringify(message).slice(0, 600));
        }

        return {
          message: {
            role: 'assistant',
            content: text,
            ...(resultToolCalls.length ? { tool_calls: resultToolCalls } : {}),
          },
          // Raw OpenAI-shaped usage; lib/token-usage.js reads it. Absent when not reported.
          usage: data.usage || null,
        };
      } catch (err) {
        // A stop from the user is not an endpoint failure: trying the fallbacks would
        // only replace the AbortError with a less truthful one.
        if (signal && signal.aborted) throw err;
        lastError = err;
      }
    }

    throw lastError || new Error('Failed to complete request with Copilot API.');
  }

  // --- Monthly quota (api.github.com/copilot_internal/user) ------------------
  //
  // Undocumented, the endpoint VS Code reads. The shape follows Win-CodexBar's parser
  // (rust/src/providers/copilot/api.rs), which tracks it against live accounts:
  // `copilot_plan`, `token_based_billing`, `quota_reset_date`, `quota_snapshots.{chat,
  // completions, premium_interactions}` (each `entitlement`, `remaining`,
  // `percent_remaining`, `unlimited`, `placeholder`, `credits_used`, `overage_*`), and for
  // the Free plan `limited_user_quotas` / `monthly_quotas`. Since June 2026 chat is billed
  // in AI credits (1 credit = $0.01). Two traps it documents:
  // - Token-billed seats (Business) can report every snapshot with entitlement 0. The real
  //   consumption is then only in `credits_used`: show that, never "0 of 0 left".
  // - `token_based_billing` sits at the top level; some reports put it in the snapshot too.
  // Every field is optional: a shape we did not foresee must show less, never a wrong number.

  const num = (value) => {
    const n = typeof value === 'string' && value.trim() ? Number(value) : value;
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
  };

  function pick(obj, snake, camel) {
    return obj && typeof obj === 'object' ? (obj[snake] !== undefined ? obj[snake] : obj[camel]) : undefined;
  }

  function parseCopilotQuota(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const snapshots = pick(raw, 'quota_snapshots', 'quotaSnapshots') || {};
    const usable = (snap) => snap && typeof snap === 'object' && snap.placeholder !== true;
    const premium = pick(snapshots, 'premium_interactions', 'premiumInteractions');
    const snap = usable(premium) ? premium : (usable(snapshots.chat) ? snapshots.chat : null);
    const resetDate = String(pick(raw, 'quota_reset_date_utc', 'quotaResetDateUtc')
      || pick(raw, 'quota_reset_date', 'quotaResetDate') || '').slice(0, 10) || null;
    const tokenBilling = Boolean(pick(raw, 'token_based_billing', 'tokenBasedBilling')
      || (snap && pick(snap, 'token_based_billing', 'tokenBasedBilling')));
    const quota = {
      plan: pick(raw, 'copilot_plan', 'copilotPlan') || raw.access_type_sku || null,
      resetDate,
      unlimited: false,
      unit: tokenBilling ? 'credits' : 'requests',
      entitlement: null,
      remaining: null,
      used: null,
      percentRemaining: null,
      overagePermitted: null,
      overageCount: null,
    };

    if (snap) {
      quota.unlimited = snap.unlimited === true;
      const entitlement = num(snap.entitlement);
      // A zero allowance on a token-billed seat means "not reported", not "nothing left".
      const hasAllowance = entitlement !== null && entitlement > 0;
      quota.entitlement = hasAllowance ? entitlement : null;
      quota.remaining = hasAllowance ? (num(snap.remaining) ?? num(pick(snap, 'quota_remaining', 'quotaRemaining'))) : null;
      quota.used = num(pick(snap, 'credits_used', 'creditsUsed'))
        ?? (hasAllowance && quota.remaining !== null ? entitlement - quota.remaining : null);
      const percent = num(pick(snap, 'percent_remaining', 'percentRemaining'));
      quota.percentRemaining = hasAllowance
        ? (percent ?? (quota.remaining !== null ? (quota.remaining / entitlement) * 100 : null))
        : null;
      const overage = pick(snap, 'overage_permitted', 'overagePermitted');
      quota.overagePermitted = typeof overage === 'boolean' ? overage : null;
      quota.overageCount = num(pick(snap, 'overage_count', 'overageCount'));
      return quota;
    }

    // Free plan: chat messages left out of a monthly allowance.
    const left = num(pick(pick(raw, 'limited_user_quotas', 'limitedUserQuotas'), 'chat', 'chat'));
    const total = num(pick(pick(raw, 'monthly_quotas', 'monthlyQuotas'), 'chat', 'chat'));
    if (left !== null) {
      quota.unit = 'chat messages';
      quota.remaining = left;
      if (total !== null && total > 0) {
        quota.entitlement = total;
        quota.used = total - left;
        quota.percentRemaining = (left / total) * 100;
      }
      return quota;
    }
    return quota.plan || quota.resetDate ? quota : null;
  }

  const fmt = (n) => (Math.round(n * 100) / 100).toLocaleString('en-US');

  /** "620 of 1,000 credits left (62%, $6.20) · used 380 · resets 2026-11-01". */
  function formatCopilotQuota(q) {
    if (!q) return '';
    const parts = [];
    if (q.unlimited) {
      parts.push('Unlimited');
    } else if (q.remaining !== null) {
      let left = fmt(Math.max(q.remaining, 0)) + (q.entitlement !== null ? ' of ' + fmt(q.entitlement) : '')
        + ' ' + q.unit + ' left';
      const extra = [];
      if (q.percentRemaining !== null) extra.push(Math.round(q.percentRemaining) + '%');
      if (q.unit === 'credits') extra.push('$' + (Math.max(q.remaining, 0) / 100).toFixed(2));
      if (extra.length) left += ' (' + extra.join(', ') + ')';
      parts.push(left);
      if (q.used !== null) parts.push('used ' + fmt(q.used));
      if (q.remaining < 0) parts.push(fmt(-q.remaining) + ' over the allowance');
    } else if (q.percentRemaining !== null) {
      parts.push(Math.round(q.percentRemaining) + '% left');
    } else if (q.used !== null) {
      // Token-billed seat without a reported allowance: consumption is all GitHub gives.
      parts.push(fmt(q.used) + ' ' + q.unit + ' used' + (q.unit === 'credits' ? ' ($' + (q.used / 100).toFixed(2) + ')' : '')
        + ', allowance not reported');
    }
    if (q.resetDate) parts.push('resets ' + q.resetDate);
    return parts.join(' \u00b7 ');
  }

  /** What one turn cost, from the balance before and after it. Null when it cannot tell. */
  function quotaSpent(before, after) {
    if (!before || !after || before.unit !== after.unit) return null;
    if (before.used !== null && after.used !== null) return after.used - before.used;
    if (before.remaining !== null && after.remaining !== null) return before.remaining - after.remaining;
    return null;
  }

  const CopilotService = {
    parseCopilotQuota,
    formatCopilotQuota,
    quotaSpent,
    DEFAULT_MODELS: COPILOT_DEFAULT_MODELS,
    endpointFor,
    extractToolCalls,
    contentToText,
    isChatCompletionsModel,
    fetchCopilotModels,
    formatToolsForCopilot,
    formatMessagesForCopilot,
    chatCompletion,
  };

  if (typeof globalThis !== 'undefined') {
    globalThis.__WebMCPCopilotService = CopilotService;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = CopilotService;
  }
})();
