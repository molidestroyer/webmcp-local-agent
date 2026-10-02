'use strict';

const test = require('node:test');
const assert = require('node:assert');

// Just enough of the browser for lib/recorder.js: a track that can end, and a MediaRecorder
// that stops by itself when it does, the way Chrome's does.
function fakeBrowser() {
  const listeners = [];
  const track = {
    stopped: false,
    stop() { this.stopped = true; },
    addEventListener(type, fn) { if (type === 'ended') listeners.push(fn); },
    end() { listeners.forEach((fn) => fn()); },
  };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  let live = null;
  class FakeMediaRecorder {
    static isTypeSupported() { return true; }
    constructor() { this.state = 'inactive'; this.stopCalls = 0; live = this; }
    start() { this.state = 'recording'; }
    stop() {
      this.stopCalls++;
      if (this.state === 'inactive') throw new Error('InvalidStateError');
      this.state = 'inactive';
      setTimeout(() => {
        this.ondataavailable({ data: new Blob(['frame']) });
        this.onstop();
      }, 0);
    }
  }
  Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: { getUserMedia: async () => stream } }, configurable: true, writable: true });
  globalThis.MediaRecorder = FakeMediaRecorder;
  return { track, recorder: () => live };
}

const R = require('../lib/recorder.js');

test('stop() saves normally', async () => {
  const fake = fakeBrowser();
  const rec = R.createRecorder();
  await rec.start({ streamId: 'id', fps: 30, bitrate: 1 });
  const out = await rec.stop();
  assert.ok(out.size > 0 && out.url.startsWith('blob:'));
  assert.strictEqual(fake.track.stopped, true);
  assert.strictEqual(rec.isRecording(), false);
});

test('a capture that ends on its own reports it, and stop() still returns the video', async () => {
  const fake = fakeBrowser();
  const rec = R.createRecorder();
  let ended = 0;
  await rec.start({ streamId: 'id', fps: 30, bitrate: 1, onEnded: () => { ended++; } });
  // Tab closed / "Stop sharing": the track ends and the recorder stops itself.
  fake.track.end();
  fake.recorder().stop();
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(ended, 1);
  const out = await Promise.race([
    rec.stop(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('stop() hung')), 200)),
  ]);
  assert.ok(out.size > 0);
  assert.strictEqual(fake.recorder().stopCalls, 1, 'an inactive recorder is not stopped again');
});

test('a second stop() is refused instead of stopping twice', async () => {
  fakeBrowser();
  const rec = R.createRecorder();
  await rec.start({ streamId: 'id', fps: 30, bitrate: 1 });
  const first = rec.stop();
  await assert.rejects(rec.stop(), /No recording in progress/);
  assert.ok((await first).size > 0);
});
