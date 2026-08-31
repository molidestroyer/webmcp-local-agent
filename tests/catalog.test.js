'use strict';

const test = require('node:test');
const assert = require('node:assert');
const C = require('../lib/catalog-service.js');

test('validates correct catalog schema', () => {
  const result = C.validateCatalogSchema(C.DEFAULT_LOCAL_CATALOG);
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.error, null);
});

test('rejects invalid catalog schema lacking rules', () => {
  const result = C.validateCatalogSchema({ version: '1.0' });
  assert.strictEqual(result.valid, false);
  assert.ok(result.error.includes('rules'));
});

test('resolves context by URL pattern (ZA)', () => {
  const url = 'https://example.com/app/dashboard?region=za';
  const tools = [{ name: 'create_contact' }];
  const res = C.resolveContext(url, tools);

  assert.strictEqual(res.matchedRules.length, 1);
  assert.strictEqual(res.matchedRules[0].id, 'contacts-za');
  assert.ok(res.systemContext.includes('ZA'));
  assert.ok(res.suggestedPrompts.some(p => p.includes('Sudáfrica')));
});

test('resolves context by URL pattern (ES)', () => {
  const url = 'https://empresa.es/contactos';
  const tools = [{ name: 'create_contact' }];
  const res = C.resolveContext(url, tools);

  assert.strictEqual(res.matchedRules.length, 1);
  assert.strictEqual(res.matchedRules[0].id, 'contacts-es');
  assert.ok(res.systemContext.includes('DNI'));
});

test('resolves context by required tools without urlPattern constraint', () => {
  const customCatalog = {
    version: '1.0',
    rules: [
      {
        id: 'r1',
        name: 'Generic Tool Rule',
        match: { requiredTools: ['create_contact'] },
        systemContext: 'Generic Tool Context',
        suggestedPrompts: ['Generic Prompt']
      }
    ]
  };
  const url = 'https://generic-domain.com/';
  const tools = [{ name: 'create_contact' }];
  const res = C.resolveContext(url, tools, customCatalog);

  assert.strictEqual(res.matchedRules.length, 1);
  assert.strictEqual(res.suggestedPrompts[0], 'Generic Prompt');
});

test('returns empty context when no rules match', () => {
  const url = 'https://generic-domain.com/';
  const tools = [{ name: 'other_unrelated_tool' }];
  const res = C.resolveContext(url, tools);

  assert.strictEqual(res.matchedRules.length, 0);
  assert.strictEqual(res.suggestedPrompts.length, 0);
  assert.strictEqual(res.systemContext, '');
});
