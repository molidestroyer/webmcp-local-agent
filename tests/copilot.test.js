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

test('formatToolsForCopilot accepts tools already in OpenAI shape', () => {
  // runAgent() hands over toOllamaTool() output, not the flat descriptor.
  // Reading t.name off this shape produced nameless tools and the API rejected
  // the turn with "tools.0.custom.name: String should have at least 1 character".
  const wrapped = [
    {
      type: 'function',
      function: {
        name: 'wait',
        description: 'Pause execution.',
        parameters: { type: 'object', properties: { seconds: { type: 'number' } } },
      },
    },
  ];

  const formatted = CopilotService.formatToolsForCopilot(wrapped);
  assert.equal(formatted.length, 1);
  assert.equal(formatted[0].function.name, 'wait');
  assert.equal(formatted[0].function.description, 'Pause execution.');
  assert.deepEqual(formatted[0].function.parameters, wrapped[0].function.parameters);
});

test('formatToolsForCopilot drops nameless tools instead of sending them', () => {
  const formatted = CopilotService.formatToolsForCopilot([
    { description: 'no name at all' },
    { name: 'ok', inputSchema: { type: 'object', properties: {} } },
  ]);
  assert.equal(formatted.length, 1);
  assert.equal(formatted[0].function.name, 'ok');
  assert.equal(CopilotService.formatToolsForCopilot([{ description: 'nothing' }]), undefined);
});

test('isChatCompletionsModel keeps only models /chat/completions can serve', () => {
  assert.equal(CopilotService.isChatCompletionsModel({ id: 'gpt-4o' }), true);
  assert.equal(CopilotService.isChatCompletionsModel('gpt-4o'), true);
  assert.equal(
    CopilotService.isChatCompletionsModel({
      id: 'gpt-4o',
      capabilities: { type: 'chat' },
      supported_endpoints: ['/chat/completions', '/responses'],
    }),
    true
  );
  // The gpt-5.4-mini case: listed, but only reachable through /responses.
  assert.equal(
    CopilotService.isChatCompletionsModel({ id: 'gpt-5.4-mini', supported_endpoints: ['/responses'] }),
    false
  );
  assert.equal(
    CopilotService.isChatCompletionsModel({ id: 'text-embedding-3-small', capabilities: { type: 'embeddings' } }),
    false
  );
  assert.equal(
    CopilotService.isChatCompletionsModel({ id: 'internal', model_picker_enabled: false }),
    false
  );
});

test('formatMessagesForCopilot pairs tool results with their call id', () => {
  const formatted = CopilotService.formatMessagesForCopilot([
    { role: 'user', content: 'add bread' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'call_a', function: { name: 'add_item', arguments: { text: 'bread' } } },
        { id: 'call_b', function: { name: 'list_items', arguments: {} } },
      ],
    },
    // Ollama-shaped result: tool_name only, which the API cannot pair up.
    { role: 'tool', tool_name: 'list_items', content: '1 item' },
    { role: 'tool', tool_name: 'add_item', tool_call_id: 'call_a', content: 'ok' },
  ]);

  assert.equal(formatted[2].tool_call_id, 'call_b');
  assert.equal(formatted[3].tool_call_id, 'call_a');
  assert.equal(formatted[2].tool_name, undefined);
});

test('extractToolCalls keeps calls that omit the type discriminator', () => {
  // The proxy translates tool definitions into the vendor's format and back;
  // what returns does not always carry type:"function". Requiring it dropped
  // every call in silence, and a tool-calling turn has no content to show.
  const calls = CopilotService.extractToolCalls({
    tool_calls: [
      { id: 'call_1', function: { name: 'add_item', arguments: '{"text":"bread"}' } },
      { id: 'call_2', type: 'function', function: { name: 'list_items', arguments: '{}' } },
    ],
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].function.name, 'add_item');
  assert.deepEqual(calls[0].function.arguments, { text: 'bread' });
  assert.deepEqual(calls[1].function.arguments, {});
});

test('extractToolCalls reads Anthropic-shaped calls and survives bad arguments', () => {
  const calls = CopilotService.extractToolCalls({
    tool_calls: [
      { id: 'toolu_1', name: 'add_item', input: { text: 'milk' } },
      { id: 'call_2', function: { name: 'broken', arguments: '{not json' } },
      { id: 'call_3', function: {} },
    ],
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].function.arguments, { text: 'milk' });
  assert.deepEqual(calls[1].function.arguments, {});
});

test('contentToText flattens content blocks', () => {
  assert.equal(CopilotService.contentToText('hola'), 'hola');
  assert.equal(CopilotService.contentToText([{ type: 'text', text: 'ho' }, { type: 'text', text: 'la' }]), 'hola');
  assert.equal(CopilotService.contentToText(null), '');
});

test('parseCopilotQuota reads token-based billing in credits', () => {
  const q = CopilotService.parseCopilotQuota({
    copilot_plan: 'individual',
    quota_reset_date: '2026-11-01',
    quota_reset_date_utc: '2026-11-01T00:00:00.000Z',
    quota_snapshots: {
      chat: { unlimited: true },
      premium_interactions: {
        unlimited: false, entitlement: 1000, remaining: 620, percent_remaining: 62,
        overage_permitted: false, overage_count: 0, token_based_billing: true, credits_used: 380,
      },
    },
  });
  assert.equal(q.unit, 'credits');
  assert.equal(q.remaining, 620);
  assert.equal(q.used, 380);
  assert.equal(q.resetDate, '2026-11-01');
  assert.equal(CopilotService.formatCopilotQuota(q),
    '620 of 1,000 credits left (62%, $6.20) · used 380 · resets 2026-11-01');
});

test('parseCopilotQuota tolerates the older request shape, overage and missing fields', () => {
  const legacy = CopilotService.parseCopilotQuota({
    quota_reset_date: '2026-11-01',
    quota_snapshots: { premium_interactions: { entitlement: 300, remaining: 120, percent_remaining: 40 } },
  });
  assert.equal(legacy.unit, 'requests');
  assert.equal(legacy.used, 180);
  assert.equal(CopilotService.formatCopilotQuota(legacy),
    '120 of 300 requests left (40%) · used 180 · resets 2026-11-01');

  // Over the allowance (a Business seat reported remaining -740).
  const over = CopilotService.parseCopilotQuota({ quota_snapshots: { premium_interactions: {
    entitlement: 3000, remaining: -740, credits_used: 3739, token_based_billing: true, percent_remaining: 0 } } });
  assert.match(CopilotService.formatCopilotQuota(over), /^0 of 3,000 credits left \(0%, \$0\.00\) · used 3,739 · 740 over the allowance$/);

  assert.equal(CopilotService.parseCopilotQuota(null), null);
  assert.equal(CopilotService.parseCopilotQuota({}), null);
  assert.equal(CopilotService.formatCopilotQuota(CopilotService.parseCopilotQuota({
    quota_snapshots: { premium_interactions: { unlimited: true } } })), 'Unlimited');
});

test('quotaSpent measures a turn from two balances, or says it cannot', () => {
  const at = (used, remaining) => ({ unit: 'credits', used, remaining });
  assert.equal(CopilotService.quotaSpent(at(380, 620), at(392, 608)), 12);
  assert.equal(CopilotService.quotaSpent(at(null, 620), at(null, 600)), 20);
  assert.equal(CopilotService.quotaSpent(at(null, null), at(null, null)), null);
  assert.equal(CopilotService.quotaSpent(null, at(1, 1)), null);
  assert.equal(CopilotService.quotaSpent(at(1, 1), { unit: 'requests', used: 2, remaining: 0 }), null);
});

test('parseCopilotQuota: token-billed seat with zero allowance shows consumption, not "0 of 0"', () => {
  // Win-CodexBar: Business seats report entitlement 0 and keep usage in credits_used.
  const q = CopilotService.parseCopilotQuota({
    copilot_plan: 'business', token_based_billing: true, quota_reset_date: '2026-11-01',
    quota_snapshots: {
      premium_interactions: { entitlement: 0, remaining: 0, percent_remaining: 0, credits_used: 1234.5 },
      chat: { entitlement: 0, remaining: 0, percent_remaining: 0 },
    },
  });
  assert.equal(q.unit, 'credits');
  assert.equal(q.entitlement, null);
  assert.equal(q.remaining, null);
  assert.equal(q.percentRemaining, null);
  assert.equal(CopilotService.formatCopilotQuota(q),
    '1,234.5 credits used ($12.35), allowance not reported · resets 2026-11-01');
});

test('parseCopilotQuota: placeholder snapshots are skipped, Free plan reads limited_user_quotas', () => {
  const q = CopilotService.parseCopilotQuota({
    quota_snapshots: {
      premium_interactions: { placeholder: true, entitlement: 0 },
      chat: { entitlement: 50, remaining: 20 },
    },
  });
  assert.equal(q.remaining, 20);
  assert.equal(Math.round(q.percentRemaining), 40);

  const free = CopilotService.parseCopilotQuota({ copilot_plan: 'free', limited_user_quotas: { chat: 30 }, monthly_quotas: { chat: 50 } });
  assert.equal(CopilotService.formatCopilotQuota(free), '30 of 50 chat messages left (60%) · used 20');
});

test('mergeChoices keeps text and tool calls that Copilot split across choices', () => {
  // Claude via Copilot: the sentence in one choice, the call in the next.
  const merged = CopilotService.mergeChoices([
    { finish_reason: 'stop', message: { role: 'assistant', content: 'Opening the booking form.' } },
    { finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'start_booking', arguments: '{}' } }] } },
  ]);
  assert.equal(merged.count, 2);
  assert.equal(merged.finishReason, 'tool_calls');
  assert.equal(merged.message.content, 'Opening the booking form.');
  assert.equal(merged.message.tool_calls.length, 1);
  assert.equal(CopilotService.extractToolCalls(merged.message)[0].function.name, 'start_booking');

  const single = CopilotService.mergeChoices([{ finish_reason: 'stop', message: { content: 'Hi' } }]);
  assert.deepEqual(single.message, { role: 'assistant', content: 'Hi' });
  assert.equal(CopilotService.mergeChoices([]), null);
});
