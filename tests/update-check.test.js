'use strict';

const test = require('node:test');
const assert = require('node:assert');
const UC = require('../lib/update-check.js');

test('parseVersion and compareVersions handle v-prefixed semver strings', () => {
  assert.deepStrictEqual(UC.parseVersion('v0.8.2'), [0, 8, 2]);
  assert.deepStrictEqual(UC.parseVersion('0.9.0-beta'), [0, 9, 0]);
  assert.strictEqual(UC.parseVersion('invalid'), null);

  assert.strictEqual(UC.isNewerVersion('v0.8.3', '0.8.2'), true);
  assert.strictEqual(UC.isNewerVersion('v0.9.0', '0.8.9'), true);
  assert.strictEqual(UC.isNewerVersion('v1.0.0', '0.99.99'), true);
  assert.strictEqual(UC.isNewerVersion('v0.8.2', '0.8.2'), false);
  assert.strictEqual(UC.isNewerVersion('v0.8.1', '0.8.2'), false);
});

test('shouldFetchUpdate respects 6-hour cache TTL unless forced', () => {
  const now = 1_700_000_000_000;
  assert.strictEqual(UC.shouldFetchUpdate(null, now), true);
  assert.strictEqual(UC.shouldFetchUpdate({ checkedAt: now - 1000 }, now), false);
  assert.strictEqual(UC.shouldFetchUpdate({ checkedAt: now - 1000 }, now, true), true);
  assert.strictEqual(UC.shouldFetchUpdate({ checkedAt: now - UC.CACHE_TTL_MS }, now), true);
});

test('checkLatestRelease detects newer release and zip asset', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({
      tag_name: 'v0.8.3',
      html_url: 'https://github.com/molidestroyer/webmcp-local-agent/releases/tag/v0.8.3',
      published_at: '2026-11-23T12:00:00Z',
      assets: [
        {
          name: 'webmcp-local-agent-0.8.3.zip',
          browser_download_url: 'https://github.com/molidestroyer/webmcp-local-agent/releases/download/v0.8.3/webmcp-local-agent-0.8.3.zip',
        },
      ],
    }),
  });

  const res = await UC.checkLatestRelease(fakeFetch, '0.8.2');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.updateAvailable, true);
  assert.strictEqual(res.latest.version, '0.8.3');
  assert.strictEqual(res.latest.zipName, 'webmcp-local-agent-0.8.3.zip');
  assert.ok(res.latest.zipUrl.endsWith('webmcp-local-agent-0.8.3.zip'));

  const upToDate = await UC.checkLatestRelease(fakeFetch, '0.8.3');
  assert.strictEqual(upToDate.ok, true);
  assert.strictEqual(upToDate.updateAvailable, false);
});

test('checkLatestRelease handles HTTP errors gracefully', async () => {
  const errFetch = async () => ({ ok: false, status: 403 });
  const res = await UC.checkLatestRelease(errFetch, '0.8.2');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.updateAvailable, false);
  assert.ok(res.error.includes('403'));
});
