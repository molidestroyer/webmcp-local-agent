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

    async function start({ streamId, source, fps, bitrate }) {
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
      recorder.start(1000);
    }

    function stop() {
      return new Promise((resolve, reject) => {
        if (!recorder) return reject(new Error('No recording in progress.'));
        const current = recorder;
        current.onstop = () => {
          stream.getTracks().forEach((track) => track.stop());
          const blob = new Blob(chunks, { type: 'video/webm' });
          recorder = stream = null;
          chunks = [];
          resolve({ url: URL.createObjectURL(blob), size: blob.size });
        };
        current.stop();
      });
    }

    return { start, stop, isRecording: () => Boolean(recorder) };
  }

  return { QUALITY, createRecorder };
});
