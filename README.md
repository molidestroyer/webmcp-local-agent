# WebMCP Local Agent

A Chrome extension (Manifest V3) that combines two things in one side panel:

1. **WebMCP inspection** — detects the tools the active page registers on
   `navigator.modelContext` / `window.modelContext` and can execute them.
2. **Local Ollama client** — chat against `http://127.0.0.1:11434` with a dynamic
   picker for the models you have pulled, and full **tool calling**: the model calls the
   page's tools and you see every call, its arguments and its result.

Everything runs locally. The extension talks to no external service.

---

## Demo

Real footage: the extension discovering the five tools this page registers, a local
`gemma` picking `create_contact`, filling it from a sentence in plain language and running
it against the page — the contact on the left is created by that call.

<video src="https://github.com/molidestroyer/webmcp-local-agent/raw/main/docs/demo.mp4"
       poster="https://github.com/molidestroyer/webmcp-local-agent/raw/main/docs/demo-poster.jpg"
       controls muted playsinline width="100%"></video>

[![WebMCP Local Agent demo](https://github.com/molidestroyer/webmcp-local-agent/raw/main/docs/demo-poster.jpg)](https://github.com/molidestroyer/webmcp-local-agent/raw/main/docs/demo.mp4)

*(1:46 — if the player above does not load, the image is a link to the file.)*

The chat scenes are sped up: a 4B model on a laptop answers in about half a minute, and
that is dead air in a demo. Nothing else is edited — the tool calls, their arguments and
their results are the real ones.

---

## Credits

This project **would not exist without the prior work of these authors** — it is little
more than a combination of their ideas in a single extension:

| Project | Author | What was taken from it |
| --- | --- | --- |
| [**model-context-tool-inspector**](https://github.com/beaufortfrancois/model-context-tool-inspector) | **François Beaufort** ([@beaufortfrancois](https://github.com/beaufortfrancois)) | The WebMCP inspection approach: inject into the *MAIN world* and wrap `provideContext()` / `registerTool()` to discover and execute the tools a page declares. Apache-2.0 licensed. |
| [**Page Assist**](https://github.com/n4ze3m/page-assist) | **Muhammed Nazeem** ([@n4ze3m](https://github.com/n4ze3m)) | The idea of a Chrome side panel as a local Ollama client, with model discovery and chat about the current tab. MIT licensed. |
| [**WebMCP**](https://github.com/webmachinelearning/webmcp) | W3C Web Machine Learning CG | The API specification that makes all of this possible. |
| [**Ollama**](https://github.com/ollama/ollama) | Ollama | The local model runtime and its tool-calling API. |

The code in this repository is written from scratch — no code was copied from those
projects — but the design is directly inspired by them. If you find this useful, go star
theirs first.

---

## Requirements

- Chrome 116 or newer (side panel + content scripts in `world: "MAIN"`).
- [Ollama](https://ollama.com) running locally with at least one model that has the
  **`tools`** capability:

```bash
ollama pull qwen3:8b
```

Models without `tools` still show up in the picker but will silently ignore the tools.
The picker marks the ones that do support them with `· tools`.

- Ollama must allow the extension's origin. **This is the single most common setup
  problem** — see [the Ollama 403](#the-ollama-403) below.

---

## Installation

### Option A — trying it on another machine (release zip)

No cloning and no node required:

1. Download the `.zip` from the [latest release](https://github.com/molidestroyer/webmcp-local-agent/releases/latest).
2. Unzip it into a folder.
3. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick that folder.

> Chrome does not install `.zip` or `.crx` files from outside the Web Store: you have to
> unzip and load the folder. It is one extra step, but it is the only route that does not
> involve publishing to the Store.

### Option B — from the repo

```bash
git clone https://github.com/molidestroyer/webmcp-local-agent.git
```

`chrome://extensions` → **Developer mode** → **Load unpacked** → the repo folder.

Then pin the ⚡ icon to the toolbar and click it to open the side panel.

> After installing or reloading the extension, **refresh (F5) any tabs that were already
> open**. Content scripts are not injected retroactively into pages that had already loaded.

---

## Build and distribution

There is no bundler and there are no dependencies: the "build" only validates and packages.

```bash
pwsh ./build.ps1
```

It produces `dist/webmcp-local-agent-<version>.zip` with `manifest.json` at the root —
the layout accepted by both **Load unpacked** (after unzipping) and the Chrome Web Store.
Before compressing it checks the `.js` files with `node --check` and verifies that every
file the manifest declares actually exists.

CI ([`.github/workflows/build.yml`](.github/workflows/build.yml)) runs **that same script**
on every push to `main` and uploads the zip as an artifact. To publish a release:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

The workflow verifies the tag matches the `version` in `manifest.json` (and fails if it
does not), then creates the GitHub release with the zip attached.

---

## Usage

You need a page that exposes WebMCP tools.

**Playground: <https://molidestroyer.github.io/webmcp-local-agent/>** — four demo pages, no
setup. Served over HTTPS from a real origin, so unlike a local `file://` page they also
exercise the origin matching the extension does when resolving a tool.

- **[Imperative demo](https://molidestroyer.github.io/webmcp-local-agent/webmcp-demo.html)** —
  `navigator.modelContext.registerTool(tool)`, a todo list.
- **[Native API demo](https://molidestroyer.github.io/webmcp-local-agent/webmcp-native-demo.html)**
  — `document.modelContext`, `getTools()` returning `RegisteredTool` objects whose
  `inputSchema` is a JSON string, `executeTool(registeredTool, args)`. Its `createFeature`
  tool has four required inputs, two constrained by `enum` / `anyOf`.
- **[Declarative form demo](https://molidestroyer.github.io/webmcp-local-agent/webmcp-form-demo.html)**
  — the same tool declared entirely in markup with `<form toolname="...">`; no registration
  code runs, and the Tools panel reports it as an HTML form.
- **[Multi-country contacts demo](https://molidestroyer.github.io/webmcp-local-agent/webmcp-contacts-demo.html)**
  — country-aware contact tools (`create_contact`, `search_contact`, `list_contacts`,
  `delete_contact`, `validate_address` for ZA/ES/CA) plus the Knowledge Catalog: switch
  `?region=` and the Settings tab's Rules Inspector picks up matching business rules and
  suggested prompts.

The same files ship inside the extension (`demo/`), so you can open them offline too.
`demo/` is the single source for both — the workflow publishes that folder as-is.

**The toolbar icon tells you when a page has tools** — a green badge with the count appears
without opening anything. It is per-tab and clears on navigation.

Click the icon to open the panel. The header holds the tool count, the re-inspect button
and the Ollama model picker (persisted in `chrome.storage.local`). Below it, four tabs:

| Tab | What it is for |
| --- | --- |
| 💬 **Chat** | Talk to the model. It calls the page's tools on its own; each call shows up as a card with its arguments and result. `Enter` sends, `Shift+Enter` adds a line. |
| 🧰 **Tools** | One card per detected tool: icon, title, full description, a plain-language summary of what it needs, a pill per parameter with its type (`*` = required) and where it was registered. `Run ▶` hands the tool over to Execute. |
| ▶ **Execute** | Run a tool by hand, no model involved. Pick it from the chips, fill the generated form, hit `▶ Execute Tool`. |
| 📜 **History** | Every execution — manual and model-driven — with timestamp, duration, arguments and output. Persisted across sessions, capped at 100 entries. |

With the todo demo you can try: *"add buy bread"*, *"what is still pending?"*,
*"mark #1 as done"*, *"switch the page to dark mode"*. With the native one, ask it to file
a feature and check that it uses the declared constants (`ChangeRequest`, `P2`) rather than
inventing its own.

### The Execute tab

The form is generated from the tool's JSON Schema and typed accordingly: `format: date`
becomes a date picker, `enum` a `<select>`, `boolean` a checkbox, `integer` a number input.

Fields arrive **prefilled with plausible values** — today's date for dates, the current
time for times, `user@example.com` for emails, the schema `default` or `minimum` when it
declares one — so most tools are one click from running.

Underneath, a **live JSON editor** stays in sync in both directions: edit a field and the
JSON updates, edit the JSON and the fields follow. While the JSON does not parse the state
chip turns red and `Execute` is disabled, so a malformed payload never reaches the page.
When it does parse, the JSON wins — it is what you edited last.

The result appears with a status chip (`✔ Success · 0.42s` / `✖ Error · 0.02s`) and the raw
response, and the run is added to History.

### Chat controls

| Control | What it does |
| --- | --- |
| 🔄 (header, right) | Re-inspects the active tab. |
| 🔄 (model row) | Queries `/api/tags` again — use it after an `ollama pull` in a terminal. |
| 🗑 | Clears the conversation. |
| ☑ Confirm every tool | Asks for your approval before each call. Off by default. |

---

## How it works

```
sidepanel.js ──chrome.runtime──> background.js ──Port──> content.js ──postMessage──> page-hook.js
   │                                                                                     │
   └── fetch() ──> Ollama 127.0.0.1:11434                        navigator.modelContext ─┘
```

- **`page-hook.js`** runs in the *MAIN world* at `document_start`. It looks for the context
  object on `document.modelContext` (the current API) and on `navigator.modelContext` /
  `window.modelContext` / `window.agent` (earlier drafts and polyfills). It wraps
  `provideContext()`, `registerTool()` and `unregisterTool()` to track the live tools,
  keeping the real reference to each `execute` function, and also reads `getTools()` for
  tools registered before it could hook in.
- **`lib/webmcp-schema.js`** holds the pure logic shared by the hook, the panel and the
  tests: schema normalization and RegisteredTool resolution. See
  [Native API compatibility](#native-api-compatibility).
- **`content.js`** lives in the isolated world and opens a `Port` **towards** the service
  worker. That is why the extension **needs no host permissions over the pages you visit**:
  `tabs.sendMessage` is never used.
- **`background.js`** keeps the `tabId → Port` map and routes request/response. If a tab
  has no bridge (it was open before the extension was installed), it injects one with
  `chrome.scripting.executeScript`, relying on `activeTab`. It also drives the per-tab
  toolbar badge: it counts the tools shortly after a bridge connects, on every
  `tools-changed` event and on every listing the panel asks for, and clears it when a tab
  starts navigating.
- **`sidepanel.js`** translates each WebMCP tool into Ollama's format
  (`{ type: "function", function: { name, description, parameters } }`), calls
  `POST /api/chat` with `stream: true`, accumulates `tool_calls`, runs them on the page,
  appends the result as a `role: "tool"` message and calls the model again.
  Six rounds per turn, maximum.

Streaming also surfaces the `thinking` block of reasoning models (qwen3, gemma with
thinking) inside a collapsed disclosure.

---

## Native API compatibility

The WebMCP surface has moved, and two details of the current one are easy to get wrong.
Both are handled in `lib/webmcp-schema.js` and covered by unit tests.

**`inputSchema` is a JSON string.** `RegisteredTool.inputSchema` arrives serialized, not as
an object. Treating it as an object makes it fail a type check and collapse into an empty
schema — the inspector then says "No input needed" and the model, given no parameters,
invents its own. `normalizeInputSchema()` parses strings, passes objects through by
reference, and throws on anything that is not a JSON object so a broken schema surfaces as
an error instead of masquerading as a parameterless tool. Properties, `required`, `enum`,
`anyOf`, titles and descriptions reach the model exactly as declared.

**`executeTool()` takes the tool object, not its name.** The call is
`executeTool(registeredTool, args)`; passing a string throws
`The provided value is not of type 'RegisteredTool'`. A `RegisteredTool` is bound to the
page's realm, so it can be neither cached in the panel nor sent through extension
messaging. The hook therefore calls `getTools()` in the page immediately before every
execution, matches on name plus `origin`, and passes back that exact object. If the tool
was removed or re-registered in between you get
`WebMCP tool "x" is no longer registered on this page.`

Older `callTool(name, args)` shapes still work, but only on contexts that do not implement
the current API — the RegisteredTool path is primary and its errors are never swallowed.

The current API is detected by its shape (`getTools` + `executeTool`), as the spec offers
no version to test. One known limit: an early experimental implementation exposing both
methods while still expecting `executeTool(name, args)` would match and then fail. That is
intentional — it fails loudly with the page's own error rather than being papered over by a
retry that would hide real failures of the current API.

## Tests

```bash
node --test
```

No dependencies: `node:test` against `lib/webmcp-schema.js`. `build.ps1` and CI both run
the suite before packaging, so a failing test blocks the zip.

## Security notes

- **Tool definitions come from the web page, which is untrusted content.** A page can
  declare a tool with any description it likes in order to nudge the model into calling it.
  If you use this on sites you do not control, turn on **"Confirm every tool"**.
- The MAIN ↔ ISOLATED channel uses `window.postMessage`, so the page itself can observe
  (and in theory forge) those messages. That is inherent to inspecting an API that lives
  in the page's own world.
- The extension's only network permission is `localhost:11434` / `127.0.0.1:11434`.

---

## Troubleshooting

| Symptom | Cause → Fix |
| --- | --- |
| **Models load but sending returns `403`** | The most common one. See below. |
| "Ollama not detected" | The service is not running → `ollama serve`, then 🔄. |
| "0 tools" on a page that does have them | The tab was loaded before the extension was installed → F5. |
| "Could not connect to the tab" | `chrome://`, `chrome-extension://` pages and the Chrome Web Store do not allow content scripts. |
| The model ignores the tools | That model lacks the `tools` capability → pick one marked `· tools`. |

### The Ollama 403

Ollama only accepts requests from the origins in `OLLAMA_ORIGINS`, and
`chrome-extension://` **is not on the default list**. The symptom is confusing because it
fails halfway: Chrome does not attach an `Origin` header to `GET /api/tags` (it carries no
headers of its own), so **the model list loads fine**; but `POST /api/chat` does send
`Content-Type: application/json`, Chrome adds `Origin`, and Ollama returns `403`.

Verified against Ollama 0.32.15:

| Request | Status |
| --- | --- |
| `POST /api/chat` without `Origin` | `200` |
| `POST /api/chat` with `Origin: chrome-extension://…` | `403` |

Fix, on Windows:

```bash
setx OLLAMA_ORIGINS "chrome-extension://*"
```

then **restart Ollama** from the tray icon — `setx` only affects newly started processes,
not the one already running. On Linux/macOS, `export OLLAMA_ORIGINS='chrome-extension://*'`
before `ollama serve` (or `systemctl edit ollama` if it runs as a service).

> The extension deliberately does **not** work around this by stripping the `Origin`
> header with `declarativeNetRequest`. It would be possible, but that rule would also
> apply to requests from any website you visit, leaving your local Ollama reachable from
> any page. An explicit configuration change is the better trade-off.

---

## License

MIT — see [LICENSE](LICENSE).
