const test = require('node:test');
const assert = require('node:assert/strict');
const CopilotService = require('../lib/copilot-service.js');

test('CopilotService exports default models', () => {
  assert.ok(Array.isArray(CopilotService.DEFAULT_MODELS));
  assert.ok(CopilotService.DEFAULT_MODELS.length >= 2);
  const gpt4o = CopilotService.DEFAULT_MODELS.find((m) => m.rawName === 'gpt-4o');
  assert.ok(gpt4o);
  assert.equal(gpt4o.provider, 'copilot');
});

test('formatToolsForCopilot converts WebMCP tools to OpenAI format', () => {
  const tools = [
    {
      name: 'create_contact',
      description: 'Create a new contact',
      inputSchema: {
        type: 'object',
        properties: { fullName: { type: 'string' } },
        required: ['fullName'],
      },
    },
  ];

  const formatted = CopilotService.formatToolsForCopilot(tools);
  assert.equal(formatted.length, 1);
  assert.equal(formatted[0].type, 'function');
  assert.equal(formatted[0].function.name, 'create_contact');
  assert.equal(formatted[0].function.description, 'Create a new contact');
  assert.deepEqual(formatted[0].function.parameters, tools[0].inputSchema);
});

test('formatMessagesForCopilot formats user and assistant messages', () => {
  const messages = [
    { role: 'user', content: 'Hello' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_123',
          function: { name: 'search_contact', arguments: { query: 'Ada' } },
        },
      ],
    },
  ];

  const formatted = CopilotService.formatMessagesForCopilot(messages);
  assert.equal(formatted.length, 2);
  assert.equal(formatted[0].role, 'user');
  assert.equal(formatted[0].content, 'Hello');
  assert.equal(formatted[1].role, 'assistant');
  assert.equal(formatted[1].tool_calls[0].function.name, 'search_contact');
  assert.equal(formatted[1].tool_calls[0].function.arguments, '{"query":"Ada"}');
});
