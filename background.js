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

const COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98';

async function startCopilotAuth() {
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: COPILOT_CLIENT_ID,
      scope: 'read:user',
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to request device code: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  return {
    device_code: data.device_code,
    user_code: data.user_code,
    verification_uri: data.verification_uri,
    expires_in: data.expires_in,
    interval: data.interval || 5,
  };
}

async function pollCopilotAuth(deviceCode) {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: COPILOT_CLIENT_ID,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });
  if (!res.ok) {
    throw new Error(`Polling request failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  if (data.error) {
    return { status: 'pending_or_error', error: data.error, error_description: data.error_description, interval: data.interval };
  }
  if (data.access_token) {
    await chrome.storage.local.set({ github_oauth_token: data.access_token });
    const tokenInfo = await getOrRefreshCopilotToken(true);
    return { status: 'success', access_token: data.access_token, tokenInfo };
  }
  return { status: 'unknown', data };
}

async function getOrRefreshCopilotToken(forceRefresh = false) {
  const stored = await chrome.storage.local.get(['github_oauth_token', 'copilot_session_token', 'copilot_token_expires_at', 'copilot_endpoints']);
  const oauthToken = stored.github_oauth_token;
  if (!oauthToken) {
    throw new Error('No GitHub OAuth token found. Please connect GitHub Copilot in Settings.');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (!forceRefresh && stored.copilot_session_token && stored.copilot_token_expires_at && stored.copilot_token_expires_at > (nowSec + 60)) {
    return {
      token: stored.copilot_session_token,
      expires_at: stored.copilot_token_expires_at,
      endpoints: stored.copilot_endpoints || null,
    };
  }

  const res = await fetch('https://api.github.com/copilot_internal/v2/token', {
    method: 'GET',
    headers: {
      'Authorization': `token ${oauthToken}`,
      'Editor-Version': 'vscode/1.96.2',
      'Editor-Plugin-Version': 'copilot/1.250.0',
      'User-Agent': 'GitHubCopilot/1.250.0',
      'Accept': 'application/json',
    },
  });

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      await chrome.storage.local.remove(['github_oauth_token', 'copilot_session_token', 'copilot_token_expires_at', 'copilot_endpoints']);
      throw new Error('GitHub OAuth token expired or invalid. Please re-authenticate GitHub Copilot.');
    }
    const errText = await res.text().catch(() => '');
    throw new Error(`Failed to exchange Copilot token: ${res.status} ${errText}`);
  }

  const data = await res.json();
  const token = data.token;
  const expiresAt = data.expires_at || (nowSec + 1500);
  const endpoints = data.endpoints || null;

  await chrome.storage.local.set({
    copilot_session_token: token,
    copilot_token_expires_at: expiresAt,
    copilot_endpoints: endpoints,
  });

  return { token, expires_at: expiresAt, endpoints };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return undefined;

  if (message.type === 'bridge') {
    bridge(message.tabId, message.action, message.payload).then((answer) => {
      if (message.action === 'list' && !answer.error) {
        setBadge(message.tabId, toolCount(answer.result));
      }
      sendResponse(answer);
    });
    return true; // async response
  }

  if (message.type === 'START_COPILOT_AUTH') {
    startCopilotAuth()
      .then((data) => sendResponse({ success: true, ...data }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'POLL_COPILOT_AUTH') {
    pollCopilotAuth(message.device_code)
      .then((data) => sendResponse({ success: true, ...data }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'GET_OR_REFRESH_COPILOT_TOKEN') {
    getOrRefreshCopilotToken(message.forceRefresh)
      .then((data) => sendResponse({ success: true, ...data }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'REVOKE_COPILOT_AUTH') {
    chrome.storage.local.remove(['github_oauth_token', 'copilot_session_token', 'copilot_token_expires_at', 'copilot_endpoints'])
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  return undefined;
});
