# WebMCP Local Agent

A Chrome extension (Manifest V3) that combines two things in one side panel:

1. **WebMCP inspection** — detects the tools the active page registers on
   `navigator.modelContext` / `window.modelContext` and can execute them.
2. **Local Ollama client** — chat against `http://127.0.0.1:11434` with a dynamic
   picker for the models you have pulled, and full **tool calling**: the model calls the
   page's tools and you see every call, its arguments and its result.

Everything runs locally. The extension talks to no external service.

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

1. Open a page that exposes WebMCP tools. If you have none at hand, use the bundled one:
   open `demo/webmcp-demo.html` in Chrome (drag the file onto a tab).
2. Click the extension icon.
3. Pick a model. The choice is saved to `chrome.storage.local` and remembered.
4. The header badge shows how many tools were detected (`3 tools detected`). Click it to
   see each tool's name and description.
5. Type. If the model decides to use a tool, you get a 🔧 card with its name, the JSON
   arguments and the result; the model then writes the final answer.

With the bundled demo you can try: *"add buy bread"*, *"what is still pending?"*,
*"mark #1 as done"*, *"switch the page to dark mode"*.

### Controls

| Control | What it does |
| --- | --- |
| Model `<select>` | Lists whatever `GET /api/tags` returns. Selection is persisted. |
| 🔄 | Queries `/api/tags` again (use it after an `ollama pull` in a terminal). |
| Tools badge | Shows/hides the list of detected tools. |
| ⟳ | Re-inspects the active tab. |
| 🗑 | Clears the conversation. |
| ☑ Confirm every tool | Asks for your approval before each call. Off by default. |

---

## How it works

```
sidepanel.js ──chrome.runtime──> background.js ──Port──> content.js ──postMessage──> page-hook.js
   │                                                                                     │
   └── fetch() ──> Ollama 127.0.0.1:11434                        navigator.modelContext ─┘
```

- **`page-hook.js`** runs in the *MAIN world* at `document_start`. It wraps
  `provideContext()`, `registerTool()` and `unregisterTool()` to track the live tools,
  keeping the real reference to each `execute` function. If the page registered them
  before we could hook in, it falls back to reading `tools` / `getTools()` / `listTools()`,
  and uses `callTool()` to execute when available.
- **`content.js`** lives in the isolated world and opens a `Port` **towards** the service
  worker. That is why the extension **needs no host permissions over the pages you visit**:
  `tabs.sendMessage` is never used.
- **`background.js`** keeps the `tabId → Port` map and routes request/response. If a tab
  has no bridge (it was open before the extension was installed), it injects one with
  `chrome.scripting.executeScript`, relying on `activeTab`.
- **`sidepanel.js`** translates each WebMCP tool into Ollama's format
  (`{ type: "function", function: { name, description, parameters } }`), calls
  `POST /api/chat` with `stream: true`, accumulates `tool_calls`, runs them on the page,
  appends the result as a `role: "tool"` message and calls the model again.
  Six rounds per turn, maximum.

Streaming also surfaces the `thinking` block of reasoning models (qwen3, gemma with
thinking) inside a collapsed disclosure.

---

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
