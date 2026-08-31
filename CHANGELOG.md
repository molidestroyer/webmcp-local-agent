# Changelog

## 0.6.8

Add GitHub Copilot Device Flow Authentication & Unified Multi-Provider Model Architecture:
- Integrated GitHub OAuth Device Flow (Client ID `Iv1.b507a08c87ecfe98`) in Settings allowing direct, zero-copy connection to GitHub Copilot without manual PAT entry.
- Added support for remote Copilot models (`copilot:gpt-4o`, `copilot:gpt-4o-mini`, `copilot:claude-3.5-sonnet`, `copilot:o3-mini`) in a unified multi-provider model selector alongside local Ollama models.
- Updated agent execution loop to support both Ollama and Copilot completions with full WebMCP tool calling capabilities.
- Added a 15-second timeout to prompt suggestion generation to prevent hanging loading indicators.


Fix suggestions being phrased as assistant questions, add tab-switch awareness, richer History debugging, and a fuller contacts demo:
- The AI-suggestion prompt never told the model these strings get sent verbatim as the *user's own* next chat message — the model was phrasing them as itself asking the user for input ("Please provide...", "Do you want to..."). The prompt now says so explicitly and asks for concrete example values instead of generic restatements of a tool's description.
- History entries for suggestion generation (`suggestion` origin) now include the exact prompt text sent to Ollama, so a weird suggestion can be traced back to what produced it.
- Switching Chrome tabs mid-conversation no longer silently swaps the tools available under an unchanged chat: a visible note (and a matching system message in the model's context) marks the tab change and the new tool count, and the conversation itself is kept — clearing it on every tab switch would break workflows that read one page and act on another.
- `webmcp-contacts-demo.html`: added `list_contacts` and `delete_contact` tools, plus a live contact list in the page (with its own Delete button) so create/list/delete are all visible without reading the log.
- `demo/catalog-sample.json`'s `suggestedPrompts` and `systemContext` were still in Spanish from before the English-only pass — translated.

## 0.6.6

Fix tool registration on browsers whose real native WebMCP API only implements `registerTool()`:
- `webmcp-demo.html` and `webmcp-contacts-demo.html` unconditionally called `modelContext.provideContext({ tools })` — a bulk, older/draft-era shape. On a browser with the real native API (confirmed via a user's `document.modelContext` dump: a genuine `ModelContext` instance exposing `registerTool`/`ontoolchange` but no `provideContext`), that call is simply absent, so nothing ever registered and the contacts demo logged "WebMCP modelContext not available" despite the extension working correctly. `webmcp-native-demo.html` was unaffected — it already used `registerTool()` per tool, which is why other pages "just worked" for the same user. Both fixed pages now call `registerTool()` once per tool when available, falling back to `provideContext()` only for polyfills/drafts that lack `registerTool()`.
- Verified against a synthetic native object shaped exactly like the reported one (`registerTool` + `ontoolchange`, no `provideContext`) with `page-hook.js` attached for real: registration and discovery now succeed.
- `#clear-chat` (🗑) now matches `#send`'s footprint (36×36) instead of shrinking to its own padding — the two composer actions read as a pair.
- README: linked each of the four hosted demo pages individually (the contacts demo was missing entirely; the imperative demo's snippet cited `provideContext`, corrected to `registerTool`).

## 0.6.5

Make suggestions actually follow the tool-discovery and conversation lifecycle, not just settle once at load:
- After every chat turn finishes, suggestions regenerate automatically using the conversation so far — previously they were only computed on tool discovery/tab events and went stale for the rest of the session.
- The Ollama prompt used to generate suggestions now includes the last few exchanges (when there is a conversation) so follow-ups are contextual instead of always re-suggesting generic starting actions; the Knowledge Catalog's `systemContext` keeps being layered in alongside it, unchanged.
- Clearing the chat now re-offers the same starting suggestions a fresh page load would show, instead of leaving stale follow-ups from the cleared conversation on screen.
- Logged suggestion attempts (History, `suggestion` origin, added in 0.6.4) now also record whether conversation and catalog context were used, for debugging.

## 0.6.4

Fix the suggestions panel staying visible when it should be hidden, and log suggestion generation to History:
- `.suggestions` and `.suggestions__loading` had `display: flex` at the same CSS specificity as the `[hidden]` user-agent rule, so the author rule won the cascade and the `hidden` attribute never actually hid them — the "Generating suggestions…" indicator and the empty suggestions bar stayed on screen regardless of the auto-suggest setting or whether there was anything to show. Same class of bug the `.composer[hidden]` guard already fixed once; added the matching guards here.
- Every prompt-suggestion generation attempt (success, HTTP error, empty model reply, or fetch failure) is now recorded in the History tab under a `suggestion` origin, with timing, so a stuck or failing generation is as visible as a failed tool call. Superseded (aborted) attempts are not logged — they are not failures.

## 0.6.2

Fix prompt suggestions startup state, require page tools, set catalog default to none, and translate UI to English:
- Fix initial startup bug where `"Generando sugerencias..."` loading indicator appeared when starting with `autoSuggest: false`.
- Enforce WebMCP tool presence: prompt suggestions container is strictly hidden on pages with 0 exposed tools.
- Set default catalog source to `None` (`0 rules loaded`) instead of auto-loading sample catalog.
- Added **Demo Sample Catalog** option in Settings for testing multi-country address book rules on demand.
- Translated all Settings labels, toggle text, rules inspector, and sample rules to English per `CLAUDE.md`.

## 0.6.1

Add Knowledge & Business Rule Catalog System with Local / Remote sources, Rules Inspector UI, and Multi-Country Demo:
- Dual source mode: Built-in Local Sample Catalog (`demo/catalog-sample.json`) vs Custom Remote URL (Public or Private repo with Bearer Token auth).
- Active Rules Inspector in Settings tab (`#catalog-rules-list`) displaying loaded rules, match criteria (`urlPattern`, `requiredTools`), business `systemContext`, and static `suggestedPrompts`.
- Enriched Ollama system prompts with active region/page business rules on chat turns and dynamic AI prompt generation.
- New Interactive Multi-Country Contact Agenda demo (`demo/webmcp-contacts-demo.html`) supporting ZA (13-digit ID), ES (DNI/NIF), and CA (SIN & postal code).

## 0.6.0

Add Settings tab and dynamic prompt suggestions based on WebMCP tools:
- New Settings tab (`⚙️ Settings`) with toggle `"Habilitar prompts sugeridos automáticos"` (default: false).
- Dynamic prompt generation using the selected Ollama model when WebMCP tools are detected on the active tab.
- Quick reply chips above the chat composer with non-blocking spinner loading state.
- AbortController cancellation management on tab switch, model change, or toggle change.

## 0.5.6

Add native `wait` tool, per-step tool re-inspection, and enhanced multi-step agent system prompt:
- Provide built-in extension `wait({ seconds })` tool so models can pause for async page updates/background jobs (1 to 30s).
- Re-inspect active page tools (`detectPageTools()`) at the start of *every* loop step in `runAgent()`, giving the model up-to-date tools as SPA views and routes change.
- Update `SYSTEM_PROMPT` with guidelines for tool chaining, async monitoring loops, and multi-step web interaction.

## 0.5.5

Fix SPA client-side navigation tool detection and stale tool cache:
- Patch `history.pushState` and `history.replaceState` and listen to `popstate`/`hashchange` so tool changes trigger automatically on SPA route changes.
- Automatically purge unmounted `<form toolname="...">` declarative tools from `registry` when `snapshot()` is called or when Refresh is clicked.

## 0.5.4

Fix `Failed to parse input arguments` error in native WebMCP tool execution:
- Default `callExecuteTool` to try JSON string format first (`JSON.stringify(params)`), as shipping Chrome implementations (Chrome 146-151) expect JSON strings.
- Add wrapped argument format fallbacks (`{ arguments: params }` and stringified wrapped formats).
- Add support for `modelContextTesting` context objects (`navigator.modelContextTesting`, `document.modelContextTesting`, `window.modelContextTesting`).
- Fall back gracefully to script registration callbacks (`entry.execute`) and DOM form submission when native context execution fails.

## 0.5.3

Fix WebMCP tool discovery, input schema normalization and execution fallbacks:
- Handle markdown fenced (` ```json `) and double-stringified `inputSchema` inputs.
- Support direct `tool.execute()` (WebMCP IDL spec), `context.executeTool(tool)`, `context.executeTool(name)`, and `context.callTool(name)` invocation fallbacks.
- Add DOM form scanner for `<form toolname="...">` elements so declarative tools are discovered even if native `getTools()` misses them, with form input populate & submit execution fallback.
- Sanitize DOM `Node`/`Element` results during messaging serialization.
- Strip markdown fencing and normalize LLM argument string outputs.

## 0.5.2

`Failed to parse input arguments` again, and reading the upstream handler line
by line showed two mistakes, neither of them the wording of the message.

### The wrong RegisteredTool was being executed

The inspector picks its tool with
`tools.find((t) => t.name === name && t.window === window)`. This extension
matched on name and origin only. That was harmless until 0.5.0 added
`fromOrigins` to listing, at which point `getTools()` started returning
same-named tools from other documents — and executing another document's
RegisteredTool is rejected in ways that read like an argument problem.

Execution now prefers the tool whose `window` is this one, and asks
`getTools()` without `fromOrigins`: listing spans frames, execution belongs to
the document it runs in.

### A cached argument form became a dead end

Once `callExecuteTool()` had learned that a page wanted a JSON string, that
call sat outside the try/catch. When it later failed, the raw parse error
propagated with no second attempt — which is exactly the bare message that kept
coming back, rather than the "both forms" message 0.5.1 added.

Both forms are now tried in turn, starting with whichever last worked, and the
cache is cleared when neither does. A rejection that is not an argument-parsing
complaint is still never replayed.

## 0.5.1

`executeTool` failed again with `Failed to parse input arguments`.

Same cause as 0.4.4 — the implementation wants the arguments as a JSON string,
not an object — but a different wording. The retry was anchored on the exact
text seen back then, `Failed to parse input string as JSON`, so it never fired
for this one and the object form's failure was reported as final.

The gate now matches both phrasings while staying anchored on the platform
complaining about parsing *input*, which it does before the tool runs. It is
still not a catch-all: a tool that fails on its own merits is never replayed,
and there is a test asserting a half-failed call runs exactly once.

When neither form works, the error now names both attempts instead of showing
one message twice — the pair is what identifies which form an implementation
wants.

## 0.5.0

Read the upstream inspector properly instead of guessing, and found two things
it does that this extension did not.

### The platform announces tool changes and nobody was listening

`ModelContext` has an `ontoolchange` handler and fires a `toolchange` event at
the document's global object whenever a tool is registered or unregistered. The
inspector listens to it, which is why it reacts instantly.

This extension had a throttled `MutationObserver` watching `form[toolname]`
instead — a worse reimplementation of a signal the browser already sends, and
one that misses any change the DOM does not reveal. The event is now handled on
the context object, the document and the window; the observer stays as the
fallback for polyfilled pages and browsers without WebMCP.

### getTools() only answers for its own document

`getTools()` takes `ModelContextGetToolOptions`, whose `fromOrigins` names the
other documents to query. Called bare, as it was here, it returns nothing
registered inside a subframe. The inspector collects every frame origin with
`chrome.webNavigation.getAllFrames()` and passes them.

The service worker now does the same and hands the origins to the hook, which
falls back to a bare `getTools()` if an implementation rejects the argument.
This needs the `webNavigation` permission and `<all_urls>` host access —
the latter changes nothing in practice, since the content scripts already
matched `<all_urls>`.

### page-hook.js is now tested

Every bug of the last few releases landed in the one file with no coverage,
because it runs in a page's MAIN world. It needs only a handful of DOM surfaces,
so a shim plus `node:vm` now exercises the real file: discovery, `fromOrigins`,
`toolchange`, declarative labelling, the registry surviving `provideContext()`,
reported errors and the execution path. 71 tests.

## 0.4.7

Declaratively registered tools went missing when switching tabs, while
JavaScript ones refreshed correctly. That asymmetry is the clue: script
registrations live in the hook's registry, put there by the wrappers, whereas
declarative tools exist nowhere but the result of `getTools()` and are
rediscovered on every listing.

**`provideContext()` was wiping them.** The wrapper called `registry.clear()`
to honour "provideContext replaces the whole tool set", but that map also holds
everything discovered through `getTools()`. On a page that registers a tool by
script — an SPA doing it on a route change, say — every declarative tool
vanished with it. Only script-registered entries are cleared now.

**A failing `getTools()` was swallowed.** The discovery loop caught every
exception and moved on, so a page whose `getTools()` threw looked exactly like
a page with no tools, and only the declarative ones disappeared because the
script ones were already in the registry. `list` now answers with
`{ tools, errors, discovered, formsInDom }` and the panel shows the failure.

The panel also inspects a second time 700 ms after a tab comes to the front: a
tab that has just been activated may not have its declarative tools synthesized
the instant it does.

## 0.4.6

Tool icons were picked by regex over the whole name, in a badly ordered list.

`cancelBooking` matched `book` before `cancel` and came out as 📅 instead of 🗑.
Substring matching also made `setPayload` a payment, `budgetSummary` a getter,
`installPlugin` a listing and `recreateIndex` a creation — the same trap already
documented for the Execute tab, where `/date/` turned `update` into a date
picker, and not applied here.

Matching is now on whole tokens, with naive plurals folded so `listTodos` still
finds `todo`, and the list is ordered so the action decides before the subject.
Travel tools get ✈️. The name is decisive; the description is consulted only
when the name matches nothing, since prose mentions verbs the tool does not
perform.

The inference moved into `lib/webmcp-schema.js` and is covered by tests.

For the record: the upstream inspector has no per-tool icons at all — no icon
library, no heuristic. Its `styles.css` carries a chevron for `<select>` and a
`▾` for collapsibles, and nothing else.

## 0.4.5

The tool list still needed a manual refresh after switching tabs. 0.4.4 added
the missing badge listeners but missed the actual cause.

`ports` (tabId to bridge port) lives in the service worker's memory, so a worker
restart empties it while the content scripts are still running. On the next tab
switch the panel asked for the tools, the worker woke with an empty map,
`ensureInjected()` tried `executeScript` without an `activeTab` grant for that
tab, and **gave up the moment it threw** — reporting zero tools. About a second
later the content scripts noticed their port had died and reconnected, which is
why pressing refresh then worked.

`ensureInjected()` now waits up to two seconds for a port whether or not the
injection succeeded. A failed injection says nothing about whether the tab
already has a bridge on its way back.

The side panel also stopped polling `chrome.tabs` itself. The service worker
pushes an `active-tab` message on `onActivated` and on `onUpdated` completing —
the shape the upstream inspector uses — so the panel reacts when the bridge is
actually reachable rather than a beat too early. Panels in other windows ignore
the message by comparing `windowId`.

## 0.4.4

Two failures reported against a real page, both confirmed against the upstream
inspector's source.

### "Failed to parse input string as JSON" on every execution

The spec declares `executeTool(tool, optional object inputObject)`, so the
arguments were passed as an object. The shipping implementation takes them as a
JSON **string**: an object converts to `"[object Object]"`, which then fails to
parse. The upstream inspector passes its textarea contents straight through, a
string, which is why the same JSON worked there.

`callExecuteTool()` now sends the object, and retries once with
`JSON.stringify(args)` **only** on the platform's own parse-failure message.
That message is raised while converting the arguments, before the tool runs, so
nothing can execute twice; every other rejection propagates untouched and is
never replayed. The accepted form is cached per context, so a page is probed at
most once.

### The badge and the tool list went stale on tab switch

`background.js` had no `chrome.tabs.onActivated` handler at all, and its
`onUpdated` handler only *cleared* the badge. The count was computed once, when
a tab's bridge connected. Both events now refresh it, matching what the upstream
inspector does.

Declarative tools made this worse: they are markup, so they appear and disappear
with client-side navigation without anything calling
`provideContext()`/`registerTool()` — the wrappers that drive `tools-changed`
never fire for them. The page hook now watches the document for
`form[toolname]` appearing or disappearing, throttled, and reports the change.
The side panel also re-inspects when it becomes visible again.

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
