'use strict';

const test = require('node:test');
const assert = require('node:assert');
const S = require('../lib/webmcp-schema.js');

/** The reproduction case: a native RegisteredTool from a declarative form. */
const CREATE_FEATURE_SCHEMA = {
  type: 'object',
  required: ['title', 'description', 'triggerType', 'priority'],
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    triggerType: {
      type: 'string',
      enum: ['MarketNeed', 'ChangeRequest', 'Defect', 'AutomatedSource'],
    },
    priority: { type: 'string', enum: ['P1', 'P2', 'P3'] },
  },
};

const createFeatureTool = () => ({
  name: 'createFeature',
  description: 'Creates a new feature...',
  origin: 'https://app-sage-cowork-fe-qa.azurewebsites.net',
  inputSchema: JSON.stringify(CREATE_FEATURE_SCHEMA),
});

// --- 1. A stringified inputSchema is parsed -------------------------------

test('parses a JSON-serialized inputSchema', () => {
  const schema = S.normalizeInputSchema(createFeatureTool().inputSchema);
  assert.deepStrictEqual(schema, CREATE_FEATURE_SCHEMA);
});

// --- 2. An object inputSchema is left alone -------------------------------

test('returns an object inputSchema unchanged, by reference', () => {
  const original = { type: 'object', properties: { a: { type: 'string' } } };
  assert.strictEqual(S.normalizeInputSchema(original), original);
});

test('an absent schema becomes an empty object schema, not a shared instance', () => {
  const first = S.normalizeInputSchema(undefined);
  const second = S.normalizeInputSchema(null);
  assert.deepStrictEqual(first, { type: 'object', properties: {} });
  assert.notStrictEqual(first, second, 'callers must not share one mutable object');
});

// --- 3. Required fields are visible ---------------------------------------

test('required fields survive normalization and reach the inspector', () => {
  const schema = S.normalizeInputSchema(createFeatureTool().inputSchema);
  assert.deepStrictEqual(
    S.propertyNames(schema),
    ['title', 'description', 'triggerType', 'priority']
  );
  assert.deepStrictEqual(
    S.requiredNames(schema),
    ['title', 'description', 'triggerType', 'priority']
  );
});

test('a parsed schema never reports "No input needed"', () => {
  const schema = S.normalizeInputSchema(createFeatureTool().inputSchema);
  const summary = S.describeNeeds(S.propertyNames(schema), S.requiredNames(schema));
  assert.notStrictEqual(summary, 'No input needed.');
  assert.match(summary, /^Needs 4 details/);
});

test('a genuinely parameterless tool still reports "No input needed"', () => {
  const schema = S.normalizeInputSchema('{"type":"object","properties":{}}');
  assert.strictEqual(S.describeNeeds(S.propertyNames(schema), S.requiredNames(schema)), 'No input needed.');
});

// --- 4. Enum and anyOf reach the model unchanged --------------------------

test('enum values are preserved verbatim', () => {
  const schema = S.normalizeInputSchema(createFeatureTool().inputSchema);
  assert.deepStrictEqual(
    schema.properties.triggerType.enum,
    ['MarketNeed', 'ChangeRequest', 'Defect', 'AutomatedSource']
  );
  assert.deepStrictEqual(schema.properties.priority.enum, ['P1', 'P2', 'P3']);
});

test('property names are never rewritten', () => {
  const schema = S.normalizeInputSchema(createFeatureTool().inputSchema);
  assert.ok('triggerType' in schema.properties, 'triggerType must survive as declared');
  assert.ok(!('trigger_type' in schema.properties), 'no snake_case rewriting');
});

test('anyOf, titles and descriptions survive', () => {
  const source = JSON.stringify({
    type: 'object',
    properties: {
      when: {
        title: 'When',
        description: 'A date or a keyword',
        anyOf: [{ type: 'string', format: 'date' }, { type: 'string', enum: ['today', 'tomorrow'] }],
      },
    },
  });
  const schema = S.normalizeInputSchema(source);
  assert.strictEqual(schema.properties.when.title, 'When');
  assert.strictEqual(schema.properties.when.description, 'A date or a keyword');
  assert.strictEqual(schema.properties.when.anyOf.length, 2);
  assert.deepStrictEqual(schema.properties.when.anyOf[1].enum, ['today', 'tomorrow']);
});

// --- 5. Invalid JSON is reported, not swallowed ---------------------------

test('invalid JSON throws rather than degrading to an empty schema', () => {
  assert.throws(() => S.normalizeInputSchema('{ not json'), SyntaxError);
});

test('a JSON scalar or array is rejected as an inputSchema', () => {
  assert.throws(() => S.normalizeInputSchema('"just a string"'), TypeError);
  assert.throws(() => S.normalizeInputSchema('[1,2,3]'), TypeError);
});

test('safeNormalizeInputSchema surfaces the error for the inspector', () => {
  const result = S.safeNormalizeInputSchema('{ not json');
  assert.ok(result.error, 'an error message must be available to display');
  assert.deepStrictEqual(result.schema, { type: 'object', properties: {} });

  const ok = S.safeNormalizeInputSchema(createFeatureTool().inputSchema);
  assert.strictEqual(ok.error, null);
});

// --- 6 & 7. Execution uses the RegisteredTool object ----------------------

test('resolveRegisteredTool returns the exact object getTools() handed back', async () => {
  const live = createFeatureTool();
  const context = {
    getTools: async () => [live],
    executeTool: async () => 'unused',
  };
  const resolved = await S.resolveRegisteredTool([context], 'createFeature', live.origin);
  assert.strictEqual(resolved.tool, live, 'must be the same reference, not a copy');
  assert.strictEqual(resolved.context, context);
});

test('execution passes the tool object, never the tool name', async () => {
  const live = createFeatureTool();
  let received;
  const context = {
    getTools: async () => [live],
    executeTool: async (tool, args) => {
      if (typeof tool === 'string') {
        throw new TypeError(
          "Failed to execute 'executeTool' on 'ModelContext': "
          + "The provided value is not of type 'RegisteredTool'."
        );
      }
      received = { tool, args };
      return 'ok';
    },
  };

  const resolved = await S.resolveRegisteredTool([context], 'createFeature', null);
  const result = await resolved.context.executeTool(resolved.tool, { title: 'x' });

  assert.strictEqual(result, 'ok');
  assert.strictEqual(received.tool, live);
  assert.deepStrictEqual(received.args, { title: 'x' });
});

test('a re-registered tool resolves to the current object, not a stale one', async () => {
  const first = createFeatureTool();
  const second = createFeatureTool();
  let handed = first;
  const context = { getTools: async () => [handed], executeTool: async () => 'ok' };

  const before = await S.resolveRegisteredTool([context], 'createFeature', null);
  assert.strictEqual(before.tool, first);

  handed = second; // the page re-registers between discovery and execution
  const after = await S.resolveRegisteredTool([context], 'createFeature', null);
  assert.strictEqual(after.tool, second);
  assert.notStrictEqual(after.tool, first);
});

test('origin disambiguates same-named tools', async () => {
  const a = { name: 'createFeature', origin: 'https://a.example' };
  const b = { name: 'createFeature', origin: 'https://b.example' };
  const context = { getTools: async () => [a, b], executeTool: async () => 'ok' };

  assert.strictEqual((await S.resolveRegisteredTool([context], 'createFeature', 'https://b.example')).tool, b);
  // Unknown origin still resolves by name rather than failing outright.
  assert.strictEqual((await S.resolveRegisteredTool([context], 'createFeature', 'https://c.example')).tool, a);
});

// --- 8. Missing or unregistered tools -------------------------------------

test('an unregistered tool resolves to null so the caller can report it', async () => {
  const context = { getTools: async () => [createFeatureTool()], executeTool: async () => 'ok' };
  assert.strictEqual(await S.resolveRegisteredTool([context], 'deleteEverything', null), null);
});

test('a context without the current API is skipped, not misused', async () => {
  const legacy = { callTool: async () => 'legacy' };
  assert.strictEqual(S.supportsRegisteredToolApi(legacy), false);
  assert.strictEqual(await S.resolveRegisteredTool([legacy], 'createFeature', null), null);
});

test('a context whose getTools() throws does not abort the search', async () => {
  const broken = { getTools: async () => { throw new Error('detached'); }, executeTool: async () => 'x' };
  const live = createFeatureTool();
  const working = { getTools: async () => [live], executeTool: async () => 'ok' };
  const resolved = await S.resolveRegisteredTool([broken, working], 'createFeature', null);
  assert.strictEqual(resolved.tool, live);
});

// --- 9 & 10. Full reproduction --------------------------------------------

test('the createFeature reproduction exposes exactly its four inputs', () => {
  const tool = createFeatureTool();
  const { schema, error } = S.safeNormalizeInputSchema(tool.inputSchema);
  assert.strictEqual(error, null);
  assert.deepStrictEqual(
    S.propertyNames(schema).sort(),
    ['description', 'priority', 'title', 'triggerType']
  );
});

test('the schema handed to the model carries the allowed enum values', () => {
  const tool = createFeatureTool();
  const { schema } = S.safeNormalizeInputSchema(tool.inputSchema);
  // This is what toOllamaTool() puts in function.parameters.
  const parameters = schema;
  assert.deepStrictEqual(
    parameters.properties.triggerType.enum,
    ['MarketNeed', 'ChangeRequest', 'Defect', 'AutomatedSource']
  );
  assert.deepStrictEqual(parameters.properties.priority.enum, ['P1', 'P2', 'P3']);
  assert.ok(!parameters.properties.triggerType.enum.includes('User Story'));
  assert.ok(!parameters.properties.priority.enum.includes('High'));
});

// --- Naming helpers -------------------------------------------------------

test('name heuristics match whole tokens, so `update` is not a date', () => {
  assert.deepStrictEqual(S.tokens('updateDate'), ['update', 'date']);
  assert.deepStrictEqual(S.tokens('update'), ['update']);
  assert.ok(!S.tokens('update').includes('date'));
});

test('humanize keeps camelCase readable without renaming the property', () => {
  assert.strictEqual(S.humanize('triggerType'), 'Trigger Type');
  assert.strictEqual(S.humanize('confirmation_id'), 'Confirmation Id');
});

// --- Enhanced parsing & execution tests -----------------------------------

test('parses markdown-fenced inputSchema', () => {
  const fenced = '```json\n{"type":"object","properties":{"query":{"type":"string"}}}\n```';
  const schema = S.normalizeInputSchema(fenced);
  assert.deepStrictEqual(schema, { type: 'object', properties: { query: { type: 'string' } } });
});

test('parses double-stringified inputSchema', () => {
  const doubleStringified = JSON.stringify(JSON.stringify({ type: 'object', properties: { id: { type: 'number' } } }));
  const schema = S.normalizeInputSchema(doubleStringified);
  assert.deepStrictEqual(schema, { type: 'object', properties: { id: { type: 'number' } } });
});

test('callExecuteTool invokes tool.execute() directly if present on tool object', async () => {
  let executedWith;
  const tool = {
    name: 'directTool',
    execute: async (args) => {
      executedWith = typeof args === 'string' ? JSON.parse(args) : args;
      return { success: true };
    },
  };
  const result = await S.callExecuteTool(null, tool, { foo: 'bar' });
  assert.deepStrictEqual(result, { success: true });
  assert.deepStrictEqual(executedWith, { foo: 'bar' });
});

test('callExecuteTool falls back to context.executeTool(tool.name, args) if tool object is rejected', async () => {
  let calledName;
  let calledArgs;
  const context = {
    executeTool: async (target, args) => {
      if (typeof target !== 'string') {
        throw new TypeError("Failed to execute 'executeTool': The provided value is not of type 'RegisteredTool'.");
      }
      calledName = target;
      calledArgs = typeof args === 'string' ? JSON.parse(args) : args;
      return 'fallback_ok';
    },
  };
  const tool = { name: 'myTool' };
  const result = await S.callExecuteTool(context, tool, { a: 1 });
  assert.strictEqual(result, 'fallback_ok');
  assert.strictEqual(calledName, 'myTool');
  assert.deepStrictEqual(calledArgs, { a: 1 });
});

test('isMultiStepRequest: lists and "step 1" yes, one-shot requests no', () => {
  assert.equal(S.isMultiStepRequest('1. open the form\n2. fill it\n3. save'), true);
  assert.equal(S.isMultiStepRequest('Step 1: open the form, then fill it'), true);
  assert.equal(S.isMultiStepRequest('- open\n- fill'), true);
  assert.equal(S.isMultiStepRequest('add buy bread'), false);
  assert.equal(S.isMultiStepRequest('create a contact for Ana, then tell me'), false);
});

test('toolSignature ignores order', () => {
  assert.equal(S.toolSignature([{ name: 'b' }, { name: 'a' }]), S.toolSignature([{ name: 'a' }, { name: 'b' }]));
  assert.notEqual(S.toolSignature([{ name: 'a' }]), S.toolSignature([{ name: 'a' }, { name: 'b' }]));
});

test('roundSucceeded rejects failures, cancellations and empty rounds', () => {
  assert.equal(S.roundSucceeded([{ content: 'Form opened. SUCCESS' }]), true);
  assert.equal(S.roundSucceeded([{ content: 'Error: boom' }]), false);
  assert.equal(S.roundSucceeded([{ content: 'Status: FAILED' }]), false);
  assert.equal(S.roundSucceeded([{ content: 'The user cancelled this tool call.' }]), false);
  assert.equal(S.roundSucceeded([]), false);
});

test('shouldNudge: only multi-step, after success, not on questions, bounded', () => {
  const base = {
    request: '1. open\n2. fill',
    reply: { content: 'Opened the form.' },
    lastRound: [{ content: 'SUCCESS' }],
    nudges: 0,
    maxNudges: 10,
  };
  assert.equal(S.shouldNudge(base), true);
  assert.equal(S.shouldNudge({ ...base, request: 'open the form' }), false);
  assert.equal(S.shouldNudge({ ...base, lastRound: [{ content: 'Error: x' }] }), false);
  assert.equal(S.shouldNudge({ ...base, lastRound: [] }), false);
  assert.equal(S.shouldNudge({ ...base, reply: { content: 'Which company name should I use?' } }), false);
  assert.equal(S.shouldNudge({ ...base, nudges: 10 }), false);
});

test('recorder quality presets match the copy in background.js', () => {
  const fs = require('node:fs');
  const R = require('../lib/recorder.js');
  const bg = fs.readFileSync(require('node:path').join(__dirname, '..', 'background.js'), 'utf8');
  for (const [name, preset] of Object.entries(R.QUALITY)) {
    const pattern = new RegExp(`${name}:\\s*\\{\\s*fps:\\s*${preset.fps},\\s*bitrate:\\s*${String(preset.bitrate).replace(/(\d)(?=(\d{3})+$)/g, '$1_')}\\s*\\}`);
    assert.match(bg, pattern, `background.js QUALITY.${name} differs from lib/recorder.js`);
  }
});
