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
| `page-hook.js` | MAIN | Wraps `provideContext` / `registerTool` / `unregisterTool` to track tools and keep the real reference to `execute`. Answers `list` and `execute` over `postMessage`. |
| `content.js` | ISOLATED | Bridge. Opens `chrome.runtime.connect({name:'webmcp-bridge'})` **towards** the SW. |
| `background.js` | SW | `tabId → Port` map, request/response routing with timeouts, `sidePanel.setPanelBehavior`, rescue injection via `scripting.executeScript`. |
| `sidepanel.{html,css,js}` | panel | UI + tool-calling loop against `/api/chat`. |
| `demo/webmcp-demo.html` | — | Test page with a `navigator.modelContext` polyfill and 4 tools. |
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
- **`.chat > * { flex: 0 0 auto; }` is load-bearing.** `.chat` is a flex column, so its
  children default to `flex-shrink: 1` and get squeezed once the conversation overflows
  instead of letting `.chat` scroll. Because `.toolcall` clips with `overflow: hidden`
  (needed for the `border-radius`), squeezing collapsed it to a 2px yellow line — measured,
  not guessed. Any new direct child of `.chat` needs the same treatment.

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
