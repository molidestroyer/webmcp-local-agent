# CLAUDE.md — WebMCP Local Agent

## What this is

A Chrome MV3 extension whose side panel wires together two things:

1. **WebMCP inspector** — discovers the tools the active tab registers on
   `navigator.modelContext` / `window.modelContext`, and knows how to run them.
2. **Local Ollama client** (`127.0.0.1:11434`) — chat with a dynamic picker of pulled
   models and **tool calling**: the model calls the page's tools, they execute against the
   DOM, and the result goes back to the model so it can write the final answer.

Vanilla JS, no bundler, no dependencies. The "build" (`build.ps1`) only validates and zips.
Everything is local: the only network destination is Ollama.

Repo language is **English** — code, comments, UI strings, docs and commit messages.

## Repo

- Remote: **`https://github.com/molidestroyer/webmcp-local-agent`** (public).
- ⚠️ The account is **`molidestroyer`**, not `miguelmolinamontilla`. Those are two
  different accounts of Miguel's; the main one (CV and the rest of his repos) and the
  credentials stored in this machine's Git Credential Manager both belong to
  `molidestroyer`. Pushing to the other account fails with 403.
- Published: `v0.1.0`, with the zip attached to the release.

## Layout

| File | World | Responsibility |
| --- | --- | --- |
| `manifest.json` | — | MV3. Permissions: `sidePanel`, `activeTab`, `scripting`, `storage`, `tabs`. Host permissions **only** towards `11434`. |
| `lib/webmcp-schema.js` | MAIN + panel + node | Pure shared logic: schema normalization, RegisteredTool matching, naming helpers. Publishes `globalThis.__WebMCPLocalAgentSchema` **and** `module.exports`, so `node --test` covers it. Listed **before** `page-hook.js` in `content_scripts` and in `ensureInjected`. |
| `page-hook.js` | MAIN | Wraps `provideContext` / `registerTool` / `unregisterTool` to track tools and keep the real reference to `execute`. Answers `list` and `execute` over `postMessage`. |
| `tests/schema.test.js` | node | 23 tests, no dependencies. Run by `build.ps1` and CI before packaging. |
| `content.js` | ISOLATED | Bridge. Opens `chrome.runtime.connect({name:'webmcp-bridge'})` **towards** the SW. |
| `background.js` | SW | `tabId → Port` map, request/response routing with timeouts, `sidePanel.setPanelBehavior`, rescue injection via `scripting.executeScript`. |
| `sidepanel.{html,css,js}` | panel | Four tabs (`#tab-chat`, `#tab-tools`, `#tab-execute`, `#tab-history`) over one shared `state`, plus the tool-calling loop against `/api/chat`. Fixed dark theme, no light mode. |
| `demo/` | — | Playground: `index.html` landing, `webmcp-demo.html` (imperative), `webmcp-native-demo.html` (native API shape) and `webmcp-form-demo.html` (declarative `<form toolname>`, no registration code at all). Published to GitHub Pages **and** shipped inside the zip from this one folder, so the two can never drift. |
| `.github/workflows/pages.yml` | — | Deploys `demo/` to <https://molidestroyer.github.io/webmcp-local-agent/> on pushes that touch it. Needs Settings → Pages → Source = **GitHub Actions** (one-time, done by hand). |
| `build.ps1` | — | Validates + packages into `dist/webmcp-local-agent-<version>.zip`. |
| `.github/workflows/build.yml` | — | CI: runs `build.ps1` (pwsh is preinstalled on `ubuntu-latest`), uploads the artifact and publishes a release on `v*` tags. |

## Decisions worth not undoing

- **The content script connects towards the SW**, never the other way round. That avoids
  needing `host_permissions: ["<all_urls>"]` (no `tabs.sendMessage`). If this ever
  changes, the manifest will need that permission and Chrome will show the "read all your
  data on all websites" warning.
- **`world: "MAIN"` in `content_scripts`**, not `<script>` injection: many pages' CSP
  blocks the latter.
- **`document_start`** is mandatory: if the page calls `provideContext()` before we hook
  in, the only fallback left is reading `tools`/`getTools()`, which many implementations
  do not expose.
- `page-hook.js` passes `execute()` an object that works both for `execute(args)` and for
  `execute({ name, arguments })`, because implementations differ.
- Everything crossing `postMessage` goes through `JSON.parse(JSON.stringify(...))`: tool
  results may carry functions or DOM nodes and would break `structuredClone`.

## Side panel internals

- `state` is the single source of truth; every `render*()` reads from it. `detectPageTools()`
  re-renders the Tools list and the Execute picker, and runs before every chat turn.
- Persisted in `chrome.storage.local`: `selectedModel`, `confirmTools`, `activeTab`,
  `history` (capped at `HISTORY_LIMIT`, newest first). Nothing else survives a reload —
  the conversation itself is deliberately in-memory.
- `state.openTools` keeps expanded tool cards open across the re-render that happens on
  every message.
- **Execute tab.** `controlFor()` picks the input type and `smartDefault()` prefills it.
  Name heuristics match **whole tokens**, never substrings: `/date/` on `update` would
  turn it into a date picker. `tokens()` splits camelCase/snake/kebab first.
- The live JSON editor and the form sync both ways behind a `syncingJson` guard to avoid
  a feedback loop. `execArguments()` prefers the JSON when it parses — it is what the user
  edited last — and falls back to reading the form.
- **Only one execution UI.** `Run ▶` on a tool card selects the tool and switches to
  Execute rather than duplicating the form logic. Keep it that way.
- `recordExecution()` is called from both the manual path and `runToolCall()`, so History
  covers manual and model-driven runs alike.

## Native WebMCP API (the part that bit us)

Three things about the **current** API, all fixed in 0.4.1 and all easy to regress:

- The context object lives on **`document.modelContext`**. `navigator.modelContext` and
  `window.modelContext` are earlier drafts; keep checking them, but `document` goes first.
- **`RegisteredTool.inputSchema` is a JSON string.** Treating it as an object silently
  produced an empty schema, so the inspector said "No input needed" and the model invented
  arguments (`trigger_type: "User Story"` for a `triggerType` enum). `normalizeInputSchema`
  parses strings; anything that is not a JSON object throws so the error is visible.
  **Never let a schema failure fall back to "no parameters".**
- **`executeTool(registeredTool, args)` takes the object, not the name.** A string throws
  `The provided value is not of type 'RegisteredTool'`. The object is realm-bound: it
  cannot be cached in the panel nor cross `postMessage`, so `resolveRegisteredTool()` calls
  `getTools()` in the page immediately before each execution and matches on name + origin.
  Legacy `callTool(name, args)` runs **only** for contexts without the current API — never
  try the string form first and swallow its TypeError.

`supportsRegisteredToolApi()` detects the current API **by shape** (`getTools` +
`executeTool`), since the spec exposes no version to test. Its known limit: an old
experimental implementation exposing both methods but still expecting
`executeTool(name, args)` matches and then fails. Left that way on purpose — sniffing
harder means guessing at implementations nobody here can test, and retrying with the
string form on error would re-introduce the swallowed-TypeError bug. Such a page fails
loudly with its own error shown in the panel.

`demo/webmcp-native-demo.html` reproduces all three locally (the `createFeature` case), and
its fake `executeTool` throws the real TypeError when handed a name.

## Registration method (Tools card badge)

`RegisteredTool` says nothing about how it was registered — the IDL is identical for
declarative and imperative — so `page-hook.js` infers it and the panel must never
hardcode a value (it did, and reported every declarative form as "JavaScript API"):

- `javascript` — the name passed through the wrapped `provideContext()`/`registerTool()`.
- `declarative` — `document.querySelector('form[toolname="<name>"]')` matches. The
  declarative API uses `toolname`, `tooldescription` and `toolparamdescription`.
- `unknown` — neither. **Say unknown; never fall back to "JavaScript API".**

`unknown` is expected when the hook was rescue-injected into an already-loaded tab: it
could not have seen a registration that predates it. `descriptor.installedEarly` records
whether we were in place at `document_start`, so that case remains distinguishable.

## executeTool argument form

The spec says `executeTool(tool, optional object inputObject)`; the shipping
implementation wants a **JSON string** and answers `Failed to parse input string as JSON`
for an object (it stringifies to `"[object Object]"`). `callExecuteTool()` sends the
object, then retries once with `JSON.stringify(args)` **only** on that exact message —
which the platform raises before the tool runs, so nothing executes twice. Every other
rejection propagates untouched: never widen that regex into a generic retry, or a failing
`createFeature` will create two features. The result is cached per context in a WeakMap.

## Keeping the badge and tool list fresh

Three signals, and all three are needed:

- `chrome.tabs.onActivated` and `onUpdated` (`complete`) in `background.js` → `refreshBadge`.
  Without these the count is only ever computed when a tab's bridge connects.
- `tools-changed` from the wrapped `provideContext`/`registerTool` → script registrations.
- A throttled `MutationObserver` on `form[toolname]` in `page-hook.js` → **declarative**
  tools, which are markup and come and go with client-side navigation without any script
  call the wrappers could see.

The side panel also re-inspects on `visibilitychange`.

**The panel does not watch `chrome.tabs` for activation.** The worker pushes an
`active-tab` message instead, because `ports` lives in worker memory: a restart empties
it while the content scripts keep running, so a panel that asks the instant the tab
changes gets an empty map and reports zero tools. `ensureInjected()` therefore waits up
to two seconds for a port **even when `executeScript` throws** — a failed injection says
nothing about a bridge already reconnecting. Removing that wait brings back "you have to
press refresh after every tab switch".

## Gotchas

- After reloading the extension you must **F5 the open tabs**; content scripts are not
  re-injected on their own.
- The SW sleeps: `content.js` reconnects the port on `onDisconnect` after 1 s.
- **Ollama `403`**: `chrome-extension://` is not in `OLLAMA_ORIGINS` by default. It is
  confusing because it fails halfway: Chrome does not add `Origin` to `GET /api/tags`
  (no headers of its own) so the models load, but `POST /api/chat` carries `Content-Type`
  → Chrome adds `Origin` → 403. Verified on Ollama 0.32.15: the same POST without
  `Origin` returns 200. Fix: `setx OLLAMA_ORIGINS "chrome-extension://*"` + restart Ollama.
  Deliberate decision: this is **not** worked around by stripping `Origin` with
  `declarativeNetRequest`, because that rule would also apply to requests from any website
  visited and would expose the local Ollama to any page.
- `/api/chat` streaming is NDJSON; `tool_calls` arrive as a complete object in a single
  chunk, not as deltas → accumulated with `push(...)`.
- Models without the `tools` capability (see `/api/tags` → `capabilities`) ignore the tool
  array without raising an error.
- **`flex: 0 0 auto` on the children of `.chat` and `.tools-list` is load-bearing.** Both
  are flex columns, so their children default to `flex-shrink: 1` and get squeezed once the
  content overflows instead of letting the container scroll. `.toolcall` and `.tool-card`
  both clip with `overflow: hidden` (needed for the `border-radius`), so squeezing does not
  produce a scrollbar — it silently cuts them off. Measured, not guessed: a tool call card
  collapsed to 2px, and tool cards lost their footer. **Any scrolling flex column added
  here needs the same rule.**

## Running it

```bash
ollama serve
```

`chrome://extensions` → Developer mode → Load unpacked → the repo folder.
Open `demo/webmcp-demo.html` and ask it to "add buy bread".

## Packaging and publishing

```bash
pwsh ./build.ps1
```

- The zip must carry `manifest.json` **at its root**, not inside a subfolder, or Chrome
  and the Web Store reject it. That is why `$staging\*` is compressed, not the folder.
- `$include` in `build.ps1` is an allowlist: **if you add a new file that ships, it has to
  go in there** or it will not reach the zip (the script fails when a listed file is
  missing, but it cannot warn about files nobody listed).
- Release: `git tag vX.Y.Z && git push origin vX.Y.Z`. The workflow aborts if the tag does
  not match the manifest `version`, so **bump the manifest version first**.
- Chrome cannot install `.zip`/`.crx` from outside the Web Store: real distribution is
  download the release zip, unzip, "Load unpacked".

## Credits (keep them visible)

The README explicitly credits **François Beaufort**
(`beaufortfrancois/model-context-tool-inspector`, Apache-2.0) and **n4ze3m**
(`page-assist`, MIT). Do not remove that section nor the credits note in the side panel.
