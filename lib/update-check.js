/**
 * WebMCP Local Agent - lib/update-check.js (side panel + node)
 *
 * Checks GitHub Releases for a newer version than the installed manifest version.
 * Pure, dependency-free, and cached for 6 hours to stay well within GitHub's
 * unauthenticated API rate limit.
 */
(function (root, factory) {
  const api = factory();
  root.__WebMCPUpdateCheck = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LATEST_RELEASE_URL = 'https://api.github.com/repos/molidestroyer/webmcp-local-agent/releases/latest';
  const RELEASES_PAGE_URL = 'https://github.com/molidestroyer/webmcp-local-agent/releases';
  const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

  function parseVersion(raw) {
    if (typeof raw !== 'string') return null;
    const clean = raw.trim().replace(/^v/i, '').split('-')[0].split('+')[0];
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(clean);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  }

  function compareVersions(a, b) {
    const pa = parseVersion(a);
    const pb = parseVersion(b);
    if (!pa || !pb) return 0;
    for (let i = 0; i < 3; i++) {
      if (pa[i] > pb[i]) return 1;
      if (pa[i] < pb[i]) return -1;
    }
    return 0;
  }

  function isNewerVersion(latest, current) {
    return compareVersions(latest, current) > 0;
  }

  function shouldFetchUpdate(cache, now = Date.now(), force = false) {
    if (force) return true;
    if (!cache || typeof cache !== 'object' || !cache.checkedAt) return true;
    return (now - cache.checkedAt) >= CACHE_TTL_MS;
  }

  function parseReleasePayload(data) {
    if (!data || typeof data !== 'object' || typeof data.tag_name !== 'string') return null;
    const parsed = parseVersion(data.tag_name);
    if (!parsed) return null;
    const version = parsed.join('.');
    const assets = Array.isArray(data.assets) ? data.assets : [];
    const zipAsset = assets.find((a) => a && typeof a.name === 'string' && a.name.endsWith('.zip') && a.browser_download_url);
    return {
      version,
      tagName: data.tag_name,
      htmlUrl: typeof data.html_url === 'string' ? data.html_url : RELEASES_PAGE_URL,
      zipUrl: zipAsset ? zipAsset.browser_download_url : null,
      zipName: zipAsset ? zipAsset.name : null,
      publishedAt: typeof data.published_at === 'string' ? data.published_at : '',
    };
  }

  async function checkLatestRelease(fetchFn, currentVersion) {
    if (typeof fetchFn !== 'function') {
      return { ok: false, updateAvailable: false, currentVersion, latest: null, error: 'Fetch is unavailable.' };
    }
    try {
      const response = await fetchFn(LATEST_RELEASE_URL, {
        headers: { Accept: 'application/vnd.github+json' },
        cache: 'no-store',
      });
      if (!response || !response.ok) {
        const status = response ? response.status : 'network';
        return {
          ok: false,
          updateAvailable: false,
          currentVersion,
          latest: null,
          error: `GitHub returned HTTP ${status}`,
        };
      }
      const data = await response.json();
      const latest = parseReleasePayload(data);
      if (!latest) {
        return {
          ok: false,
          updateAvailable: false,
          currentVersion,
          latest: null,
          error: 'Could not parse latest release version.',
        };
      }
      return {
        ok: true,
        updateAvailable: isNewerVersion(latest.version, currentVersion),
        currentVersion: (parseVersion(currentVersion) || []).join('.') || String(currentVersion || ''),
        latest,
        error: null,
      };
    } catch (err) {
      return {
        ok: false,
        updateAvailable: false,
        currentVersion,
        latest: null,
        error: String((err && err.message) || err),
      };
    }
  }

  return {
    LATEST_RELEASE_URL,
    RELEASES_PAGE_URL,
    CACHE_TTL_MS,
    parseVersion,
    compareVersions,
    isNewerVersion,
    shouldFetchUpdate,
    parseReleasePayload,
    checkLatestRelease,
  };
});
