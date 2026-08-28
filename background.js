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
// A worker restart wipes `ports`; the content scripts reconnect ~1s later.
const PORT_WAIT_ATTEMPTS = 40;
const PORT_WAIT_STEP_MS = 50;

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

/** The hook answers `list` with { tools, errors }; older ones with a bare array. */
function toolCount(result) {
  if (Array.isArray(result)) return result.length;
  if (result && Array.isArray(result.tools)) return result.tools.length;
  return 0;
}

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
  if (answer && !answer.error) setBadge(tabId, toolCount(answer.result));
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // A navigation invalidates whatever we knew about that tab.
  if (changeInfo.status === 'loading') setBadge(tabId, 0);
  else if (changeInfo.status === 'complete') {
    refreshBadge(tabId);
    announceActiveTab(tabId, null);
  }
});

/**
 * Tells the side panel which tab is in front now.
 *
 * The panel used to watch chrome.tabs itself, which left it a beat behind: the
 * worker may still be waking up and its port map still empty when the panel
 * asks. Pushing from here — the same shape the upstream inspector uses — means
 * the panel reacts once the bridge is actually reachable.
 */
function announceActiveTab(tabId, windowId) {
  chrome.runtime.sendMessage({ type: 'active-tab', tabId, windowId }).catch(() => {});
}

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  refreshBadge(tabId);
  announceActiveTab(tabId, windowId);
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
    // No activeTab grant for this tab, or an unscriptable page. Failing here is
    // NOT a reason to give up: this map lives in the service worker's memory,
    // so a worker restart empties it while the content scripts are still alive.
    // They notice their port died and reconnect about a second later, and
    // waiting for that is the difference between "0 tools until you press
    // refresh" and it just working.
  }

  for (let attempt = 0; attempt < PORT_WAIT_ATTEMPTS; attempt++) {
    if (ports.has(tabId)) return true;
    await new Promise((resolve) => setTimeout(resolve, PORT_WAIT_STEP_MS));
  }
  return ports.has(tabId);
}

/**
 * Every distinct origin loaded in the tab, subframes included.
 *
 * getTools() with no options only reports the tools of the document it is
 * asked on. Tools registered inside an iframe — which is where a lot of app
 * shells put their forms — need their origin listed explicitly in
 * `fromOrigins`, so gather them all and let the page filter.
 */
async function frameOrigins(tabId) {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    const origins = (frames || [])
      .map((frame) => {
        try {
          return new URL(frame.url).origin;
        } catch (_) {
          return null;
        }
      })
      .filter((origin) => origin && origin !== 'null');
    return [...new Set(origins)];
  } catch (_) {
    return [];
  }
}

async function bridge(tabId, action, payload) {
  if (typeof tabId !== 'number') {
    return { result: null, error: 'There is no active tab.' };
  }

  if (action === 'list' && !(payload && payload.fromOrigins)) {
    payload = Object.assign({}, payload, { fromOrigins: await frameOrigins(tabId) });
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
    if (message.action === 'list' && !answer.error) {
      setBadge(message.tabId, toolCount(answer.result));
    }
    sendResponse(answer);
  });
  return true; // async response
});
