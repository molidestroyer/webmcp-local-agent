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
    getDisplayChoices,
    formatChoice,
    normalizeToolSchemaForModel,
    toOllamaTool,
    tokens,
    humanize,
    propertyNames,
    requiredNames,
    describeNeeds,
  };
});
