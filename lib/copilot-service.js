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
              const mapped = items.map((m) => {
                const name = typeof m === 'string' ? m : (m.id || m.name);
                const label = typeof m === 'object' && (m.name || m.id) ? (m.name || m.id) : name;
                return {
                  id: 'copilot:' + name,
                  rawName: name,
                  displayName: label + ' (Copilot)',
                  provider: 'copilot',
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

  function formatToolsForCopilot(tools) {
    if (!Array.isArray(tools) || !tools.length) return undefined;
    return tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.inputSchema || { type: 'object', properties: {} },
      },
    }));
  }

  function formatMessagesForCopilot(messages) {
    if (!Array.isArray(messages)) return [];
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
      }
      if (msg.role === 'tool') {
        formatted.tool_call_id = msg.tool_call_id;
      }
      return formatted;
    });
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
          throw new Error(`Copilot API (${url}) error ${res.status}: ${errText}`);
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
