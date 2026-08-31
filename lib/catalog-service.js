/**
 * WebMCP Local Agent - catalog-service.js
 *
 * Catalog Service: Download, storage, validation, context resolution, and UI rendering helpers
 * for Knowledge Rules and Suggested Prompts.
 */
'use strict';

(function (exports) {
  const STORAGE_KEY = 'webmcp_catalog_cache';

  const EMPTY_CATALOG = {
    version: '1.0',
    rules: []
  };

  const DEMO_SAMPLE_CATALOG = {
    version: '1.0',
    description: 'WebMCP Business Rules & Prompt Catalog Sample for Multi-Country Address Book',
    rules: [
      {
        id: 'contacts-za',
        name: 'South Africa Localization (ZA)',
        match: {
          urlPattern: '.*(\\.za|/za/|region=za).*',
          requiredTools: ['create_contact']
        },
        systemContext: 'ZA Business Rules: Requires South African ID (13 digits) and UIF/PAYE calculation. 4-digit postal code.',
        suggestedPrompts: [
          'Create contact for South Africa with 13-digit ID',
          'Validate South African address and postal code'
        ]
      },
      {
        id: 'contacts-es',
        name: 'Spain Localization (ES)',
        match: {
          urlPattern: '.*(\\.es|/es/|region=es).*',
          requiredTools: ['create_contact']
        },
        systemContext: 'ES Business Rules: Requires valid DNI/NIE/NIF document and Spanish 5-digit postal code (CP).',
        suggestedPrompts: [
          'Create contact for Spain with valid DNI/NIF',
          'Validate address in Spain and province'
        ]
      },
      {
        id: 'contacts-ca',
        name: 'Canada Localization (CA)',
        match: {
          urlPattern: '.*(\\.ca|/ca/|region=ca).*',
          requiredTools: ['create_contact']
        },
        systemContext: 'CA Business Rules: Requires Social Insurance Number (SIN 9 digits), alphanumeric Postal Code (A1A 1A1) and GST/HST tax.',
        suggestedPrompts: [
          'Create contact for Canada with SIN and GST/HST',
          'Validate Canadian postal code format (A1A 1A1)'
        ]
      }
    ]
  };

  /** Validates raw JSON object against catalog schema rules. */
  function validateCatalogSchema(data) {
    if (!data || typeof data !== 'object') {
      return { valid: false, error: 'Catalog content is not a valid JSON object.' };
    }
    if (!Array.isArray(data.rules)) {
      return { valid: false, error: 'Catalog JSON missing "rules" array property.' };
    }
    for (let i = 0; i < data.rules.length; i++) {
      const rule = data.rules[i];
      if (!rule || typeof rule !== 'object') {
        return { valid: false, error: `Rule at index ${i} is not an object.` };
      }
      if (!rule.id || typeof rule.id !== 'string') {
        return { valid: false, error: `Rule at index ${i} is missing a string "id".` };
      }
      if (!rule.name || typeof rule.name !== 'string') {
        return { valid: false, error: `Rule at index ${i} ("${rule.id}") is missing a string "name".` };
      }
    }
    return { valid: true, error: null };
  }

  /** Performs authenticated fetch to a public or private repository URL. */
  async function fetchCatalog(url, token) {
    if (!url || typeof url !== 'string' || !url.trim()) {
      return { ok: false, error: 'URL field is empty.', data: null };
    }
    const cleanUrl = url.trim();
    const headers = { 'Accept': 'application/json, application/vnd.github.raw+json, text/plain' };

    if (token && typeof token === 'string' && token.trim()) {
      const cleanToken = token.trim();
      headers['Authorization'] = cleanToken.includes(' ') ? cleanToken : `Bearer ${cleanToken}`;
      headers['X-GitHub-Api-Version'] = '2022-11-28';
    }

    try {
      const response = await fetch(cleanUrl, { headers, cache: 'no-store' });
      if (response.status === 401 || response.status === 403) {
        return { ok: false, error: `HTTP ${response.status}: Authentication failed. Check your Auth Token / PAT.`, data: null };
      }
      if (response.status === 404) {
        return { ok: false, error: 'HTTP 404: Catalog JSON file not found at the specified URL.', data: null };
      }
      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status}: Failed to fetch catalog.`, data: null };
      }

      const text = await response.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch (err) {
        return { ok: false, error: 'Failed to parse JSON response: ' + err.message, data: null };
      }

      const validation = validateCatalogSchema(json);
      if (!validation.valid) {
        return { ok: false, error: 'Invalid Catalog Schema: ' + validation.error, data: null };
      }

      return { ok: true, error: null, data: json };
    } catch (err) {
      return { ok: false, error: 'Network error while fetching catalog: ' + String((err && err.message) || err), data: null };
    }
  }

  /**
   * Resolves active catalog context based on current URL and active WebMCP tools.
   */
  function resolveContext(currentUrl, discoveredTools, catalogData) {
    const catalog = catalogData || EMPTY_CATALOG;
    if (!catalog || !Array.isArray(catalog.rules) || !discoveredTools || !discoveredTools.length) {
      return { matchedRules: [], suggestedPrompts: [], systemContext: '' };
    }

    const toolNames = Array.isArray(discoveredTools)
      ? discoveredTools.map(t => (typeof t === 'string' ? t : t.name))
      : [];

    const matchedRules = [];
    const promptSet = new Set();
    const systemContexts = [];

    for (const rule of catalog.rules) {
      if (!rule || !rule.match) continue;
      let urlMatched = true;
      let toolsMatched = true;

      // 1. URL pattern check (if pattern provided)
      if (rule.match.urlPattern) {
        urlMatched = false;
        if (currentUrl) {
          try {
            const rx = new RegExp(rule.match.urlPattern, 'i');
            if (rx.test(currentUrl)) {
              urlMatched = true;
            }
          } catch (_) {
            if (currentUrl.toLowerCase().includes(rule.match.urlPattern.toLowerCase())) {
              urlMatched = true;
            }
          }
        }
      }

      // 2. Required tools check (if requiredTools provided)
      if (Array.isArray(rule.match.requiredTools) && rule.match.requiredTools.length > 0) {
        toolsMatched = rule.match.requiredTools.every(req => toolNames.includes(req));
      }

      if (urlMatched && toolsMatched) {
        matchedRules.push(rule);
        if (Array.isArray(rule.suggestedPrompts)) {
          rule.suggestedPrompts.forEach(p => promptSet.add(p));
        }
        if (rule.systemContext && typeof rule.systemContext === 'string') {
          systemContexts.push(rule.systemContext);
        }
      }
    }

    return {
      matchedRules,
      suggestedPrompts: Array.from(promptSet),
      systemContext: systemContexts.join('\n\n')
    };
  }

  exports.EMPTY_CATALOG = EMPTY_CATALOG;
  exports.DEMO_SAMPLE_CATALOG = DEMO_SAMPLE_CATALOG;
  exports.validateCatalogSchema = validateCatalogSchema;
  exports.fetchCatalog = fetchCatalog;
  exports.resolveContext = resolveContext;
  exports.STORAGE_KEY = STORAGE_KEY;
})(typeof module !== 'undefined' && module.exports ? module.exports : (globalThis.__WebMCPCatalogService = {}));
