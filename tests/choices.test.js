'use strict';

const test = require('node:test');
const assert = require('node:assert');
const S = require('../lib/webmcp-schema.js');

/** The reported createFeature schema, with anyOf *and* enum on triggerType. */
const CREATE_FEATURE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'A short, descriptive title for the feature.' },
    description: { type: 'string', description: 'A detailed explanation of the feature.' },
    triggerType: {
      type: 'string',
      anyOf: [
        { type: 'string', const: 'MarketNeed', title: 'Market need' },
        { type: 'string', const: 'ChangeRequest', title: 'Change request' },
        { type: 'string', const: 'Defect', title: 'Defect' },
        { type: 'string', const: 'AutomatedSource', title: 'Automated source' },
      ],
      enum: ['MarketNeed', 'ChangeRequest', 'Defect', 'AutomatedSource'],
      description: 'What initiated the feature.',
    },
    priority: { type: 'string', enum: ['P1', 'P2', 'P3'], description: 'Feature priority.' },
  },
  required: ['title', 'description', 'triggerType', 'priority'],
};

const values = (choices) => choices.map((choice) => choice.value);
const labels = (choices) => choices.map((choice) => choice.label);

// --- 1. Plain string properties are untouched -----------------------------

test('a string property without choices keeps the existing display', () => {
  assert.deepStrictEqual(S.getDisplayChoices({ type: 'string' }), []);
  assert.deepStrictEqual(
    S.getDisplayChoices(CREATE_FEATURE_SCHEMA.properties.title),
    [],
    'title has no declared choices and must render as before'
  );
});

test('non-object and empty inputs are handled without throwing', () => {
  assert.deepStrictEqual(S.getDisplayChoices(null), []);
  assert.deepStrictEqual(S.getDisplayChoices(undefined), []);
  assert.deepStrictEqual(S.getDisplayChoices('string'), []);
  assert.deepStrictEqual(S.getDisplayChoices({ enum: [] }), []);
  assert.deepStrictEqual(S.getDisplayChoices({ anyOf: [] }), []);
});

// --- 2. A direct enum is displayed ----------------------------------------

test('a direct enum exposes every value', () => {
  const choices = S.getDisplayChoices(CREATE_FEATURE_SCHEMA.properties.priority);
  assert.deepStrictEqual(values(choices), ['P1', 'P2', 'P3']);
  assert.deepStrictEqual(labels(choices), ['P1', 'P2', 'P3']);
});

test('non-string enum values survive as their own type', () => {
  const choices = S.getDisplayChoices({ type: 'number', enum: [1, 2, 3] });
  assert.deepStrictEqual(values(choices), [1, 2, 3]);
  assert.deepStrictEqual(labels(choices), ['1', '2', '3']);
});

// --- 3. anyOf + const -----------------------------------------------------

test('anyOf entries carrying const expose their values', () => {
  const property = { type: 'string', anyOf: CREATE_FEATURE_SCHEMA.properties.triggerType.anyOf };
  const choices = S.getDisplayChoices(property);
  assert.deepStrictEqual(
    values(choices),
    ['MarketNeed', 'ChangeRequest', 'Defect', 'AutomatedSource']
  );
});

test('anyOf branches without const are skipped, not rendered as blanks', () => {
  const choices = S.getDisplayChoices({
    anyOf: [{ type: 'string', const: 'A' }, { type: 'null' }, { type: 'string' }],
  });
  assert.deepStrictEqual(values(choices), ['A']);
});

test('oneOf is read the same way as anyOf', () => {
  const choices = S.getDisplayChoices({
    oneOf: [{ const: 'yes', title: 'Yes' }, { const: 'no', title: 'No' }],
  });
  assert.deepStrictEqual(values(choices), ['yes', 'no']);
  assert.deepStrictEqual(labels(choices), ['Yes', 'No']);
});

// --- 4. enum wins over anyOf ----------------------------------------------

test('a direct enum takes precedence when both enum and anyOf are present', () => {
  const choices = S.getDisplayChoices(CREATE_FEATURE_SCHEMA.properties.triggerType);
  assert.strictEqual(choices.length, 4, 'the four choices must not be listed twice');
  assert.deepStrictEqual(
    values(choices),
    ['MarketNeed', 'ChangeRequest', 'Defect', 'AutomatedSource']
  );
  // With enum winning, labels are the constants themselves.
  assert.deepStrictEqual(labels(choices), values(choices).map(String));
});

// --- 5. Required markers are unaffected -----------------------------------

test('required parameters keep their required marker', () => {
  const required = S.requiredNames(CREATE_FEATURE_SCHEMA);
  assert.deepStrictEqual(required, ['title', 'description', 'triggerType', 'priority']);
  for (const key of ['triggerType', 'priority']) {
    assert.ok(required.includes(key), key + ' must still be marked required');
  }
});

test('adding choices does not change what the inspector says a tool needs', () => {
  const summary = S.describeNeeds(
    S.propertyNames(CREATE_FEATURE_SCHEMA),
    S.requiredNames(CREATE_FEATURE_SCHEMA)
  );
  assert.match(summary, /^Needs 4 details/);
});

// --- 6. Titles are labels, never replacements -----------------------------

test('a human-readable title never replaces the real constant', () => {
  const choices = S.getDisplayChoices({
    anyOf: [{ const: 'MarketNeed', title: 'Market need' }],
  });
  assert.strictEqual(choices[0].value, 'MarketNeed', 'the constant is what gets sent');
  assert.strictEqual(choices[0].label, 'Market need');
  assert.notStrictEqual(choices[0].value, choices[0].label);
});

test('formatChoice shows the constant alongside a differing label', () => {
  assert.strictEqual(
    S.formatChoice({ value: 'MarketNeed', label: 'Market need' }),
    'Market need (MarketNeed)'
  );
  // No parenthetical noise when the label adds nothing.
  assert.strictEqual(S.formatChoice({ value: 'P1', label: 'P1' }), 'P1');
});

test('a blank or non-string title falls back to the constant', () => {
  const choices = S.getDisplayChoices({
    anyOf: [{ const: 'A', title: '' }, { const: 'B', title: 42 }],
  });
  assert.deepStrictEqual(labels(choices), ['A', 'B']);
});

// --- 7. The model receives the schema unchanged ---------------------------

test('the tool schema sent to the model keeps enum, anyOf, const and required', () => {
  const tool = {
    name: 'createFeature',
    description: 'Creates a new feature...',
    inputSchema: JSON.stringify(CREATE_FEATURE_SCHEMA),
  };
  const parameters = S.toOllamaTool(tool).function.parameters;

  assert.deepStrictEqual(parameters.required, ['title', 'description', 'triggerType', 'priority']);
  assert.deepStrictEqual(parameters.properties.priority.enum, ['P1', 'P2', 'P3']);
  assert.deepStrictEqual(
    parameters.properties.triggerType.enum,
    ['MarketNeed', 'ChangeRequest', 'Defect', 'AutomatedSource']
  );
  assert.strictEqual(parameters.properties.triggerType.anyOf.length, 4);
  assert.strictEqual(parameters.properties.triggerType.anyOf[0].const, 'MarketNeed');
  assert.strictEqual(parameters.properties.triggerType.anyOf[0].title, 'Market need');
  assert.strictEqual(
    parameters.properties.triggerType.description,
    'What initiated the feature.'
  );
});

test('a constrained property is never flattened to a bare type', () => {
  const tool = { name: 't', inputSchema: JSON.stringify(CREATE_FEATURE_SCHEMA) };
  const priority = S.toOllamaTool(tool).function.parameters.properties.priority;
  assert.notDeepStrictEqual(priority, { type: 'string' });
  assert.ok(Array.isArray(priority.enum));
});

test('the model definition carries the tool name and description verbatim', () => {
  const definition = S.toOllamaTool({
    name: 'createFeature',
    description: 'Creates a new feature...',
    inputSchema: JSON.stringify(CREATE_FEATURE_SCHEMA),
  });
  assert.strictEqual(definition.type, 'function');
  assert.strictEqual(definition.function.name, 'createFeature');
  assert.strictEqual(definition.function.description, 'Creates a new feature...');
});

test('normalizeToolSchemaForModel only fills in a missing type or properties', () => {
  const source = { properties: { a: { type: 'string', enum: ['x'] } }, required: ['a'] };
  const out = S.normalizeToolSchemaForModel(source);
  assert.strictEqual(out.type, 'object');
  assert.deepStrictEqual(out.properties, source.properties);
  assert.deepStrictEqual(out.required, ['a']);
  assert.strictEqual(out.properties.a, source.properties.a, 'nested schemas are not rebuilt');
});

// --- 8. No runtime validation is introduced -------------------------------

test('the schema helpers expose no validator', () => {
  const names = Object.keys(S);
  assert.ok(
    !names.some((name) => /^(validate|assert|check)/i.test(name)),
    'no validation entry point may exist: the page owns that job. Found: ' + names.join(', ')
  );
});

test('an out-of-enum value reaches the page untouched', async () => {
  const live = { name: 'createFeature', origin: 'https://example.test' };
  let received;
  const context = {
    getTools: async () => [live],
    executeTool: async (tool, args) => { received = args; return 'page decides'; },
  };

  const resolved = await S.resolveRegisteredTool([context], 'createFeature', live.origin);
  // "Urgent" is not in ['P1','P2','P3']; the extension must not intervene.
  const args = { title: 't', description: 'd', triggerType: 'Defect', priority: 'Urgent' };
  const result = await resolved.context.executeTool(resolved.tool, args);

  assert.strictEqual(result, 'page decides');
  assert.deepStrictEqual(received, args, 'arguments must not be filtered or coerced');
  assert.strictEqual(received.priority, 'Urgent');
});

test('getDisplayChoices reports choices without judging a value against them', () => {
  const choices = S.getDisplayChoices(CREATE_FEATURE_SCHEMA.properties.priority);
  // Deliberately absent: any includes()/isValid() style API. Callers that want
  // to know would have to ask the list themselves, and none of ours do.
  assert.ok(Array.isArray(choices));
  assert.strictEqual(typeof choices.isValid, 'undefined');
});
