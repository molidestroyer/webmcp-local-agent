/**
 * WebMCP Local Agent - content.js
 *
 * Bridge between the MAIN world (page-hook.js, which sees the real WebMCP API)
 * and the extension's service worker. The content script opens the port
 * *towards* the extension, so we never need `tabs.sendMessage` nor host
 * permissions over the pages the user visits.
 */
(() => {
  'use strict';

  const FLAG = '__webmcpLocalAgentBridge__';
  if (window[FLAG]) return;
  window[FLAG] = true;

  const TO_PAGE = 'webmcp-local-agent:to-page';
  const FROM_PAGE = 'webmcp-local-agent:from-page';
  const PAGE_TIMEOUT_MS = 30000;

  /** @type {Map<string, (data: object) => void>} */
  const pending = new Map();
  let seq = 0;
  let port = null;

  function connect() {
    try {
      port = chrome.runtime.connect({ name: 'webmcp-bridge' });
    } catch (_) {
      port = null;
      return;
    }

    port.onMessage.addListener(async (message) => {
      if (!message || message.type !== 'request') return;
      const answer = await askPage(message.action, message.payload);
      try {
        port.postMessage({
          type: 'response',
          id: message.id,
          result: answer.result,
          error: answer.error,
        });
      } catch (_) { /* the panel was closed */ }
    });

    port.onDisconnect.addListener(() => {
      port = null;
      // The service worker can go to sleep; reconnect for the next event.
      setTimeout(connect, 1000);
    });
  }

  function askPage(action, payload) {
    return new Promise((resolve) => {
      const id = Date.now() + '-' + (++seq);
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ result: null, error: 'The page did not respond in time.' });
      }, PAGE_TIMEOUT_MS);

      pending.set(id, (data) => {
        clearTimeout(timer);
        resolve({ result: data.result, error: data.error });
      });

      window.postMessage({ channel: TO_PAGE, id, action, payload }, '*');
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== FROM_PAGE) return;

    if (data.event === 'tools-changed') {
      try {
        if (port) port.postMessage({ type: 'event', event: 'tools-changed' });
      } catch (_) { /* noop */ }
      return;
    }

    const resolver = pending.get(data.id);
    if (!resolver) return;
    pending.delete(data.id);
    resolver(data);
  });

  connect();
})();
