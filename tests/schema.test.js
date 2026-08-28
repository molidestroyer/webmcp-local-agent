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
      executedWith = args;
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
      calledArgs = args;
      return 'fallback_ok';
    },
  };
  const tool = { name: 'myTool' };
  const result = await S.callExecuteTool(context, tool, { a: 1 });
  assert.strictEqual(result, 'fallback_ok');
  assert.strictEqual(calledName, 'myTool');
  assert.deepStrictEqual(calledArgs, { a: 1 });
});
