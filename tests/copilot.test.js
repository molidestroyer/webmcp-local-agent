const test = require('node:test');
const assert = require('node:assert/strict');
const CopilotService = require('../lib/copilot-service.js');

test('CopilotService exports DEFAULT_MODELS array', () => {
  assert.ok(Array.isArray(CopilotService.DEFAULT_MODELS));
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

test('endpointFor appends the path exactly once', () => {
  // The token exchange hands back a bare API endpoint, but callers used to
  // append /models themselves, which produced .../models/models.
  assert.equal(
    CopilotService.endpointFor('https://api.individual.githubcopilot.com', '/models'),
    'https://api.individual.githubcopilot.com/models'
  );
  assert.equal(
    CopilotService.endpointFor('https://api.individual.githubcopilot.com/models', '/models'),
    'https://api.individual.githubcopilot.com/models'
  );
  assert.equal(
    CopilotService.endpointFor('https://api.individual.githubcopilot.com/chat/completions', '/models'),
    'https://api.individual.githubcopilot.com/models'
  );
  assert.equal(
    CopilotService.endpointFor('https://api.individual.githubcopilot.com/', '/chat/completions'),
    'https://api.individual.githubcopilot.com/chat/completions'
  );
  assert.equal(CopilotService.endpointFor(undefined, '/models'), null);
});

test('fetchCopilotModels returns models list array', async () => {
  const models = await CopilotService.fetchCopilotModels('fake-token');
  assert.ok(Array.isArray(models));
});
