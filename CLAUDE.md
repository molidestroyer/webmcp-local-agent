# CLAUDE.md — WebMCP Local Agent

## Qué es

Extensión de Chrome MV3 que abre un side panel con dos cosas conectadas entre sí:

1. **Inspector WebMCP** — descubre las tools que la pestaña activa registra en
   `navigator.modelContext` / `window.modelContext` y sabe ejecutarlas.
2. **Cliente de Ollama local** (`127.0.0.1:11434`) — chat con selector dinámico de
   modelos descargados y **tool calling**: el modelo llama a las tools de la web,
   se ejecutan en el DOM y el resultado vuelve al modelo para que redacte la respuesta.

JS vanilla, sin bundler ni dependencias. El "build" (`build.ps1`) solo valida y comprime.
Todo es local: el único destino de red es Ollama.

## Repo

- Remote: **`https://github.com/molidestroyer/webmcp-local-agent`** (público).
- ⚠️ La cuenta es **`molidestroyer`**, no `miguelmolinamontilla`. Son dos cuentas
  distintas de Miguel; la principal (CV y demás repos) y las credenciales guardadas en
  el Git Credential Manager de esta máquina son las de `molidestroyer`. Empujar a la
  otra cuenta falla con 403.
- Publicado: `v0.1.0`, con el zip adjunto en Releases.

## Estructura

| Archivo | Mundo | Responsabilidad |
| --- | --- | --- |
| `manifest.json` | — | MV3. Permisos: `sidePanel`, `activeTab`, `scripting`, `storage`, `tabs`. Host permissions **solo** hacia `11434`. |
| `page-hook.js` | MAIN | Envuelve `provideContext` / `registerTool` / `unregisterTool` para registrar tools y guardar la referencia real a `execute`. Responde a `list` y `execute` por `postMessage`. |
| `content.js` | ISOLATED | Puente. Abre `chrome.runtime.connect({name:'webmcp-bridge'})` **hacia** el SW. |
| `background.js` | SW | Mapa `tabId → Port`, enrutado request/response con timeout, `sidePanel.setPanelBehavior`, inyección de rescate vía `scripting.executeScript`. |
| `sidepanel.{html,css,js}` | panel | UI + ciclo de tool calling contra `/api/chat`. |
| `demo/webmcp-demo.html` | — | Página de prueba con polyfill de `navigator.modelContext` y 4 tools. |
| `build.ps1` | — | Valida + empaqueta a `dist/webmcp-local-agent-<version>.zip`. |
| `.github/workflows/build.yml` | — | CI: ejecuta `build.ps1` (pwsh está preinstalado en `ubuntu-latest`), sube artefacto y publica release en tags `v*`. |

## Decisiones que conviene no deshacer

- **El content script conecta hacia el SW**, nunca al revés. Eso evita necesitar
  `host_permissions: ["<all_urls>"]` (no se usa `tabs.sendMessage`). Si algún día se
  cambia, el manifest necesitará ese permiso y Chrome mostrará el aviso de "leer todos
  tus datos en todos los sitios".
- **`world: "MAIN"` en `content_scripts`**, no inyección de `<script>`: la CSP de muchas
  páginas bloquea la segunda vía.
- **`document_start`** es obligatorio: si la página llama a `provideContext()` antes de
  que enganchemos, solo quedaría el fallback de leer `tools`/`getTools()`, que muchas
  implementaciones no exponen.
- `page-hook.js` pasa a `execute()` un objeto que sirve tanto para `execute(args)` como
  para `execute({ name, arguments })`, porque las implementaciones difieren.
- Todo lo que cruza `postMessage` pasa por `JSON.parse(JSON.stringify(...))`: los
  resultados de tools pueden traer funciones o nodos DOM y romperían `structuredClone`.

## Gotchas

- Tras recargar la extensión hay que **F5 en las pestañas abiertas**; los content scripts
  no se reinyectan solos.
- El SW se duerme: `content.js` reconecta el puerto en `onDisconnect` con 1 s de retardo.
- Ollama necesita `OLLAMA_ORIGINS=chrome-extension://*` si rechaza el origen (CORS).
- El streaming de `/api/chat` es NDJSON; `tool_calls` llega como objeto completo en un
  chunk, no como deltas → se acumula con `push(...)`.
- Los modelos sin capacidad `tools` (ver `/api/tags` → `capabilities`) ignoran el array
  de herramientas sin dar error.

## Probar

```bash
ollama serve
```

`chrome://extensions` → Modo desarrollador → Cargar descomprimida → carpeta del repo.
Abrir `demo/webmcp-demo.html` y pedir «añade comprar pan».

## Empaquetar y publicar

```bash
pwsh ./build.ps1
```

- El zip debe llevar `manifest.json` **en la raíz**, no dentro de una subcarpeta, o Chrome
  y la Web Store lo rechazan. Por eso se comprime `$staging\*` y no la carpeta.
- `$include` en `build.ps1` es una lista blanca: **si añades un archivo nuevo que se
  distribuye, hay que meterlo ahí** o no llegará al zip (el script falla si un archivo
  listado no existe, pero no avisa de los que faltan por listar).
- Release: `git tag vX.Y.Z && git push origin vX.Y.Z`. El workflow aborta si el tag no
  coincide con `version` del manifest, así que **sube la versión del manifest primero**.
- Chrome no permite instalar `.zip`/`.crx` fuera de la Web Store: la distribución real es
  descargar el zip de la release, descomprimir y "Cargar descomprimida".

## Créditos (mantener visibles)

El README atribuye explícitamente a **François Beaufort**
(`beaufortfrancois/model-context-tool-inspector`, Apache-2.0) y a **n4ze3m**
(`page-assist`, MIT). No quitar esa sección ni la nota de créditos del side panel.
