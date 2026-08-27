/**
 * WebMCP Local Agent - background.js (service worker, MV3)
 *
 * Enruta las peticiones del side panel hacia el content script de cada pestana
 * y mantiene el mapa tabId -> puerto. Tambien abre el side panel al pulsar el
 * icono de la extension.
 */

const BRIDGE_TIMEOUT_MS = 35000;

/** @type {Map<number, chrome.runtime.Port>} */
const ports = new Map();
/** @type {Map<string, (message: object) => void>} */
const waiting = new Map();
let seq = 0;

function enableSidePanelOnActionClick() {
  if (!chrome.sidePanel || !chrome.sidePanel.setPanelBehavior) return;
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

enableSidePanelOnActionClick();
chrome.runtime.onInstalled.addListener(enableSidePanelOnActionClick);

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'webmcp-bridge') return;
  const tabId = port.sender && port.sender.tab && port.sender.tab.id;
  if (typeof tabId !== 'number') return;

  ports.set(tabId, port);

  port.onMessage.addListener((message) => {
    if (!message) return;
    if (message.type === 'response') {
      const resolver = waiting.get(message.id);
      if (resolver) {
        waiting.delete(message.id);
        resolver(message);
      }
    } else if (message.type === 'event' && message.event === 'tools-changed') {
      chrome.runtime.sendMessage({ type: 'tools-changed', tabId }).catch(() => {});
    }
  });

  port.onDisconnect.addListener(() => {
    if (ports.get(tabId) === port) ports.delete(tabId);
  });
});

/**
 * Inyecta el hook y el puente en pestanas abiertas antes de instalar/recargar
 * la extension. Requiere activeTab (concedido al pulsar el icono).
 */
async function ensureInjected(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['page-hook.js'],
      world: 'MAIN',
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
      world: 'ISOLATED',
    });
  } catch (_) {
    return false;
  }

  // El content script se conecta de forma asincrona tras ejecutarse.
  for (let attempt = 0; attempt < 20; attempt++) {
    if (ports.has(tabId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return ports.has(tabId);
}

async function bridge(tabId, action, payload) {
  if (typeof tabId !== 'number') {
    return { result: null, error: 'No hay ninguna pestana activa.' };
  }

  if (!ports.has(tabId)) await ensureInjected(tabId);
  const port = ports.get(tabId);
  if (!port) {
    return {
      result: null,
      error: 'No se pudo conectar con la pestana. Recargala (F5) e intentalo de nuevo. '
        + 'Las paginas internas de Chrome y la Chrome Web Store no admiten extensiones.',
    };
  }

  const id = Date.now() + '-' + (++seq);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      resolve({ result: null, error: 'La pestana no respondio a tiempo.' });
    }, BRIDGE_TIMEOUT_MS);

    waiting.set(id, (message) => {
      clearTimeout(timer);
      resolve({ result: message.result, error: message.error || null });
    });

    try {
      port.postMessage({ type: 'request', id, action, payload });
    } catch (err) {
      clearTimeout(timer);
      waiting.delete(id);
      resolve({ result: null, error: String((err && err.message) || err) });
    }
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'bridge') return undefined;
  bridge(message.tabId, message.action, message.payload).then(sendResponse);
  return true; // respuesta asincrona
});
