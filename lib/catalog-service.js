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

  /**
   * The sample catalog. demo/catalog-sample.json is the same data, for people who want a file
   * to copy or host; tests/catalog.test.js fails if the two drift apart.
   */
  const DEMO_SAMPLE_CATALOG = {
    "version": "1.0",
    "description": "WebMCP Local Agent sample catalog: an end-to-end rule for Google's hotel-chain WebMCP demo, plus per-country business rules for the contacts demo.",
    "rules": [
      {
        "id": "chromelabs-hotel-chain",
        "name": "Chrome Labs · Hotel chain (E2E)",
        "match": {
          "urlPattern": "googlechromelabs\\.github\\.io/webmcp-tools/demos/hotel-chain"
        },
        "systemContext": "Google Chrome Labs WebMCP hotel-chain demo (\"L'Atelier\"). Hash routes: #/ (home), #/search?q=<city>, #/hotel/<id>, #/book/<id>.\nTools by page: on EVERY page search_location(query, checkin_date YYYY-MM-DD, nights, adults, kids, pets), view_hotel(hotel_name_or_id) and lookup_amenity(hotel_id, amenity). On #/search also get_hotel_search_results(), filter_search_results(max_price, amenities[]) and reset_filters(). On #/hotel/<id> also start_booking(). On #/book/<id> the declarative form complete_booking(firstName, lastName, email).\nEnd-to-end order: search_location -> get_hotel_search_results -> view_hotel -> lookup_amenity (if the user asks about a service) -> start_booking -> complete_booking. Each step navigates; the next page's tools appear a moment later.\nDates: send checkin_date as YYYY-MM-DD and the stay as nights (check-out minus check-in). Guests: adults/kids/pets as numbers. The search, dates and guests carry over to the booking page.\nHotels in Paris: \"Le Champs-Élysées\" (id champs, $420/night, amenities spa, dining, wifi) and \"Montmartre Suites\" (id montmartre). Pass the id to view_hotel and lookup_amenity: a name only matches with its exact accents. Amenity values: gym, spa, dining, wifi, breakfast, rooftop bar, bar, laundry, late checkout, free parking, washer.\nWhat the site does NOT have: room categories (no Suite choice), meal plans or add-ons to select, a phone field, a terms/cancellation checkbox, and a confirmation number. lookup_amenity only shows information, it adds nothing to the booking. When the user asks for any of these, say plainly that the site does not offer it and carry on with the rest; never invent a value, a code or a tool.\nPrice: total = price per night x nights x 1.1 (10% taxes and fees), shown in USD. Le Champs-Élysées for 3 nights: $1260 + $126 = $1386.\nSuccess: complete_booking answers \"Reservation confirmed successfully.\" and the page shows \"Reservation Confirmed\". Report that, the hotel, the dates, the guests and the total; say that the site issues no confirmation code.",
        "suggestedPrompts": [
          "Actúa como mi asistente de viajes y completa el proceso de reserva en la web siguiendo este flujo paso a paso:\n\n1. Búsqueda y Selección de Hotel:\n   - Destino: París\n   - Fechas: Entrada el 16 de octubre de 2026 y salida el 19 de octubre de 2026 (3 noches)\n   - Huéspedes: 2 adultos\n   - Selecciona el hotel \"Le Champs-Élysées\".\n\n2. Inspección y Configuración de Habitación:\n   - Consulta los detalles y servicios de \"Le Champs-Élysées\".\n   - Elige una habitación de categoría \"Suite\".\n   - Asegúrate de incluir el régimen con desayuno y de añadir el extra/acceso a Spa si está disponible como opción.\n\n3. Formalización de la Reserva (Checkout):\n   - Rellena el formulario de reserva con estos datos:\n     * Nombre: Carlos\n     * Apellidos: Mendoza Ramos\n     * Email: carlos.mendoza.demo@example.com\n     * Teléfono: +34 612 345 678\n   - Acepta los términos y la política de cancelación.\n   - Envía el formulario para confirmar la reserva.\n\n4. Resultado Final:\n   - Muéstrame el resumen final que incluya el número o código de confirmación de la reserva y el precio total.",
          "Book Le Champs-Élysées in Paris for 2 adults, check-in 2026-10-16, check-out 2026-10-19 (3 nights). Guest: Carlos Mendoza Ramos, carlos.mendoza.demo@example.com. Then give me the hotel, dates, guests and total price.",
          "Search hotels in Paris for 2 adults from 2026-10-16 for 3 nights and list them with their price per night and amenities.",
          "Show me the spa details of Le Champs-Élysées.",
          "Filter the current results to hotels with spa under $500 per night and list them."
        ]
      },
      {
        "id": "contacts-za",
        "name": "South Africa Localization (ZA)",
        "match": {
          "urlPattern": ".*(\\.za|/za/|region=za).*",
          "requiredTools": [
            "create_contact"
          ]
        },
        "systemContext": "ZA business rules: Only South African contacts (country='ZA') are permitted on this regional portal. Requires a 13-digit South African ID and 4-digit postal code.",
        "suggestedPrompts": [
          "Create a contact for South Africa with a 13-digit ID",
          "Validate a South African address and postal code"
        ]
      },
      {
        "id": "contacts-es",
        "name": "Spain Localization (ES)",
        "match": {
          "urlPattern": ".*(\\.es|/es/|region=es).*",
          "requiredTools": [
            "create_contact"
          ]
        },
        "systemContext": "ES business rules: Only Spanish contacts (country='ES') are permitted on this regional portal. Requires a valid DNI/NIE/NIF document and a 5-digit Spanish postal code (CP).",
        "suggestedPrompts": [
          "Create a contact for Spain with a valid DNI/NIF",
          "Validate an address and postal code in Spain"
        ]
      },
      {
        "id": "contacts-ca",
        "name": "Canada Localization (CA)",
        "match": {
          "urlPattern": ".*(\\.ca|/ca/|region=ca).*",
          "requiredTools": [
            "create_contact"
          ]
        },
        "systemContext": "CA business rules: Only Canadian contacts (country='CA') are permitted on this regional portal. Requires a Social Insurance Number (9-digit SIN) and an alphanumeric postal code (A1A 1A1).",
        "suggestedPrompts": [
          "Create a contact for Canada with a SIN and GST/HST",
          "Validate a Canadian postal code format (A1A 1A1)"
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
   * Whether one rule applies to this URL and these tool names. A rule without `match` never
   * applies; inside `match`, a missing criterion is not a restriction. Shared by
   * resolveContext (what travels with each message) and browsePrompts (what the picker marks
   * as "this page"), so the two can never disagree.
   */
  function ruleMatches(rule, currentUrl, toolNames) {
    if (!rule || !rule.match) return false;
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

    return urlMatched && toolsMatched;
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
      if (!ruleMatches(rule, currentUrl, toolNames)) continue;
      matchedRules.push(rule);
      if (Array.isArray(rule.suggestedPrompts)) {
        rule.suggestedPrompts.forEach(p => promptSet.add(p));
      }
      if (rule.systemContext && typeof rule.systemContext === 'string') {
        systemContexts.push(rule.systemContext);
      }
    }

    return {
      matchedRules,
      suggestedPrompts: Array.from(promptSet),
      systemContext: systemContexts.join('\n\n')
    };
  }

  /**
   * The suggested prompts of one rule, for display. The schema check does not look inside
   * `suggestedPrompts`, so an entry that is not a non-empty string is reported as invalid
   * (it would otherwise reach a chip as "[object Object]") instead of being silently shown.
   */
  function listRulePrompts(rule) {
    const raw = rule && Array.isArray(rule.suggestedPrompts) ? rule.suggestedPrompts : [];
    return raw.map((entry) => {
      if (typeof entry === 'string') return { text: entry, valid: Boolean(entry.trim()) };
      let text;
      try { text = JSON.stringify(entry); } catch (_) { text = String(entry); }
      return { text: text === undefined ? String(entry) : text, valid: false };
    });
  }

  /**
   * The picker's search box. Plain text matches as a case-insensitive substring; text written
   * as /pattern/flags is a regular expression, so a QA can type /hotel|booking/ or
   * /^chromelabs-/. An invalid expression comes back as `error`, never as "no results".
   */
  function parseQuery(query) {
    const raw = String(query || '').trim();
    if (!raw) return { test: () => true, empty: true, error: null };
    const rx = /^\/(.+)\/([a-z]*)$/i.exec(raw);
    if (rx) {
      try {
        const flags = rx[2].replace(/[gy]/g, '');
        const re = new RegExp(rx[1], flags.includes('i') ? flags : flags + 'i');
        return { test: (text) => re.test(String(text || '')), empty: false, error: null, regex: true };
      } catch (err) {
        return { test: () => false, empty: false, error: String(err.message || err), regex: true };
      }
    }
    const needle = raw.toLowerCase();
    return { test: (text) => String(text || '').toLowerCase().includes(needle), empty: false, error: null };
  }

  /** The rule names this site in its urlPattern and the URL matches, whatever tools are up now. */
  function ruleTargetsUrl(rule, url) {
    const pattern = rule && rule.match && rule.match.urlPattern;
    return Boolean(pattern && url && ruleMatches({ match: { urlPattern: pattern } }, url, []));
  }

  /**
   * Everything the catalog offers, for a picker the user browses. Unlike resolveContext it
   * does not hide rules that do not match the current tab unless asked to: the user decides
   * what to use, and each group says whether it applies to this page so a rule's context is
   * not a surprise. Groups that apply come first.
   *
   * - `query` filters by rule name, id or urlPattern, or by prompt text (see parseQuery).
   * - `scope: 'page'` keeps only the rules for this page: the ones that apply now (`matches`)
   *   and the ones whose urlPattern names this URL even if the tools they need are not up
   *   yet (`here`), which is the normal state of a multi-page E2E flow before its last page.
   * Entries that are not usable text are left out (the Rules Inspector flags them).
   */
  function browsePrompts(catalogData, { url = '', tools = [], query = '', scope = 'all' } = {}) {
    const rules = catalogData && Array.isArray(catalogData.rules) ? catalogData.rules : [];
    const toolNames = (tools || []).map((t) => (typeof t === 'string' ? t : t && t.name)).filter(Boolean);
    const q = parseQuery(query);
    if (q.error) return [];
    const groups = [];
    rules.forEach((rule, index) => {
      const prompts = listRulePrompts(rule).filter((p) => p.valid).map((p) => p.text);
      if (!prompts.length) return;
      const matches = ruleMatches(rule, url, toolNames);
      const here = matches || ruleTargetsUrl(rule, url);
      if (scope === 'page' && !here) return;
      // Each field on its own, so an anchored /^contacts-/ can match the id.
      const fields = [rule.name, rule.id, rule.match && rule.match.urlPattern].filter(Boolean);
      const ruleHit = !q.empty && fields.some((f) => q.test(f));
      const shown = q.empty || ruleHit ? prompts : prompts.filter((p) => q.test(p));
      if (!shown.length) return;
      groups.push({
        id: rule.id,
        name: rule.name || rule.id,
        matches,
        here,
        hasContext: Boolean(rule.systemContext),
        prompts: shown,
        index,
      });
    });
    // Stable: matching groups first, then the ones for this site, catalog order otherwise.
    groups.sort((a, b) => (b.matches - a.matches) || (b.here - a.here) || (a.index - b.index));
    return groups;
  }

  exports.ruleMatches = ruleMatches;
  exports.browsePrompts = browsePrompts;
  exports.parseQuery = parseQuery;
  exports.ruleTargetsUrl = ruleTargetsUrl;
  exports.listRulePrompts = listRulePrompts;
  exports.EMPTY_CATALOG = EMPTY_CATALOG;
  exports.DEMO_SAMPLE_CATALOG = DEMO_SAMPLE_CATALOG;
  exports.validateCatalogSchema = validateCatalogSchema;
  exports.fetchCatalog = fetchCatalog;
  exports.resolveContext = resolveContext;
  exports.STORAGE_KEY = STORAGE_KEY;
})(typeof module !== 'undefined' && module.exports ? module.exports : (globalThis.__WebMCPCatalogService = {}));
