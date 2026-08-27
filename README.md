# WebMCP Local Agent

Extensión de Chrome (Manifest V3) que junta dos cosas en un side panel:

1. **Inspección WebMCP** — detecta las herramientas que la página activa registra en
   `navigator.modelContext` / `window.modelContext` y permite ejecutarlas.
2. **Cliente local de Ollama** — chat contra `http://127.0.0.1:11434` con selector
   dinámico de los modelos que tengas descargados y **tool calling** completo:
   el modelo llama a las tools de la web y tú ves cada llamada, sus argumentos y su resultado.

Todo ocurre en local. La extensión no habla con ningún servicio externo.

---

## Créditos

Este proyecto **no existiría sin el trabajo previo de estos autores**, y no es más que una
combinación de sus ideas en una sola extensión:

| Proyecto | Autor | Qué se ha tomado de él |
| --- | --- | --- |
| [**model-context-tool-inspector**](https://github.com/beaufortfrancois/model-context-tool-inspector) | **François Beaufort** ([@beaufortfrancois](https://github.com/beaufortfrancois)) | El enfoque de inspección de WebMCP: inyectar en el *MAIN world* e interceptar `provideContext()` / `registerTool()` para descubrir y ejecutar las tools que declara una página. Licencia Apache-2.0. |
| [**Page Assist**](https://github.com/n4ze3m/page-assist) | **Muhammed Nazeem** ([@n4ze3m](https://github.com/n4ze3m)) | La idea de un side panel de Chrome como cliente de Ollama en local, con descubrimiento de modelos y chat sobre la pestaña actual. Licencia MIT. |
| [**WebMCP**](https://github.com/webmachinelearning/webmcp) | W3C Web Machine Learning CG | La especificación de la API que hace posible todo esto. |
| [**Ollama**](https://github.com/ollama/ollama) | Ollama | El runtime local de modelos y su API de tool calling. |

El código de este repositorio está escrito desde cero (no se ha copiado código de esos
proyectos), pero el diseño está directamente inspirado en ellos. Si te resulta útil,
ve primero a darles una estrella a ellos.

---

## Requisitos

- Chrome 116 o superior (side panel + content scripts en `world: "MAIN"`).
- [Ollama](https://ollama.com) corriendo en local con al menos un modelo **con capacidad `tools`**:

```bash
ollama pull qwen3:8b
```

Modelos sin `tools` (por ejemplo los `-embed` o algunos gemma antiguos) aparecerán en el
desplegable pero ignorarán las herramientas. El selector marca con `· tools` los que sí las soportan.

---

## Instalación

### Opción A — probarla en otra máquina (zip de la release)

No hace falta clonar nada ni tener node instalado:

1. Descarga el `.zip` de la [última release](https://github.com/molidestroyer/webmcp-local-agent/releases/latest).
2. Descomprímelo en una carpeta.
3. `chrome://extensions` → activa **Modo desarrollador** → **Cargar descomprimida** → esa carpeta.

> Chrome no instala `.zip` ni `.crx` de fuera de la Web Store: hay que descomprimir
> y cargar la carpeta. Es un paso, pero es la única vía sin publicar en la Store.

### Opción B — desde el repo

```bash
git clone https://github.com/molidestroyer/webmcp-local-agent.git
```

`chrome://extensions` → **Modo desarrollador** → **Cargar descomprimida** → la carpeta del repo.

Después, ancla el icono ⚡ a la barra y púlsalo: se abre el side panel.

> Tras instalar o recargar la extensión, **refresca (F5) las pestañas ya abiertas**.
> Los content scripts no se inyectan retroactivamente en páginas que ya estaban cargadas.

---

## Build y distribución

No hay bundler ni dependencias: el "build" solo valida y empaqueta.

```bash
pwsh ./build.ps1
```

Genera `dist/webmcp-local-agent-<version>.zip` con `manifest.json` en la raíz —el formato
que aceptan tanto **Cargar descomprimida** (tras descomprimir) como la Chrome Web Store—.
Antes de comprimir comprueba la sintaxis de los `.js` con `node --check` y que todos los
archivos declarados en el manifest existen de verdad.

CI ([`.github/workflows/build.yml`](.github/workflows/build.yml)) ejecuta **ese mismo
script** en cada push a `main` y sube el zip como artefacto. Para publicar una release:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

El workflow verifica que el tag coincide con la `version` del `manifest.json` (falla si no)
y crea la release de GitHub con el zip adjunto.

---

## Uso

1. Abre una página que exponga tools WebMCP. Si no tienes ninguna a mano, usa la incluida:
   abre `demo/webmcp-demo.html` en Chrome (arrastra el archivo a una pestaña).
2. Pulsa el icono de la extensión.
3. Elige modelo en el desplegable. Se guarda en `chrome.storage.local` y se recuerda.
4. El badge de la cabecera indica cuántas tools se han detectado (`3 Tools detectadas`).
   Púlsalo para ver el nombre y la descripción de cada una.
5. Escribe. Si el modelo decide usar una herramienta, verás una tarjeta 🔧 con el nombre,
   los argumentos JSON y el resultado; después el modelo redacta la respuesta final.

Con la demo incluida puedes probar: *«añade comprar pan»*, *«¿qué tengo pendiente?»*,
*«marca la 1 como hecha»*, *«pon la página en modo oscuro»*.

### Controles

| Control | Qué hace |
| --- | --- |
| `<select>` de modelos | Lista lo que devuelve `GET /api/tags`. Selección persistida. |
| 🔄 | Vuelve a consultar `/api/tags` (úsalo tras un `ollama pull` en terminal). |
| Badge de tools | Muestra/oculta la lista de herramientas detectadas. |
| ⟳ | Reinspecciona la pestaña activa. |
| 🗑 | Vacía la conversación. |
| ☑ Confirmar cada tool | Pide tu aprobación antes de ejecutar cada llamada. Desactivado por defecto. |

---

## Cómo funciona

```
sidepanel.js ──chrome.runtime──> background.js ──Port──> content.js ──postMessage──> page-hook.js
   │                                                                                     │
   └── fetch() ──> Ollama 127.0.0.1:11434                        navigator.modelContext ─┘
```

- **`page-hook.js`** se ejecuta en el *MAIN world* en `document_start`. Envuelve
  `provideContext()`, `registerTool()` y `unregisterTool()` para llevar un registro de las
  tools vivas, conservando la referencia real a cada función `execute`. Si la página las
  registró antes de que pudiéramos engancharnos, hace *fallback* a leer `tools` /
  `getTools()` / `listTools()`, y para ejecutar usa `callTool()` si existe.
- **`content.js`** vive en el mundo aislado y abre un `Port` **hacia** el service worker.
  Por eso la extensión **no necesita `host_permissions` sobre las páginas que visitas**:
  nunca se hace `tabs.sendMessage`.
- **`background.js`** mantiene el mapa `tabId → Port` y enruta petición/respuesta. Si la
  pestaña no tiene puente (pestaña abierta antes de instalar), lo inyecta con
  `chrome.scripting.executeScript` aprovechando `activeTab`.
- **`sidepanel.js`** traduce cada tool WebMCP al formato de Ollama
  (`{ type: "function", function: { name, description, parameters } }`), llama a
  `POST /api/chat` con `stream: true`, acumula `tool_calls`, las ejecuta en la página,
  añade el resultado como mensaje `role: "tool"` y vuelve a llamar al modelo.
  Máximo 6 rondas por turno.

El *streaming* también muestra el bloque `thinking` de los modelos que razonan
(qwen3, gemma con thinking) en un desplegable colapsado.

---

## Notas de seguridad

- **Las definiciones de tools vienen de la página web, que es contenido no confiable.**
  Una página puede declarar una herramienta con la descripción que quiera para intentar
  inducir al modelo a llamarla. Si vas a usar esto en sitios que no controlas, activa
  **«Confirmar cada tool»**.
- El canal MAIN ↔ ISOLATED usa `window.postMessage`, así que la propia página puede ver
  (y en teoría falsificar) esos mensajes. Es una limitación inherente a inspeccionar una
  API que vive en el mundo de la página.
- La extensión solo tiene permiso de red hacia `localhost:11434` / `127.0.0.1:11434`.

---

## Problemas frecuentes

| Síntoma | Causa → Solución |
| --- | --- |
| **Los modelos cargan pero al enviar sale `403`** | El caso más frecuente. Ver abajo. |
| «Ollama no detectado» | El servicio no está arrancado → `ollama serve`, luego 🔄. |
| «0 Tools» en una página que sí las tiene | La pestaña se cargó antes de instalar la extensión → F5. |
| «No se pudo conectar con la pestaña» | Páginas `chrome://`, `chrome-extension://` y la Chrome Web Store no admiten content scripts. |
| El modelo ignora las herramientas | Ese modelo no tiene capacidad `tools` → elige uno marcado con `· tools`. |

### El `403` de Ollama (léelo antes de abrir un issue)

Ollama solo acepta peticiones desde los orígenes de `OLLAMA_ORIGINS`, y
`chrome-extension://` **no está en la lista por defecto**. El síntoma despista porque
falla a medias: Chrome no añade la cabecera `Origin` al `GET /api/tags` (no lleva
cabeceras propias), así que **la lista de modelos carga bien**; pero el `POST /api/chat`
sí manda `Content-Type: application/json`, Chrome añade `Origin` y Ollama devuelve `403`.

Comprobado contra Ollama 0.32.15:

| Petición | Código |
| --- | --- |
| `POST /api/chat` sin `Origin` | `200` |
| `POST /api/chat` con `Origin: chrome-extension://…` | `403` |

Solución, en Windows:

```bash
setx OLLAMA_ORIGINS "chrome-extension://*"
```

y **reinicia Ollama** desde el icono de la bandeja — `setx` solo afecta a procesos nuevos,
no al que ya está corriendo. En Linux/macOS, `export OLLAMA_ORIGINS='chrome-extension://*'`
antes de `ollama serve` (o `systemctl edit ollama` si va como servicio).

> La extensión **no** intenta esquivar esto borrando la cabecera `Origin` con
> `declarativeNetRequest`. Sería posible, pero esa regla se aplicaría también a las
> peticiones de cualquier web que visites, y dejaría tu Ollama local accesible desde
> cualquier página. Es preferible el cambio explícito de configuración.

---

## Licencia

MIT — ver [LICENSE](LICENSE).
