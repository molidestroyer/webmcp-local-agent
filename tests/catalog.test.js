'use strict';

const test = require('node:test');
const assert = require('node:assert');
const C = require('../lib/catalog-service.js');

test('validates correct catalog schema', () => {
  const result = C.validateCatalogSchema(C.DEMO_SAMPLE_CATALOG);
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
  const res = C.resolveContext(url, tools, C.DEMO_SAMPLE_CATALOG);

  assert.strictEqual(res.matchedRules.length, 1);
  assert.strictEqual(res.matchedRules[0].id, 'contacts-za');
  assert.ok(res.systemContext.includes('ZA'));
  assert.ok(res.suggestedPrompts.some(p => p.includes('South Africa')));
});

test('resolves context by URL pattern (ES)', () => {
  const url = 'https://empresa.es/contactos';
  const tools = [{ name: 'create_contact' }];
  const res = C.resolveContext(url, tools, C.DEMO_SAMPLE_CATALOG);

  assert.strictEqual(res.matchedRules.length, 1);
  assert.strictEqual(res.matchedRules[0].id, 'contacts-es');
  assert.ok(res.systemContext.includes('DNI'));
});

test('returns empty context when no tools are present on page', () => {
  const url = 'https://example.com/app/dashboard?region=za';
  const tools = []; // zero tools
  const res = C.resolveContext(url, tools, C.DEMO_SAMPLE_CATALOG);

  assert.strictEqual(res.matchedRules.length, 0);
  assert.strictEqual(res.suggestedPrompts.length, 0);
  assert.strictEqual(res.systemContext, '');
});

test('returns empty context when no rules match', () => {
  const url = 'https://generic-domain.com/';
  const tools = [{ name: 'other_unrelated_tool' }];
  const res = C.resolveContext(url, tools, C.DEMO_SAMPLE_CATALOG);

  assert.strictEqual(res.matchedRules.length, 0);
  assert.strictEqual(res.suggestedPrompts.length, 0);
  assert.strictEqual(res.systemContext, '');
});

test('lists a rule\'s prompts and flags entries that are not usable text', () => {
  const rule = { id: 'r', name: 'R', suggestedPrompts: ['Create a contact', '', 42, { a: 1 }] };
  assert.deepStrictEqual(C.listRulePrompts(rule), [
    { text: 'Create a contact', valid: true },
    { text: '', valid: false },
    { text: '42', valid: false },
    { text: '{"a":1}', valid: false },
  ]);
});

test('a rule without prompts lists none', () => {
  assert.deepStrictEqual(C.listRulePrompts({ id: 'r', name: 'R' }), []);
  assert.deepStrictEqual(C.listRulePrompts({ id: 'r', name: 'R', suggestedPrompts: 'oops' }), []);
  assert.deepStrictEqual(C.listRulePrompts(null), []);
});

test('the demo catalog prompts are all usable', () => {
  for (const rule of C.DEMO_SAMPLE_CATALOG.rules) {
    const prompts = C.listRulePrompts(rule);
    assert.ok(prompts.length > 0);
    assert.ok(prompts.every((p) => p.valid));
  }
});

test('browsing lists every rule, the ones for this page first', () => {
  const groups = C.browsePrompts(C.DEMO_SAMPLE_CATALOG, {
    url: 'https://x.test/app?region=es',
    tools: [{ name: 'create_contact' }],
  });
  assert.deepStrictEqual(groups.map((g) => g.id), ['contacts-es', 'contacts-za', 'contacts-ca']);
  assert.deepStrictEqual(groups.map((g) => g.matches), [true, false, false]);
  assert.ok(groups[0].prompts.length > 0 && groups[0].hasContext);
});

test('browsing without a matching page still offers everything', () => {
  const groups = C.browsePrompts(C.DEMO_SAMPLE_CATALOG, { url: 'https://other.test/', tools: [] });
  assert.strictEqual(groups.length, 3);
  assert.ok(groups.every((g) => g.matches === false));
});

test('browsing filters by prompt text, or by rule name keeping all its prompts', () => {
  const byText = C.browsePrompts(C.DEMO_SAMPLE_CATALOG, { query: 'dni' });
  assert.deepStrictEqual(byText.map((g) => g.id), ['contacts-es']);
  assert.ok(byText[0].prompts.every((p) => /dni/i.test(p)));
  const byRule = C.browsePrompts(C.DEMO_SAMPLE_CATALOG, { query: 'canada' });
  assert.deepStrictEqual(byRule.map((g) => g.id), ['contacts-ca']);
  assert.strictEqual(byRule[0].prompts.length, C.DEMO_SAMPLE_CATALOG.rules[2].suggestedPrompts.length);
  assert.deepStrictEqual(C.browsePrompts(C.DEMO_SAMPLE_CATALOG, { query: 'zzz-nothing' }), []);
});

test('browsing skips unusable entries and handles an empty or missing catalog', () => {
  const catalog = { rules: [{ id: 'a', name: 'A', suggestedPrompts: ['ok', '', 5] }, { id: 'b', name: 'B' }] };
  assert.deepStrictEqual(C.browsePrompts(catalog)[0].prompts, ['ok']);
  assert.strictEqual(C.browsePrompts(catalog).length, 1);
  assert.deepStrictEqual(C.browsePrompts(null), []);
  assert.deepStrictEqual(C.browsePrompts({ rules: [] }), []);
});

test('ruleMatches agrees with resolveContext', () => {
  const rule = C.DEMO_SAMPLE_CATALOG.rules[1];
  assert.strictEqual(C.ruleMatches(rule, 'https://x.test/?region=es', ['create_contact']), true);
  assert.strictEqual(C.ruleMatches(rule, 'https://x.test/?region=es', []), false);
  assert.strictEqual(C.ruleMatches({ id: 'x', name: 'x' }, 'https://x.test/', []), false);
});
