# Changelog

## 0.7.12

- **Grabación: cambiar de hilo con el agente trabajando mezclaba conversaciones.** El turno en
  curso seguía escribiendo en `state.messages` y al terminar guardaba en el hilo al que te habías
  cambiado. Ahora *New*, abrir otro hilo o borrar el actual se rechazan mientras el agente
  trabaja (con aviso). Sin turno en marcha, una grabación en modo *session* sigue a través de los
  hilos y el `.log` marca cada cambio. Borrar el hilo actual estrena id, para que el siguiente
  mensaje no lo resucite.
- **Grabación: cerrar la pestaña grabada o pulsar «Dejar de compartir» colgaba el botón Rec.**
  `MediaRecorder` se detiene solo cuando la captura termina, y `stop()` esperaba un `onstop` que
  ya había pasado: el vídeo no se guardaba nunca y el botón quedaba deshabilitado. Ahora se guarda
  lo grabado en el momento, con aviso, tanto si graba el panel (selector de pestaña) como si graba
  el documento offscreen (`tabCapture`, que avisa con `REC_ENDED`). Test nuevo (`tests/recorder.test.js`) que reproduce el cuelgue.
- **Grabación: cambiar de pestaña** filma la original mientras el agente trabaja en la nueva.
  Se avisa una vez por cambio, en el panel y en el `.log`.
- **Grabación: Rec y Enviar a la vez** abrían dos selectores de pestaña; ahora comparten un único arranque.
- **La línea de objetivo cambia en cada paso.** La petición del usuario iba antes que el rótulo de
  la tool y, como casi nunca está vacía, el rótulo no se usaba: con un modelo que llama tools sin
  escribir texto (Copilot, modelos locales pequeños) la línea se quedaba fija toda la ejecución.
  Orden nuevo: texto del modelo → motivo del `wait` → tool de esta llamada con su argumento clave
  («Viewing hotel: champs...») → petición. Se anuncia por llamada, no por respuesta.
- **Catálogo para E2E sobre la demo de Google** (`hotel-chain` de GoogleChromeLabs/webmcp-tools).
  Regla `chromelabs-hotel-chain` por URL, con un contexto escrito a partir del código de la demo:
  tools por página, orden del flujo, fórmula del precio (3 noches en Le Champs-Élysées = $1386) y
  lo que la web **no** tiene (categoría de habitación, teléfono, casilla de términos, código de
  confirmación), para que el modelo lo diga en vez de inventarlo. Incluye el prompt E2E completo y
  otros más cortos. `demo/catalog-sample.json` y el catálogo integrado son ahora los mismos datos.
- **Explorador de prompts: «look here».** Abre en 📍 *This page* (solo las reglas de la pestaña
  delante, incluidas las que esperan a que aparezcan sus tools) si las hay; 🌐 *All* muestra todo.
  El buscador admite `/regex/` y busca también en ids y `urlPattern`. Los prompts largos conservan
  sus saltos de línea.

## 0.7.11

- **ID de extensión fijo.** Sin `key` en el manifest, Chrome deriva el ID de la carpeta desde la
  que se carga una extensión desempaquetada, y `chrome.storage.local` e IndexedDB van por ID:
  cargar otra carpeta (otra rama, otra descarga de la release) empezaba con el almacenamiento
  vacío, sin el login de Copilot, ajustes, chats, catálogo ni carpeta de grabaciones. El
  manifest lleva ahora una clave pública, y el ID es siempre `jiadmihhccjnmohgemenocmifipigolh`, cargues desde donde cargues.
  **Esta versión cambia el ID una vez**: el almacenamiento de la instalación anterior no se
  traslada, hay que volver a iniciar sesión en Copilot y a elegir la carpeta de grabaciones.
  `tests/manifest.test.js` falla si la clave desaparece o cambia.
- **El overlay (tarjetas de tools y línea de objetivo) se veía solo grabando.** Se dibujaba únicamente
  con una grabación en marcha y sus ajustes estaban en gris sin ella, así que probando el chat
  sin grabar no aparecía nada. Ahora depende solo de su ajuste, que tiene su propia tarjeta
  *Agent Overlay* (con *Overlay position*) y viene activado por defecto; el cursor virtual y los
  clics siguen siendo solo de la grabación.
- **La línea de objetivo dice el porqué, entera.** Repetía la acción de la tarjeta (y recortaba a
  10 palabras) porque el prompt prohibía al modelo escribir nada antes de llamar a una tool, y un
  `wait` no daba ninguna pista de por qué esperaba. El prompt pide ahora UNA frase corta (menos de
  15 palabras) con el motivo, en la misma respuesta que la llamada, y el overlay la muestra completa
  (solo un tope de seguridad de 400 caracteres). Si el modelo no escribe nada: para `wait` se deduce
  del paso anterior («Waiting 5s for the page to update after complete booking...»), y para el resto
  es la petición del usuario, que se mantiene estable y no repite la tarjeta. Sin tokens extra ni
  campos nuevos en las tools.
- **Explorador de prompts del catálogo** (botón 📚 junto al cuadro de mensaje, solo si hay
  prompts). Lista el catálogo entero agrupado por regla, con buscador, las reglas de la página
  actual primero y una etiqueta *this page* / *other pages* (las reglas de otras páginas no
  enviarían su contexto). Elegir uno lo deja en el cuadro de mensaje, sin enviar; Shift+clic lo
  envía. `browsePrompts()` y `ruleMatches()` en `lib/catalog-service.js`: `resolveContext`
  usa el mismo `ruleMatches`, así que ambos no pueden discrepar.

## 0.7.10

- Pulsar una sugerencia (📌 del catálogo o ✨ de la IA) ya **no envía**: pone el texto en el
  cuadro de mensaje, con el cursor al final, para leerlo o editarlo antes de pulsar Send. Con
  **Shift+clic** se envía al instante, y el ajuste *Send a suggestion as soon as it is clicked*
  devuelve el comportamiento anterior (útil para demos). Primera fase de la vista de QA del
  catálogo: elegir y revisar antes de ejecutar.
- El *Rules Inspector* ahora lista los `suggestedPrompts` de cada regla (o «No suggested
  prompts»), y marca con ⚠ las entradas que no son texto, que el esquema no validaba y que
  llegaban a un chip como «[object Object]». Solo lectura. `listRulePrompts()` en
  `lib/catalog-service.js`, con tests.

## 0.7.9

- **El `.log` ya no recorta lo importante.** Los mensajes del usuario se guardan enteros (tope de
  4000 caracteres, y si se corta lo dice), y cada tool lleva debajo su `Result:` (o `Error:`):
  ```
  [+  30.1s] [tool] complete_booking({"firstName":"Carlos"}) -> ok in 3 ms
             Result: {"confirmationId":"HB-7821","status":"confirmed"}
  ```
  Todas las salidas pasan por el mismo `trace()` de `runToolCall`: tools de la página,
  `wait`, tools inexistentes y llamadas canceladas por el usuario. `settleTools` y los empujones
  salen como `[internal]`. El formato vive en `lib/session-log.js`, con tests.
- **Pila de tarjetas en el vídeo.** Una tool que se resuelve en 3 ms desaparecía al instante;
  ahora cada tarjeta se queda al menos 2,8 s. Hay como mucho 4 a la vez: las nuevas entran por
  abajo, las anteriores suben, y si llega una ráfaga se expulsan antes las más antiguas ya
  terminadas. Las reglas de tiempo y capacidad son `createHudStack()` (sin DOM, con tests).
  `wait` también aparece.
- **Línea de objetivo** arriba a la derecha. Sale de lo que el modelo ya emitió (su razonamiento
  o la frase previa a la tool, primera frase, 10 palabras como máximo) y, si no hay, de un
  rótulo derivado del nombre de la tool («Completing booking...»). No se le pide nada al modelo
  ni hay otra petición. Solo se envía cuando cambia, y se retira al terminar el turno
  (`lib/agent-goal.js`, con tests).
- **Posición del overlay** como ajuste (*Overlay position*): las cuatro esquinas. La línea de
  objetivo y la pila forman un solo bloque anclado a la esquina elegida, para poder apartarlo de
  lo que la app tenga en ese sitio (menús, chats flotantes). Por defecto, arriba a la derecha.

## 0.7.8

- Nuevo ajuste *Recordings folder*. `chrome.downloads` no se puede silenciar: con «Preguntar
  dónde guardar cada archivo» activo en Chrome, pregunta aunque se le pase `saveAs: false`.
  Ahora se elige una carpeta una vez (`showDirectoryPicker`, el handle va a IndexedDB) y el
  `.webm` y el `.log` se escriben ahí directamente, con el mismo nombre. Si Chrome vuelve a
  pedir acceso en otra sesión, se pide al empezar la grabación (el clic en Send/Rec es el
  gesto que hace falta). Sin carpeta, sin permiso o si falla la escritura, se descarga a
  `Downloads/webmcp-agent/` como antes: una grabación nunca se pierde por un permiso.
- Con la grabación del worker (`tabCapture`) y carpeta elegida, el worker no descarga: entrega
  la URL del blob al panel (mismo origen) y este lo escribe.

## 0.7.7

- Nuevo ajuste *Recording mode*. **Per message** es el comportamiento de siempre: un vídeo por
  mensaje, que se cierra cuando el agente responde. **Until I stop it** empieza con el primer
  mensaje y sigue a través de varios mensajes, tools y navegaciones hasta que se pulsa el botón
  *Rec* / *Stop mm:ss* de la cabecera del chat: un solo `.webm` (y un solo `.log`) para un
  recorrido completo. El botón también arranca la grabación antes de escribir nada.
- Si se cancela el selector de pestañas en modo continuo, no se vuelve a abrir en cada mensaje;
  pulsar *Rec* lo reintenta. El `.log` marca cada mensaje del usuario (`[chat] User: …`) para
  leer una grabación larga contra la conversación.
- Cerrar el panel durante una grabación del worker (`tabCapture`) la termina y la guarda; una
  grabación del selector vive en el panel y se pierde al cerrarlo, así que hay que parar antes.

## 0.7.6

- El vídeo no dejaba ver qué hacía el agente: las tools de WebMCP se ejecutan con
  `executeTool`, no con clics ni eventos de teclado, así que el cursor virtual, que escucha
  eventos del DOM, se quedaba mudo y la página parecía cambiar «por arte de magia». Con
  *Show cursor…* activado, el panel avisa a la pestaña antes y después de cada tool
  (acción `hud` por el puente existente, sin `tabs.sendMessage`) y `virtual-cursor.js` dibuja
  en la esquina superior derecha una tarjeta con el nombre y los argumentos, que pasa a ✓ o ✗
  al terminar. Hay una pausa de 300 ms para que aparezca en el vídeo antes de que cambie el DOM.
  Todo el texto va con `textContent`: nombre y argumentos vienen del modelo.
- Junto al `.webm` se guarda ahora un `.log` con el mismo nombre: errores y avisos de consola de
  la página, excepciones sin capturar, promesas rechazadas, recursos que no cargaron y una línea
  de tiempo de las tools (`[+12.3s] [tool] nombre(args) -> ok`). La captura (`page-hook.js`,
  acción `console-capture`) solo está activa mientras se graba, sobrevive a las navegaciones y
  deja `console.error/warn` como estaban al terminar.

## 0.7.5

- `AbortError: Error starting tab capture (source=desktop, id length=24)`: un id de
  `desktopCapture` solo se puede consumir en el documento que abrió el selector, y 0.7.3 lo
  abría en el panel pero lo consumía en el documento offscreen. Ahora las grabaciones que
  salen del selector se hacen en el propio panel y se descargan desde él; las de `tabCapture`
  siguen yendo por el worker y el offscreen. La lógica de `MediaRecorder` se comparte en
  `lib/recorder.js`. El worker solo gestiona el cursor del panel (`PANEL_CURSOR`).

## 0.7.4

- El error de captura llegaba al panel como «Error starting tab capture», sin decir qué
  restricción o qué id había fallado. `offscreen.js` ahora conserva el `name` y el
  `message` de la `DOMException` y añade con qué se pidió (`source`, longitud del id, fps),
  y el worker lo vuelca a Logs con `[Rec/SW]`.

## 0.7.3

- El selector de pestañas de 0.7.1 nunca llegó a mostrarse: `chooseDesktopMedia` se llamaba
  desde el service worker, que no tiene ventana a la que anclar el diálogo, y devolvía un id
  vacío al instante («Recording cancelled»). Ahora el worker intenta `tabCapture` y, si falta
  `activeTab`, responde `needsPicker`; el panel lateral —una ventana real que conserva el
  gesto del clic en Send— abre el selector y devuelve el `streamId` al worker. Cancelar el
  selector no bloquea al agente: sigue sin vídeo y lo avisa.

## 0.7.2

- El agente se paraba tras el primer paso de un flujo de varios pasos y había que escribir
  «do it» en cada uno. Tres causas, tres arreglos:
  - `SYSTEM_PROMPT`: la regla «SUCCESS → parar» no distinguía el éxito de un paso del de la
    meta. Ahora un éxito intermedio obliga a llamar a la siguiente tool en el mismo turno, y
    hay una sección «WHEN TO STOP» (todo hecho, FAILED, o falta algo que solo el usuario da).
  - `runAgentLoop`: si el mensaje del usuario es multi-paso (`isMultiStepRequest`), la
    ronda anterior tuvo éxito y la respuesta es texto sin pregunta, se empuja al modelo una
    vez más (`synthetic`, máx. 10 por turno, fuera de historial y títulos). No se activa en
    peticiones de una sola acción.
  - `settleTools()`: tras ejecutar tools se relee la lista hasta que no cambia (máx. 1,5 s),
    para que las tools de un formulario recién abierto estén antes de la siguiente ronda.

## 0.7.1

- La grabación fallaba con «Extension has not been invoked for the current page»:
  `tabCapture` exige `activeTab` sobre esa pestaña y Chrome lo retira al navegar o cambiar
  de pestaña. Ahora, si falta, se cae a `desktopCapture.chooseDesktopMedia(['tab'])` (un
  clic en Compartir, sin recargar). Cualquier otro error de `tabCapture` se sigue mostrando
  tal cual. Permiso nuevo: `desktopCapture`.

## 0.7.0

- El límite de rondas de tools (antes fijo en 6, `MAX_TOOL_STEPS`) es ahora un setting
  (Settings → Agent Limits): interruptor para quitarlo y número editable, por defecto 100.

- Grabación de vídeo de la sesión del agente (Settings → Session Recording, **desactivada
  por defecto**). `tabCapture.getMediaStreamId()` en el worker → `MediaRecorder` en un
  documento offscreen (`offscreen.js`) → `.webm` a `Downloads/webmcp-agent/` vía
  `chrome.downloads`. Empieza al enviar un mensaje y para en un `finally` al acabar el turno.
- Cursor virtual opcional (`virtual-cursor.js`, mundo ISOLATED, Shadow DOM): como las tools
  son opacas, no intercepta un dispatcher sino que reacciona a los `click`/`input`/`change`/
  `submit` que provoca la tool (ripple en clics, contorno en campos).
- Permisos nuevos: `tabCapture`, `offscreen`, `downloads`.

## 0.6.27

- Las sugerencias de prompt (`generatePromptSuggestions`) desaparecían en silencio al
  agotar el timeout de 15s, sin dejar rastro en History — reproducible con modelos locales
  lentos como Gemma. Timeout subido a 45s y el caso de timeout ahora se loguea de forma
  explícita en los dos caminos que lo tragaban: el `AbortError` de la petición a Ollama, y
  el resultado descartado en silencio en la ruta Copilot (`copilotChat()` no está cableado
  a la `signal` de abort, así que el timeout no cancelaba esa petición, solo hacía que su
  resultado se tirase al llegar).

## 0.6.26

- Vídeo del README rehecho: la URL del repo se cortaba en el rótulo de cierre
  (`GITHUB.COM/MOLIDI…`) porque el componente no admitía un título tan largo — ahora va en
  el subtítulo, entera y en minúsculas. Y el audio ya no se corta al acabar la locución.

## 0.6.25

- Vídeo de demostración (1:46, 16:9, narración en inglés) en el README, con `docs/demo.mp4`
  y su póster. Metraje real: descubrimiento de tools, `create_contact` llamada por un
  gemma local y el contacto apareciendo en la página. Las escenas de chat van aceleradas.

## 0.6.24

System prompt reescrito y "None" pasa a significar none:
- **El prompt no le decía al modelo que actuara.** De sus cuatro reglas, la única con un
  imperativo claro era la de *esperar*; nada prohibía anunciar la acción, y `be concise`
  cerraba el prompt empujando a prosa. De ahí el "ahora te lo creo" sin llamada. El nuevo
  empieza por CALL THE TOOL, prohíbe el "I will / let me", separa *preguntar por un
  parámetro obligatorio* de *pedir permiso* (que ya hace la casilla del panel), y prohíbe
  dar algo por hecho sin resultado de tool.
- Cerrados los tres hallazgos del linter de instrucciones: el `wait` de "5-15s" pasa a
  **5 → 10 → 20 y parar** (cabe en el `1..30` de la tool nativa); FAILED tiene su propia
  rama (explicar el motivo, preguntar, no reintentar con los mismos argumentos); y hay
  regla para la página **sin tools**.
- Se une con `
`: antes iba con espacios y al modelo le llegaba un párrafo corrido.
- **El catálogo de demostración se colaba con "None" seleccionado** en cualquier URL que
  llevara "webmcp" o "region=". Desde 0.6.23 esas reglas van dentro del mensaje de
  sistema, así que el apaño ya no era solo cosmético. Fuera.

## 0.6.23

El catálogo por fin llega al chat, y el proveedor deja de ser siempre Ollama:
- **Las reglas del catálogo nunca entraban en la conversación.** `activeSystemContext`
  se resolvía y solo se usaba para redactar las sugerencias: cargar un catálogo en
  Ajustes no cambiaba ni una palabra de lo que se le enviaba al modelo. Ahora
  `syncSystemMessage()` reconstruye el mensaje de sistema en cada turno con las reglas
  de la pestaña activa.
- **Y ahora se ve**: un aviso en el hilo la primera vez que las reglas cambian, y un chip
  permanente sobre el compositor (`Catalog rule active: …`) que lleva a Ajustes.
- **Con un modelo de Copilot y Ollama parado la extensión estaba muerta**: el botón de
  enviar y las sugerencias automáticas se condicionaban a `state.ollamaOk`. `providerReady()`
  pregunta al proveedor del modelo elegido.
- Cabecera del chat: un título largo se desbordaba sobre los botones. Una columna `auto`
  de grid no baja de su `min-content`, y el `min-content` de un título `nowrap` es la
  frase entera: ahora es `minmax(0, auto)`.

## 0.6.22

Chat header, conversation naming, and the catalog card telling the truth again:
- **The chat header had no CSS at all.** `.chat-header` and its children were never
  styled, so the buttons sat flush against everything and the title rendered as plain
  body text. It is now a three-slot grid — back button, centred title, new-chat button —
  with equal side columns so the title is centred whatever the buttons say, and the
  header buttons no longer borrow `.btn-small`'s red hover, which is the colour of
  destructive actions.
- **The catalog card said "No Catalog Active · 0 rules loaded" whenever the panel was
  reopened**, even with a catalog loaded and working: the badge was written inline by
  `syncCatalog()` and nothing restored it from the cache at startup. `renderCatalogStatus()`
  now derives it from what is actually loaded, and the remote sync time is persisted.
- The domain a conversation belongs to has been stored all along but was never shown.
  It is now on every thread card and under the header title.
- **Rename a conversation by double-clicking its title**, in the header or on the card.
  A chosen name is flagged `titleCustom` so the next save does not rewrite it from the
  first message.
- **✨ on each thread card asks the model to name the conversation.** Works with whichever
  provider is selected: `askModel()` is the one-shot path both this and the prompt
  suggestions use.
- **"New Chat" no longer overwrites the thread you just left.** It only cleared the
  messages while keeping `currentSessionId`, so the next message replaced the previous
  conversation instead of starting one beside it.

## 0.6.21

Fix declarative tool execution timeout & enrich contacts list UI details:
- **Fix Declarative Form Execution Timeout**: Prioritized HTML form DOM detection in `page-hook.js` `executeTool` so calling `<form toolname="...">` returns immediately instead of waiting on polyfilled/native `RegisteredTool.execute()` hanging promises (resolving "The page did not respond in time").
- **Auto-Submit & Field Populate Handling**: Enhanced `executeDeclarativeForm` to support both `toolautosubmit="true"` (submits form) and `toolautosubmit="false"` (populates fields for review), returning structured field payloads.
- **Detailed Contact Fields Display**: Updated `renderContactsList()` in `webmcp-contacts-demo.html` to display all contact properties (`fullName`, `country`, `taxId`, `postalCode`, `address`) in full detail.

## 0.6.20

Interactive Declarative/JS tool toggles, in-chat history drawer & catalog auto-resolution:
- **Interactive Declarative vs JS Tool Toggle**: Added live mode switch on `webmcp-contacts-demo.html` to toggle between JavaScript API registration (`modelContext`) and HTML Form Declarative registration (`<form toolname="...">` with `toolautosubmit="true|false"`).
- **Automatic Catalog Resolution for Demo Pages**: Ensured Knowledge Catalog prompts and regional business rules resolve automatically on demo pages even if no custom catalog is configured.
- **In-Chat History Drawer**: Added `🕒 Past Sessions` drawer and `➕ New Chat` thread manager directly inside the Chat tab header.

## 0.6.16

Instrument the Copilot turn so a missing tool call can be told apart from a
model that chose not to call one:
- Logs the model, the message count and **the number and names of the tools actually
  sent** before each request. A turn where `detectPageTools()` came back empty — a tab
  switch, an SPA navigation, the bridge reconnecting after the worker slept — sends only
  the native `wait` tool, and from the chat that is indistinguishable from the model
  ignoring the page.
- Logs `finish_reason`, the number of tool calls and the length of the text that came
  back, and dumps the raw message when the answer is empty in both.
- `extractToolCalls()` no longer requires `type: "function"` on the returned call, and
  reads Anthropic-shaped calls (`name`/`input`). The proxy translates tool definitions
  into the vendor format and back, so the discriminator is not guaranteed; a dropped call
  showed up as an empty bubble, since a tool-calling turn carries no text. Robustness,
  not a diagnosed failure.
- Sends `tool_choice: "auto"` explicitly and flattens content blocks into text.

## 0.6.18

Make Copilot tool calling actually work now that the auth does:
- **Every Copilot turn with tools was rejected** with
  `tools.0.custom.name: String should have at least 1 character`.
  `runAgent()` hands over tools already mapped through `toOllamaTool()`
  (`{ type, function: { name, parameters } }`), but `formatToolsForCopilot()` read
  `t.name` off the flat WebMCP descriptor, so every tool went out unnamed. It now
  accepts both shapes and drops anything still nameless instead of sending it.
- **Models that cannot answer on `/chat/completions` are no longer offered.** GitHub's
  `/models` lists everything the account can reach — embeddings models and newer ones
  that only answer on `/responses` — so picking one failed at send time with
  `unsupported_api_for_model`. Filtered by `capabilities.type`, `supported_endpoints`
  and `model_picker_enabled`, falling back to the raw list if that leaves nothing.
- Models that support tool calling are marked `· tools` in the picker, as Ollama's are.
- **Tool results now carry `tool_call_id`.** They only had Ollama's `tool_name`, so the
  turn *after* any tool call would have been rejected as well. `formatMessagesForCopilot()`
  also pairs an id-less result with its call by name, for conversations built for Ollama.
- Copilot API errors are unwrapped from their JSON body instead of being pasted raw, and
  `unsupported_api_for_model` says which model to change.

## 0.6.17

Fix the GitHub Copilot device flow and make the 🐞 Logs tab reachable:
- **The device flow never completed.** `POLL_COPILOT_AUTH` answered `success: true` for
  every poll, `authorization_pending` included, so the first tick — five seconds in,
  before the user had typed the code on github.com — flipped the panel to "connected"
  and stopped polling. No OAuth token was ever stored, which is why every Copilot call
  errored afterwards and the model list stayed empty. Polling now branches on an explicit
  `status` of `pending` / `success` / `error`.
- Terminal errors (`access_denied`, `expired_token`, a Copilot subscription that does not
  cover the account) stop the flow with their own message instead of a generic failure,
  and the device code deadline is honoured.
- **The 🐞 Logs tab could not be opened**: `logs` was missing from `TABS`, so `setTab()`
  fell back to the chat. Added.
- The service worker now mirrors its auth diagnostics into that tab (`BG_LOG`); the auth
  fetches run there, so half of every failure used to be invisible from the panel.
- Copilot model listing reports why it came back empty (token, library or endpoints)
  instead of silently rendering an empty picker.
- Fixed the model endpoint being built as `.../models/models`: the caller appended
  `/models` and `fetchCopilotModels` appended it again, so only the hardcoded fallbacks
  ever answered. `endpointFor()` now normalizes and is covered by tests.
- Reopening the panel with a stored GitHub token but an expired Copilot session token
  re-exchanges it instead of reporting a disconnection.

## 0.6.16

Fix Ollama rendering ReferenceError & add dedicated 🐞 Logs diagnostic tab:
- Fixed `ReferenceError: ollamaGroup is not defined` when Copilot is not connected. Local Ollama model dropdown now populates cleanly.
- Multi-header authorization fallback (`sessionToken` & `oauthToken` with `Bearer` and `token` schemas) for Copilot `/models` fetching.
- Added a dedicated **🐞 Logs** diagnostic tab in the SidePanel with live real-time console capture, 📋 Copy Logs button, and 🗑 Clear button.

## 0.6.15

Fix ReferenceError when rendering Ollama models:
- Corrected variable reference in `renderModelOptions()` when appending Ollama options to `els.modelSelect` when Copilot is not connected.

## 0.6.14

Remove hardcoded Copilot default models:
- Discarded static/hardcoded model fallbacks. The extension now relies strictly on models fetched dynamically from GitHub's `/models` API for the authenticated Copilot session.

## 0.6.13

Wire up dynamic Copilot model fetching and logging in sidepanel:
- Connected `fetchRemoteCopilotModels()` in `sidepanel.js` so Copilot models are dynamically fetched from the `/models` endpoint using the active session token upon connection or clicking 🔄 refresh.
- Added explicit `console.log` entries for `[CopilotService]` requests, HTTP response statuses, and parsed model definitions for DevTools debugging.

## 0.6.12

Expand Copilot model options & add dynamic model fetching:
- Expanded built-in Copilot models list to include `GPT-4o`, `GPT-4o Mini`, `GPT-4`, `Claude 3.5 Sonnet`, `Claude 3.7 Sonnet`, `o1`, `o1 Mini`, `o1 Preview`, `o3-mini`, and `Gemini 2.0 Flash`.
- Added dynamic model fetching from Copilot `/models` endpoint to auto-discover models enabled for the user's Copilot subscription.

## 0.6.11

Add Copilot completion header overrides and automatic multi-endpoint fallback:
- Added OpenAI organization (`Openai-Organization: github-copilot`) and intent (`Openai-Intent: conversation-panel`) headers to Copilot completions requests.
- Added automatic endpoint fallback (`api.individual.githubcopilot.com` and `api.githubcopilot.com`).

## 0.6.10

Fix GitHub Copilot token exchange error handling and connection state verification:
- Fallback header authorization check (`token <token>` vs `Bearer <token>`) during Copilot token exchange.
- Avoid wiping local storage on token errors so clear diagnostic error messages (e.g. 403 Forbidden / missing Copilot subscription) are displayed directly in the Settings UI.
- Verify both OAuth token and Copilot session token exist before declaring Connected state.

## 0.6.9

Fix Copilot OAuth Client ID to valid public VS Code Copilot Client ID (`Iv1.b507a08c87ecfe98`):
- Resolves HTTP 404 response on `POST https://github.com/login/device/code`. Device Flow authorization now connects cleanly.

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
