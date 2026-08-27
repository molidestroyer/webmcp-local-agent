/**
 * WebMCP Local Agent - content.js
 *
 * Puente entre el MAIN world (page-hook.js, que ve la API WebMCP real) y el
 * service worker de la extension. El content script abre el puerto hacia la
 * extension, asi que nunca hace falta `tabs.sendMessage` ni permisos de host
 * sobre las paginas visitadas.
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
      } catch (_) { /* el panel se cerro */ }
    });

    port.onDisconnect.addListener(() => {
      port = null;
      // El service worker puede dormirse; reconectamos al proximo evento.
      setTimeout(connect, 1000);
    });
  }

  function askPage(action, payload) {
    return new Promise((resolve) => {
      const id = Date.now() + '-' + (++seq);
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ result: null, error: 'La pagina no respondio a tiempo.' });
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
