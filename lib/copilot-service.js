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
      ...(formattedTools ? { tools: formattedTools } : {}),
      stream: false,
    };

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
        const resultToolCalls = [];

        if (Array.isArray(message.tool_calls)) {
          for (const tc of message.tool_calls) {
            if (tc.type === 'function' && tc.function) {
              let parsedArgs = {};
              try {
                parsedArgs = typeof tc.function.arguments === 'string'
                  ? JSON.parse(tc.function.arguments)
                  : tc.function.arguments;
              } catch (_) {
                parsedArgs = {};
              }
              resultToolCalls.push({
                id: tc.id,
                function: {
                  name: tc.function.name,
                  arguments: parsedArgs,
                },
              });
            }
          }
        }

        return {
          message: {
            role: 'assistant',
            content: message.content || '',
            ...(resultToolCalls.length ? { tool_calls: resultToolCalls } : {}),
          },
        };
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError || new Error('Failed to complete request with Copilot API.');
  }

  const CopilotService = {
    DEFAULT_MODELS: COPILOT_DEFAULT_MODELS,
    endpointFor,
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
