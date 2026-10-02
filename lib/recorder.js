/**
 * WebMCP Local Agent - lib/recorder.js
 *
 * MediaRecorder around a tab stream, shared by the two places that record:
 * the offscreen document (ids from tabCapture) and the side panel (ids from the
 * desktopCapture picker, which Chrome aborts when consumed anywhere else).
 */
(function (root, factory) {
  const api = factory();
  root.__WebMCPRecorder = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Mirrored in background.js (a module worker cannot load this classic script).
  const QUALITY = {
    standard: { fps: 30, bitrate: 2_500_000 },
    high: { fps: 30, bitrate: 6_000_000 },
    smooth: { fps: 60, bitrate: 8_000_000 },
  };

  function createRecorder() {
    let recorder = null;
    let stream = null;
    let chunks = [];
    let stopped = null; // resolves once the recorder has stopped, whoever stopped it

    /**
     * `onEnded` fires when the capture ends on its own: the recorded tab was closed, or the
     * user pressed Chrome's "Stop sharing". MediaRecorder then stops by itself, and a later
     * stop() must still hand back what was recorded instead of waiting for an onstop that
     * already fired (it used to hang there, leaving the Rec button disabled for good).
     */
    async function start({ streamId, source, fps, bitrate, onEnded }) {
      if (recorder) throw new Error('A recording is already in progress.');
      // 'tab' for tabCapture ids, 'desktop' for the ones from desktopCapture.
      const mediaSource = source === 'desktop' ? 'desktop' : 'tab';
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: mediaSource,
              chromeMediaSourceId: streamId,
              maxFrameRate: fps,
            },
          },
        });
      } catch (err) {
        // The bare message ("Error starting tab capture") hides which constraint or id
        // failed; keep the DOMException name and what we asked for.
        const name = (err && err.name) || 'Error';
        const message = (err && err.message) || String(err);
        throw new Error(`${name}: ${message} (source=${mediaSource}, id length=${String(streamId || '').length}, fps=${fps})`);
      }
      chunks = [];
      const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
        .find((type) => MediaRecorder.isTypeSupported(type));
      recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate });
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size) chunks.push(event.data);
      };
      stopped = new Promise((resolve) => { recorder.onstop = resolve; });
      const track = stream.getVideoTracks()[0];
      if (track && typeof onEnded === 'function') {
        track.addEventListener('ended', () => { try { onEnded(); } catch (_) { /* caller's problem */ } });
      }
      recorder.start(1000);
    }

    async function stop() {
      if (!recorder) throw new Error('No recording in progress.');
      const current = recorder;
      const done = stopped;
      recorder = null; // a second stop() while this one waits must not stop it twice
      if (current.state !== 'inactive') current.stop();
      await done;
      stream.getTracks().forEach((track) => track.stop());
      const blob = new Blob(chunks, { type: 'video/webm' });
      stream = stopped = null;
      chunks = [];
      return { url: URL.createObjectURL(blob), size: blob.size };
    }

    return { start, stop, isRecording: () => Boolean(recorder) };
  }

  return { QUALITY, createRecorder };
});
