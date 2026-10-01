/**
 * WebMCP Local Agent - offscreen.js
 *
 * Service workers cannot hold a MediaStream, so tabCapture streams are consumed
 * here. background.js hands us a stream id and tells us when to stop; we answer
 * with a blob URL that the worker passes to chrome.downloads. The recording logic
 * itself lives in lib/recorder.js, shared with the side panel.
 */
const recorder = globalThis.__WebMCPRecorder.createRecorder();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') return undefined;
  const work = message.type === 'REC_START' ? recorder.start(message)
    : message.type === 'REC_STOP' ? recorder.stop()
      : null;
  if (!work) return undefined;
  work.then((data) => sendResponse({ success: true, ...(data || {}) }))
    .catch((err) => sendResponse({ success: false, error: String((err && err.message) || err) }));
  return true;
});
