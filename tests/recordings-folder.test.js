'use strict';

const test = require('node:test');
const assert = require('node:assert');
const F = require('../lib/recordings-folder.js');

function fakeHandle({ query = 'granted', request = 'granted', failWrite = false } = {}) {
  const files = new Map();
  return {
    files,
    queryPermission: async () => query,
    requestPermission: async () => request,
    getFileHandle: async (name) => ({
      createWritable: async () => {
        let data = null;
        return {
          write: async (chunk) => {
            if (failWrite) throw new Error('disk full');
            data = chunk;
          },
          close: async () => files.set(name, data),
        };
      },
    }),
  };
}

test('writes a file into the folder', async () => {
  const dir = fakeHandle();
  await F.writeFile(dir, 'a.log', 'hello');
  assert.strictEqual(dir.files.get('a.log'), 'hello');
});

test('a failed write still closes the file and rejects', async () => {
  const dir = fakeHandle({ failWrite: true });
  await assert.rejects(F.writeFile(dir, 'a.log', 'x'), /disk full/);
  assert.ok(dir.files.has('a.log'));
});

test('permission: granted, asked once when in prompt state, or refused', async () => {
  assert.strictEqual(await F.ensurePermission(fakeHandle()), true);
  assert.strictEqual(await F.ensurePermission(fakeHandle({ query: 'prompt', request: 'granted' })), true);
  assert.strictEqual(await F.ensurePermission(fakeHandle({ query: 'prompt', request: 'denied' })), false);
  assert.strictEqual(await F.ensurePermission(null), false);
});

test('a request without a user gesture just means "not now"', async () => {
  const handle = fakeHandle({ query: 'prompt' });
  handle.requestPermission = async () => { throw new Error('User activation is required'); };
  assert.strictEqual(await F.ensurePermission(handle), false);
});
