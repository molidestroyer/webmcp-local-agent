/**
 * WebMCP Local Agent - offscreen.js
 *
 * Service workers cannot hold a MediaStream, so the tab capture is consumed
 * here. background.js hands us a stream id and tells us when to stop; we answer
 * with a blob URL that the worker passes to chrome.downloads.
 */
let recorder = null;
let stream = null;
let chunks = [];

async function start({ streamId, source, fps, bitrate }) {
  if (recorder) throw new Error('A recording is already in progress.');
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        // 'tab' for tabCapture ids, 'desktop' for the ones from desktopCapture.
        chromeMediaSource: source === 'desktop' ? 'desktop' : 'tab',
        chromeMediaSourceId: streamId,
        maxFrameRate: fps,
      },
    },
  });
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') return undefined;
  const work = message.type === 'REC_START' ? start(message) : message.type === 'REC_STOP' ? stop() : null;
  if (!work) return undefined;
  work.then((data) => sendResponse({ success: true, ...(data || {}) }))
    .catch((err) => sendResponse({ success: false, error: String((err && err.message) || err) }));
  return true;
});
