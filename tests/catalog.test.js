'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../lib/catalog-service.js');

const byId = (id) => C.DEMO_SAMPLE_CATALOG.rules.find((r) => r.id === id);
const HOTEL = 'https://googlechromelabs.github.io/webmcp-tools/demos/hotel-chain/#/book/champs';

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
  assert.deepStrictEqual(groups.map((g) => g.id), ['contacts-es', 'chromelabs-hotel-chain', 'contacts-za', 'contacts-ca']);
  assert.deepStrictEqual(groups.map((g) => g.matches), [true, false, false, false]);
  assert.ok(groups[0].prompts.length > 0 && groups[0].hasContext);
});

test('browsing without a matching page still offers everything', () => {
  const groups = C.browsePrompts(C.DEMO_SAMPLE_CATALOG, { url: 'https://other.test/', tools: [] });
  assert.strictEqual(groups.length, C.DEMO_SAMPLE_CATALOG.rules.length);
  assert.ok(groups.every((g) => g.matches === false));
});

test('browsing filters by prompt text, or by rule name keeping all its prompts', () => {
  const byText = C.browsePrompts(C.DEMO_SAMPLE_CATALOG, { query: 'dni' });
  assert.deepStrictEqual(byText.map((g) => g.id), ['contacts-es']);
  assert.ok(byText[0].prompts.every((p) => /dni/i.test(p)));
  const byRule = C.browsePrompts(C.DEMO_SAMPLE_CATALOG, { query: 'canada' });
  assert.deepStrictEqual(byRule.map((g) => g.id), ['contacts-ca']);
  assert.strictEqual(byRule[0].prompts.length, byId('contacts-ca').suggestedPrompts.length);
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
  const rule = byId('contacts-es');
  assert.strictEqual(C.ruleMatches(rule, 'https://x.test/?region=es', ['create_contact']), true);
  assert.strictEqual(C.ruleMatches(rule, 'https://x.test/?region=es', []), false);
  assert.strictEqual(C.ruleMatches({ id: 'x', name: 'x' }, 'https://x.test/', []), false);
});

test('the built-in sample and demo/catalog-sample.json are the same data', () => {
  const file = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'demo', 'catalog-sample.json'), 'utf8'));
  assert.deepStrictEqual(file, C.DEMO_SAMPLE_CATALOG);
});

test('the hotel-chain rule applies on every page of that demo, whatever tools are up', () => {
  const rule = byId('chromelabs-hotel-chain');
  for (const route of ['#/', '#/search?q=paris', '#/hotel/champs', '#/book/champs']) {
    const url = 'https://googlechromelabs.github.io/webmcp-tools/demos/hotel-chain/' + route;
    assert.strictEqual(C.ruleMatches(rule, url, ['search_location']), true, route);
  }
  assert.strictEqual(C.ruleMatches(rule, 'https://googlechromelabs.github.io/webmcp-tools/demos/other/', []), false);
  const res = C.resolveContext(HOTEL, [{ name: 'complete_booking' }], C.DEMO_SAMPLE_CATALOG);
  assert.deepStrictEqual(res.matchedRules.map((r) => r.id), ['chromelabs-hotel-chain']);
  // What an E2E run needs to stay honest: the real tools, and what the site does not have.
  for (const needle of ['search_location', 'complete_booking', 'start_booking', 'confirmation number', '$1386']) {
    assert.ok(res.systemContext.includes(needle), needle);
  }
});

test("scope 'page' keeps only this site's rules, including ones still waiting for their tools", () => {
  const onHotel = C.browsePrompts(C.DEMO_SAMPLE_CATALOG, { url: HOTEL, tools: [], scope: 'page' });
  assert.deepStrictEqual(onHotel.map((g) => g.id), ['chromelabs-hotel-chain']);
  assert.strictEqual(onHotel[0].here, true);
  const esNoTools = C.browsePrompts(C.DEMO_SAMPLE_CATALOG, { url: 'https://x.test/?region=es', tools: [], scope: 'page' });
  assert.deepStrictEqual(esNoTools.map((g) => [g.id, g.matches, g.here]), [['contacts-es', false, true]]);
  assert.deepStrictEqual(C.browsePrompts(C.DEMO_SAMPLE_CATALOG, { url: 'https://other.test/', scope: 'page' }), []);
});

test('the search takes /regex/ and also matches the urlPattern', () => {
  assert.deepStrictEqual(C.browsePrompts(C.DEMO_SAMPLE_CATALOG, { query: '/^contacts-(es|ca)$/' }).map((g) => g.id), ['contacts-es', 'contacts-ca']);
  assert.deepStrictEqual(C.browsePrompts(C.DEMO_SAMPLE_CATALOG, { query: 'hotel-chain' }).map((g) => g.id), ['chromelabs-hotel-chain']);
  const byPrompt = C.browsePrompts(C.DEMO_SAMPLE_CATALOG, { query: '/spa\\b/' });
  assert.deepStrictEqual(byPrompt.map((g) => g.id), ['chromelabs-hotel-chain']);
  assert.ok(byPrompt[0].prompts.every((p) => /spa\b/i.test(p)));
  assert.ok(C.parseQuery('/(/').error);
  assert.deepStrictEqual(C.browsePrompts(C.DEMO_SAMPLE_CATALOG, { query: '/(/' }), []);
  assert.strictEqual(C.parseQuery('plain').error, null);
});
