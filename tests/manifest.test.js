'use strict';

/**
 * The manifest's "key" pins the extension ID. Without it Chrome derives the ID from the
 * folder an unpacked extension is loaded from, and chrome.storage / IndexedDB (the Copilot
 * login, settings, chats, the recordings folder) are keyed by that ID: loading from another
 * folder silently starts from empty storage. Changing the key changes the ID for everyone,
 * so this test fails on purpose when it moves; update EXPECTED_ID only if that is intended.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const EXPECTED_ID = 'jiadmihhccjnmohgemenocmifipigolh';
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));

function extensionIdFor(base64Key) {
  const der = Buffer.from(base64Key, 'base64');
  const hex = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
  return [...hex].map((h) => String.fromCharCode(97 + parseInt(h, 16))).join('');
}

test('the manifest pins the extension ID with a public key', () => {
  assert.ok(manifest.key, 'manifest.json has no "key": the ID would depend on the folder');
  const key = crypto.createPublicKey({ key: Buffer.from(manifest.key, 'base64'), format: 'der', type: 'spki' });
  assert.strictEqual(key.asymmetricKeyType, 'rsa');
});

test('the pinned key yields the documented extension ID', () => {
  assert.strictEqual(extensionIdFor(manifest.key), EXPECTED_ID);
});
