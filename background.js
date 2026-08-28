/**
 * WebMCP Local Agent - background.js (MV3 service worker)
 *
 * Routes side panel requests to each tab's content script and keeps the
 * tabId -> port map. Also opens the side panel when the toolbar icon is clicked.
 */

const BRIDGE_TIMEOUT_MS = 35000;
const BADGE_COLOR = '#10B981';
// The page registers its tools a moment after the bridge connects.
const BADGE_SETTLE_MS = 800;

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

// --- Toolbar badge ---------------------------------------------------------

/** Per-tab badge, so switching tabs shows the right count with no extra work. */
function setBadge(tabId, count) {
  chrome.action.setBadgeText({ tabId, text: count > 0 ? String(count) : '' }).catch(() => {});
  if (count > 0) {
    chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR }).catch(() => {});
  }
}

/** Asks the page for its tools just to refresh the badge. */
async function refreshBadge(tabId) {
  if (!ports.has(tabId)) return;
  const answer = await bridge(tabId, 'list', null);
  if (answer && Array.isArray(answer.result)) setBadge(tabId, answer.result.length);
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // A navigation invalidates whatever we knew about that tab.
  if (changeInfo.status === 'loading') setBadge(tabId, 0);
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'webmcp-bridge') return;
  const tabId = port.sender && port.sender.tab && port.sender.tab.id;
  if (typeof tabId !== 'number') return;

  ports.set(tabId, port);
  // Badge the icon without waiting for the side panel to be opened.
  setTimeout(() => refreshBadge(tabId), BADGE_SETTLE_MS);

  port.onMessage.addListener((message) => {
    if (!message) return;
    if (message.type === 'response') {
      const resolver = waiting.get(message.id);
      if (resolver) {
        waiting.delete(message.id);
        resolver(message);
      }
    } else if (message.type === 'event' && message.event === 'tools-changed') {
      refreshBadge(tabId);
      chrome.runtime.sendMessage({ type: 'tools-changed', tabId }).catch(() => {});
    }
  });

  port.onDisconnect.addListener(() => {
    if (ports.get(tabId) === port) ports.delete(tabId);
  });
});

/**
 * Injects the hook and the bridge into tabs that were already open before the
 * extension was installed or reloaded. Relies on activeTab, granted when the
 * user clicks the extension icon.
 */
async function ensureInjected(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['lib/webmcp-schema.js', 'page-hook.js'],
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

  // The content script connects asynchronously after it runs.
  for (let attempt = 0; attempt < 20; attempt++) {
    if (ports.has(tabId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return ports.has(tabId);
}

async function bridge(tabId, action, payload) {
  if (typeof tabId !== 'number') {
    return { result: null, error: 'There is no active tab.' };
  }

  if (!ports.has(tabId)) await ensureInjected(tabId);
  const port = ports.get(tabId);
  if (!port) {
    return {
      result: null,
      error: 'Could not connect to the tab. Reload it (F5) and try again. '
        + 'Chrome internal pages and the Chrome Web Store do not allow extensions.',
    };
  }

  const id = Date.now() + '-' + (++seq);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      resolve({ result: null, error: 'The tab did not respond in time.' });
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
  bridge(message.tabId, message.action, message.payload).then((answer) => {
    // Every listing the panel asks for also keeps the badge honest.
    if (message.action === 'list' && Array.isArray(answer.result)) {
      setBadge(message.tabId, answer.result.length);
    }
    sendResponse(answer);
  });
  return true; // async response
});
