# Changelog

## 0.4.3

Tool cards no longer claim every tool was registered from JavaScript.

The "Registered via" badge was the hardcoded string `JavaScript API`, so a tool
declared in the markup with `<form toolname="...">` was reported as a script
registration. `RegisteredTool` carries nothing that distinguishes the two — the
IDL is identical — so the page hook now infers it:

- **`javascript`** — the name went through the wrapped `provideContext()` /
  `registerTool()`.
- **`declarative`** — a matching `<form toolname="...">` is in the document.
- **`unknown`** — neither. Shown as such rather than guessed, which is what the
  hardcoded label was doing.

`unknown` is the honest answer when the hook was injected into an already-loaded
tab: it cannot have witnessed a registration that happened before it existed.
The descriptor carries `installedEarly` so that case stays distinguishable.

`demo/webmcp-form-demo.html` declares the same `createFeature` tool entirely in
markup and never calls `registerTool()`, so the detection is testable end to
end. The native demo now registers on `DOMContentLoaded`, which is when a hook
installed at `document_start` has patched the API — in a browser with native
WebMCP the object exists from the start and the timing does not arise.

## 0.4.2

Constrained parameters now show their allowed values.

A property declaring `enum`, or `anyOf`/`oneOf` branches carrying `const`, was
reduced to `triggerType:string` in the Tools panel, hiding the choices the page
declared. Tool cards gained an **Options** row listing them, and the Execute tab
renders those properties as a `<select>` instead of a free-text field.

- `getDisplayChoices()` prefers a direct `enum`; a schema carrying both `enum`
  and `anyOf` lists its choices once, not twice.
- An `anyOf` entry's `title` is shown as a label next to the constant
  (`Market need (MarketNeed)`), never in place of it. The constant is what gets
  sent, and it stays on the element's tooltip.
- Properties without declared choices render exactly as before.

Presentation only. **No validation was added**: an argument outside the declared
values is passed to the page untouched, and the page decides. There is a
regression test asserting exactly that, and another asserting the schema handed
to the model still carries `enum`, `anyOf`, `const`, `title`, `description` and
`required` unchanged — that path was already correct and was not rewritten.

`toOllamaTool()` moved into `lib/webmcp-schema.js` so the model-context path is
covered by tests. 43 tests total.

## 0.4.1

Compatibility with the current native WebMCP API. Two independent bugs made
declaratively registered tools unusable.

### `document.modelContext` was never inspected

The hook only looked at `navigator.modelContext`, `window.modelContext` and
`window.agent`. The current API lives on `document.modelContext`, which is now
checked first.

### `inputSchema` arrives as a JSON string

`RegisteredTool.inputSchema` is JSON-serialized. It was treated as an object,
so it failed the type check and degraded into an empty schema — the inspector
showed "No input needed" and the model, given no parameters, invented its own
(`trigger_type: "User Story"` instead of `triggerType: "ChangeRequest"`).

`normalizeInputSchema()` now parses strings and passes objects through
untouched. Properties, `required`, `enum`, `anyOf`, titles and descriptions
reach the model exactly as declared — nothing is renamed. A schema that cannot
be parsed is reported as an error in the Tools and Execute tabs rather than
silently becoming "No input needed".

### `executeTool()` was called with a tool name

The current API takes the `RegisteredTool` object:
`executeTool(registeredTool, args)`. Passing a string throws
`The provided value is not of type 'RegisteredTool'`.

Execution now calls `getTools()` in the page immediately beforehand, matches on
name plus `origin`, and hands over that exact object. RegisteredTool instances
are realm-bound, so they are never cached in the panel nor sent through
extension messaging. Tools removed or re-registered between discovery and
execution are handled: a missing one reports
`WebMCP tool "x" is no longer registered on this page.`

Legacy `callTool(name, args)` shapes still work, but only for contexts that do
not implement the current API — the RegisteredTool call is the primary path and
its errors are never swallowed.

### Also

- Tool results that are JSON strings are pretty-printed in the Execute result
  view while History keeps the raw value.
- `lib/webmcp-schema.js` holds the shared pure logic, covered by 23 unit tests
  (`node --test`), now run by `build.ps1` and by CI.
- `demo/webmcp-native-demo.html` reproduces the `createFeature` case locally:
  `document.modelContext`, a stringified schema, and an `executeTool` that
  throws the real `TypeError` when handed a name.

### Upgrade

Reload the extension in `chrome://extensions` and **refresh the pages you had
open** — content scripts are not re-injected into already-loaded tabs.

## 0.4.0

Tabbed side panel (Chat / Tools / Execute / History), per-tab toolbar badge with
the tool count, manual execution with a schema-driven form and a live JSON
editor, and a persistent execution history. Fixed dark theme.

## 0.3.0

Rich collapsible tool cards in the inspector: icon, humanised title, full
description, plain-language summary of the required input, one pill per
parameter and the registration source.

## 0.2.1

Fixed tool call cards collapsing to a 2px line: `.chat` is a flex column and its
children were being shrunk instead of letting the container scroll.

## 0.2.0

Whole project translated to English. The Ollama `403` now explains itself
instead of showing a bare status code.

## 0.1.0

First release: side panel with local Ollama chat and WebMCP tool calling.
