/**
 * WebMCP Local Agent - lib/recordings-folder.js (side panel + node)
 *
 * A folder the user picks once, so recordings are written straight to disk instead of
 * going through chrome.downloads. That API cannot be told to stay quiet: if Chrome's
 * "Ask where to save each file" is on, it prompts whatever `saveAs` says.
 *
 * The directory handle lives in IndexedDB. Chrome may ask again for permission in a later
 * session; that only works with a user gesture, so callers ask at the start of a recording
 * (the click on Send / Rec) and fall back to a normal download when it is not granted.
 */
(function (root, factory) {
  const api = factory();
  root.__WebMCPRecordingsFolder = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DB_NAME = 'webmcp-local-agent';
  const STORE = 'handles';
  const KEY = 'recordings-folder';

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function withStore(mode, run) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const request = run(db.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  }

  const supported = () => typeof showDirectoryPicker === 'function' && typeof indexedDB !== 'undefined';

  /** Opens Chrome's folder picker and remembers the choice. Needs a user gesture. */
  async function pick() {
    const handle = await showDirectoryPicker({ id: 'webmcp-recordings', mode: 'readwrite' });
    await withStore('readwrite', (store) => store.put(handle, KEY));
    return handle;
  }

  async function load() {
    if (!supported()) return null;
    try {
      return (await withStore('readonly', (store) => store.get(KEY))) || null;
    } catch (_) {
      return null;
    }
  }

  async function forget() {
    await withStore('readwrite', (store) => store.delete(KEY));
  }

  /**
   * True when the handle can be written to now. A 'prompt' state is asked about once;
   * without a user gesture that request throws, which just means "not now".
   */
  async function ensurePermission(handle) {
    if (!handle) return false;
    const options = { mode: 'readwrite' };
    try {
      if ((await handle.queryPermission(options)) === 'granted') return true;
      return (await handle.requestPermission(options)) === 'granted';
    } catch (_) {
      return false;
    }
  }

  /** Writes `data` (Blob or string) to `name` inside the folder, replacing any existing file. */
  async function writeFile(handle, name, data) {
    const file = await handle.getFileHandle(name, { create: true });
    const writable = await file.createWritable();
    try {
      await writable.write(data);
    } finally {
      await writable.close();
    }
  }

  return { supported, pick, load, forget, ensurePermission, writeFile };
});
