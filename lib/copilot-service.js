/**
 * WebMCP Local Agent - lib/copilot-service.js
 *
 * Provider interface for GitHub Copilot API completions & model listing.
 * Supports OpenAI-style chat completions with function / tool calling.
 */
(() => {
  'use strict';

  const COPILOT_DEFAULT_MODELS = [
    { id: 'copilot:gpt-4o', rawName: 'gpt-4o', displayName: 'GPT-4o (Copilot)', provider: 'copilot' },
    { id: 'copilot:gpt-4o-mini', rawName: 'gpt-4o-mini', displayName: 'GPT-4o Mini (Copilot)', provider: 'copilot' },
    { id: 'copilot:claude-3.5-sonnet', rawName: 'claude-3.5-sonnet', displayName: 'Claude 3.5 Sonnet (Copilot)', provider: 'copilot' },
    { id: 'copilot:o3-mini', rawName: 'o3-mini', displayName: 'o3-mini (Copilot)', provider: 'copilot' },
  ];

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
    const url = endpointUrl || 'https://api.individual.githubcopilot.com/chat/completions';

    const formattedMessages = formatMessagesForCopilot(messages);
    const formattedTools = formatToolsForCopilot(tools);

    const body = {
      model: rawModel,
      messages: formattedMessages,
      ...(formattedTools ? { tools: formattedTools } : {}),
      stream: false,
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sessionToken}`,
        'Editor-Version': 'vscode/1.96.2',
        'Editor-Plugin-Version': 'copilot/1.250.0',
        'User-Agent': 'GitHubCopilot/1.250.0',
        'Copilot-Integration-Id': 'vscode-chat',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Copilot API error ${res.status}: ${errText}`);
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
  }

  const CopilotService = {
    DEFAULT_MODELS: COPILOT_DEFAULT_MODELS,
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
