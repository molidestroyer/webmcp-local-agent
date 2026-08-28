/**
 * WebMCP Local Agent - lib/webmcp-schema.js
 *
 * Pure helpers shared by the MAIN-world hook, the side panel and the tests.
 * No DOM and no extension APIs, so `node --test` can exercise all of it.
 *
 * Loaded as a plain script in both worlds (it publishes a global) and as a
 * CommonJS module under Node.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.__WebMCPLocalAgentSchema = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** A fresh object every time: callers are free to mutate what they get. */
  function emptySchema() {
    return { type: 'object', properties: {} };
  }

  /**
   * The native WebMCP API hands `RegisteredTool.inputSchema` over as a
   * JSON-serialized *string*, while imperative registrations pass a real
   * object. Both have to end up as the same thing.
   *
   * Throws on a string that is not a JSON object, so callers can tell a broken
   * schema from a genuinely parameterless tool instead of showing the second
   * when it is really the first.
   */
  function normalizeInputSchema(inputSchema) {
    if (typeof inputSchema === 'string') {
      const trimmed = inputSchema.trim();
      if (!trimmed) return emptySchema();
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new TypeError('WebMCP inputSchema must contain a JSON object.');
      }
      return parsed;
    }
    if (inputSchema && typeof inputSchema === 'object' && !Array.isArray(inputSchema)) {
      return inputSchema;
    }
    return emptySchema();
  }

  /** Same, but reports the failure instead of throwing. */
  function safeNormalizeInputSchema(inputSchema) {
    try {
      return { schema: normalizeInputSchema(inputSchema), error: null };
    } catch (err) {
      return { schema: emptySchema(), error: String((err && err.message) || err) };
    }
  }

  /**
   * Finds the live RegisteredTool. Origin disambiguates same-named tools coming
   * from different frames; when it does not match anything we still fall back to
   * the name so a page that omits `origin` keeps working.
   */
  function matchRegisteredTool(tools, name, origin) {
    if (!Array.isArray(tools) || !name) return null;
    const byName = tools.filter((tool) => tool && tool.name === name);
    if (!byName.length) return null;
    if (origin) {
      const exact = byName.find((tool) => tool.origin === origin);
      if (exact) return exact;
    }
    return byName[0];
  }

  /**
   * Identifies the **current** native API by its shape, because the spec offers
   * no version or capability field to test.
   *
   * Known limit: an older experimental implementation that exposes both
   * `getTools` and `executeTool` but still expects `executeTool(name, args)`
   * matches here and will fail when handed the tool object. That is deliberate.
   * Sniffing further would mean guessing at implementations we cannot test, and
   * falling back to the string form on error would hide genuine failures of the
   * current API — the exact bug this replaced. Such an implementation fails
   * loudly, with the page's own TypeError surfaced in the panel.
   */
  function supportsRegisteredToolApi(context) {
    return Boolean(
      context &&
      typeof context.getTools === 'function' &&
      typeof context.executeTool === 'function'
    );
  }

  /**
   * Re-reads the tools straight from the page and returns the exact object the
   * API handed back, together with the context it came from.
   *
   * A RegisteredTool carries realm-bound state, so it can neither be cached nor
   * sent through extension messaging: it has to be looked up again immediately
   * before every execution.
   */
  async function resolveRegisteredTool(contexts, name, origin) {
    for (const context of contexts || []) {
      if (!supportsRegisteredToolApi(context)) continue;
      let tools;
      try {
        tools = await context.getTools();
      } catch (_) {
        continue;
      }
      const tool = matchRegisteredTool(tools, name, origin);
      if (tool) return { context, tool };
    }
    return null;
  }

  /**
   * The values a property is allowed to take, for display only.
   *
   * Presentation, never validation: nothing in this extension rejects an
   * argument for being outside this list. The page keeps that job.
   *
   * `label` is a human-readable name; `value` is the constant that actually
   * gets sent. They are never swapped.
   */
  function getDisplayChoices(property) {
    if (!property || typeof property !== 'object') return [];

    // A direct enum wins. Schemas that carry both usually restate the same
    // constants in anyOf, and showing both would duplicate every choice.
    if (Array.isArray(property.enum) && property.enum.length) {
      return property.enum.map((value) => ({ value, label: String(value) }));
    }

    // oneOf has the same shape here; the upstream inspector reads it too.
    for (const key of ['anyOf', 'oneOf']) {
      const branches = property[key];
      if (!Array.isArray(branches)) continue;
      const choices = branches
        .filter((option) => (
          option &&
          typeof option === 'object' &&
          Object.prototype.hasOwnProperty.call(option, 'const')
        ))
        .map((option) => ({
          value: option.const,
          label: typeof option.title === 'string' && option.title
            ? option.title
            : String(option.const),
        }));
      if (choices.length) return choices;
    }

    return [];
  }

  /**
   * How a tool got registered. RegisteredTool carries nothing that says so —
   * the IDL is identical either way — so this is inferred by the page hook and
   * has to stay honest about the case where it cannot tell.
   */
  const REGISTRATION_LABELS = {
    javascript: { icon: '⚙️', text: 'JavaScript API' },
    declarative: { icon: '📝', text: 'HTML form' },
    unknown: { icon: '❔', text: 'Unknown' },
  };

  function registrationLabel(registration) {
    const entry = REGISTRATION_LABELS[registration] || REGISTRATION_LABELS.unknown;
    return entry.icon + ' ' + entry.text;
  }

  function registrationTitle(registration, source) {
    const where = source ? ' Found on ' + source + '.' : '';
    if (registration === 'javascript') {
      return 'Registered by script, through provideContext() or registerTool().' + where;
    }
    if (registration === 'declarative') {
      return 'Declared in the markup by a <form toolname="..."> element.' + where;
    }
    return 'Could not tell how this tool was registered: it did not go through '
      + 'provideContext()/registerTool() while the hook was watching, and no matching '
      + '<form toolname="..."> is in the document.' + where;
  }

  /**
   * Icon for a tool, inferred from its name.
   *
   * Ordered on purpose: the action decides the icon before the subject does, so
   * `cancelBooking` reads as a deletion rather than a booking.
   *
   * Matching is on whole tokens, never substrings. A substring test makes
   * `payload` a payment, `budget` a getter and `install` a listing — the same
   * trap that turned `update` into a date field elsewhere in this codebase.
   */
  const TOOL_ICONS = [
    { icon: '🗑', words: ['delete', 'remove', 'clear', 'cancel', 'discard', 'drop', 'archive', 'unregister'] },
    { icon: '➕', words: ['add', 'create', 'new', 'insert', 'append', 'register'] },
    { icon: '✏️', words: ['update', 'edit', 'set', 'change', 'rename', 'toggle', 'patch', 'save'] },
    { icon: '🔍', words: ['search', 'find', 'query', 'lookup', 'filter'] },
    { icon: '📋', words: ['list', 'get', 'read', 'fetch', 'info', 'detail', 'show', 'todo', 'item'] },
    { icon: '✈️', words: ['flight', 'travel', 'trip', 'hotel', 'itinerary', 'destination', 'airport'] },
    { icon: '📅', words: ['book', 'reserve', 'schedule', 'scheduling', 'appointment', 'slot', 'calendar', 'date', 'event'] },
    { icon: '🛒', words: ['cart', 'buy', 'order', 'checkout', 'purchase', 'pay', 'payment', 'basket', 'price'] },
    { icon: '✉️', words: ['send', 'mail', 'email', 'message', 'notify', 'invite', 'share'] },
    { icon: '👤', words: ['user', 'account', 'profile', 'login', 'logout', 'auth', 'signin', 'signup'] },
    { icon: '🎨', words: ['theme', 'color', 'colour', 'style', 'dark', 'light', 'appearance'] },
    { icon: '🧭', words: ['navigate', 'open', 'go', 'route', 'scroll', 'click', 'visit', 'page'] },
  ];

  const DEFAULT_TOOL_ICON = '⚡';

  /** Tokens with a naive plural stripped, so `todos` matches `todo`. */
  function iconTokens(text) {
    return new Set(tokens(text).map(
      (word) => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word)
    ));
  }

  function matchIcon(words) {
    for (const entry of TOOL_ICONS) {
      if (entry.words.some((word) => words.has(word))) return entry.icon;
    }
    return null;
  }

  function iconForTool(tool) {
    if (!tool) return DEFAULT_TOOL_ICON;
    // The name is the reliable signal. The description gets a turn only when the
    // name says nothing, since prose mentions actions the tool does not perform.
    return matchIcon(iconTokens(tool.name || ''))
      || matchIcon(iconTokens(tool.description || ''))
      || DEFAULT_TOOL_ICON;
  }

  /** `Market need (MarketNeed)`, or just `P1` when the label adds nothing. */
  function formatChoice(choice) {
    const value = String(choice.value);
    return choice.label === value ? value : choice.label + ' (' + value + ')';
  }

  /**
   * The schema as the model sees it. Only fills in a missing `type` or
   * `properties`; everything the page declared — enum, anyOf, const, title,
   * description, required — is carried through untouched, because that is what
   * lets the model pick `triggerType: "ChangeRequest"` instead of inventing
   * `trigger_type: "User Story"`.
   */
  function normalizeToolSchemaForModel(schema) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return emptySchema();
    const out = Object.assign({}, schema);
    if (!out.type) out.type = 'object';
    if (out.type === 'object' && !out.properties) out.properties = {};
    return out;
  }

  /** WebMCP tool -> Ollama tool-calling definition. */
  function toOllamaTool(tool) {
    const raw = tool.inputSchema !== undefined ? tool.inputSchema : tool.parameters;
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || tool.name,
        parameters: normalizeToolSchemaForModel(safeNormalizeInputSchema(raw).schema),
      },
    };
  }

  // The spec declares executeTool(tool, optional object inputObject), but the
  // shipping implementation takes the arguments as a JSON *string*: handing it
  // an object stringifies to "[object Object]" and it answers
  // "Failed to parse input string as JSON".
  // Anchored on "parse ... input", which is the platform complaining about the
  // arguments *before* the tool runs. Seen so far: "Failed to parse input
  // string as JSON" and "Failed to parse input arguments". Deliberately not a
  // catch-all: widen this to any rejection and a half-failed createFeature gets
  // replayed into two features.
  const JSON_ARGUMENT_ERROR = /failed to parse[^.]*input|failed to parse input/i;

  /** Remembers which argument form each context accepted. */
  const argumentStyles = new WeakMap();

  /**
   * Calls executeTool with whichever argument form this implementation wants.
   *
   * The retry is narrow on purpose. It fires only on the platform's own
   * parse-failure message, which is raised while converting the arguments —
   * before the tool runs — so nothing can execute twice. Any other rejection
   * is a real failure and propagates untouched. The answer is cached per
   * context, so a page is probed at most once.
   */
  async function callExecuteTool(context, tool, params) {
    if (argumentStyles.get(context) === 'string') {
      return context.executeTool(tool, JSON.stringify(params));
    }

    try {
      const result = await context.executeTool(tool, params);
      argumentStyles.set(context, 'object');
      return result;
    } catch (err) {
      const message = String((err && err.message) || err);
      if (argumentStyles.has(context) || !JSON_ARGUMENT_ERROR.test(message)) throw err;

      try {
        const result = await context.executeTool(tool, JSON.stringify(params));
        argumentStyles.set(context, 'string');
        return result;
      } catch (retryErr) {
        // Report both attempts: "it failed" twice over is useless, and the two
        // messages are what identify which form this implementation wants.
        const retryMessage = String((retryErr && retryErr.message) || retryErr);
        const combined = new Error(
          'executeTool rejected both argument forms. As an object: ' + message
          + ' | As a JSON string: ' + retryMessage
        );
        combined.cause = retryErr;
        throw combined;
      }
    }
  }

  /** Test seam: forget what we learned about a context. */
  function forgetArgumentStyle(context) {
    argumentStyles.delete(context);
  }

  /**
   * Tools out of a `list` answer. The hook used to reply with a bare array and
   * now replies with `{ tools, errors, ... }`; a rescue-injected old hook can
   * still send the array, so both are accepted.
   */
  function toolsFromListing(result) {
    if (Array.isArray(result)) return result;
    if (result && Array.isArray(result.tools)) return result.tools;
    return [];
  }

  function listingErrors(result) {
    return result && Array.isArray(result.errors) ? result.errors : [];
  }

  /** `checkInDate` / `check_in_date` / `check-in-date` -> ['check','in','date'] */
  function tokens(key) {
    return String(key)
      .replace(/[_-]+/g, ' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
  }

  function humanize(key) {
    return tokens(key).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  }

  function propertyNames(schema) {
    const props = schema && schema.properties;
    return props && typeof props === 'object' ? Object.keys(props) : [];
  }

  function requiredNames(schema) {
    return schema && Array.isArray(schema.required) ? schema.required : [];
  }

  function describeNeeds(props, required) {
    if (!props.length) return 'No input needed.';
    const primary = (required.length ? required : props).map(humanize);
    if (props.length === 1) return 'Needs: ' + primary[0] + '.';
    // "and more" tracks the total, not just the sample: a tool with 2 required
    // and 2 optional params still asks for 4 things.
    const shown = primary.slice(0, 2);
    const more = props.length > shown.length;
    const sample = more ? shown.join(', ') + ' and more' : shown.join(' and ');
    return 'Needs ' + props.length + ' details (like ' + sample + ').';
  }

  return {
    emptySchema,
    normalizeInputSchema,
    safeNormalizeInputSchema,
    matchRegisteredTool,
    supportsRegisteredToolApi,
    resolveRegisteredTool,
    callExecuteTool,
    forgetArgumentStyle,
    getDisplayChoices,
    formatChoice,
    iconForTool,
    toolsFromListing,
    listingErrors,
    registrationLabel,
    registrationTitle,
    normalizeToolSchemaForModel,
    toOllamaTool,
    tokens,
    humanize,
    propertyNames,
    requiredNames,
    describeNeeds,
  };
});
