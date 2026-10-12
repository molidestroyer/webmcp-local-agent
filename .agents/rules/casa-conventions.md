---
trigger: always_on
description: "House conventions: language, commits, secrets, Engram memory protocol"
---

<!-- MANAGED BY CASAADMINDOCK: Presets, rules and skills are centrally managed and synced from CasaAdminDock. -->

# Convenciones comunes (todos los modos)

## Engram (memoria persistente vía MCP)
- Al empezar una tarea: `mem_context` y `mem_search` con el tema (arquitectura, Auth0, DI, componente, despliegue...) antes de cualquier cambio estructural. Si una decisión previa contradice lo que vas a hacer, avísalo antes de seguir.
- Tras cada decisión, bug arreglado, gotcha o convención nueva: `mem_save` con formato **What / Why / Where / Learned** y un `title` corto y buscable.
- El `CLAUDE.md` del repo es la fuente de verdad del proyecto: léelo primero y actualízalo cuando cambien comandos, estructura o workflow.

## Comunicación
- Responde en español; código, nombres técnicos y commits en inglés.
- Directo y conciso: comandos copy-paste, tablas para comparativas, gotchas como causa → solución.

## Git
- Conventional commits: `feat|fix|refactor|test|docs|chore|migration(scope): descripción`. Las decisiones de arquitectura se explican en el cuerpo del commit.
- Los tests existentes deben pasar antes de dar algo por terminado.
- No crear `.md` de notas de progreso ni resúmenes de sesión.

## Seguridad
- Credenciales en user-secrets, `.env` o variables de entorno; nunca commiteadas ni logueadas (PATs y tokens incluidos). Ningún secreto con valor por defecto en el código.
- No exponer emails ni datos personales en UI pública.
- En proyectos multiidioma, todo string visible en **todos** los idiomas soportados.

## MCPs de Proyecto y Aplicaciones
- Cada repositorio cuenta con un archivo estándar `.mcp.json` en su raíz que define los servidores MCP locales del proyecto y el servidor universal `engram`.
- Claude Code y Antigravity (Gemini) consumen estos MCPs en cada conversación por defecto.
- Los servidores MCP comunes (ej. `engram`, `jsontovideo`, MCPs de administración) se sincronizan centralizadamente desde CasaAdminDock.

## Continuidad entre Agentes e Intercambio de IAs (Cross-Agent Handover & Plan)
- **Objetivo**: Permitir alternar de IA fluidamente (de Claude a Gemini o viceversa) cuando se agote la cuota o cambie de agente, sin perder contexto ni obligar al usuario a repetir la tarea.
- **Archivo Canónico Único**: `.agents/handoff.md` en la raíz del repositorio.
- **Arranque de Sesión / Reanudación Automática**:
  - Al iniciar cualquier conversación, el agente (Claude o Gemini) DEBE comprobar si existe `.agents/handoff.md`.
  - Si `.agents/handoff.md` existe y su estado es `IN_PROGRESS`:
    1. Lee el archivo silenciosamente.
    2. Saluda brevemente confirmando que continúa la tarea del agente anterior: *"Reanudando tarea: [Título]. Paso actual: [Siguiente paso]. Continuando..."*
    3. Ejecuta directamente el siguiente paso sin pedir explicaciones ni contexto al usuario.
- **Traspaso de Turno / Fin de Cuota / Comando `/handoff`**:
  - Cuando se agote la cuota, el usuario pida cambio de IA, o se haga un traspaso entre agentes, el agente saliente DEBE actualizar `.agents/handoff.md` con:
    - **Status**: `IN_PROGRESS`
    - **Task & Goal**: Qué se está haciendo y el objetivo final.
    - **From**: Nombre del agente saliente y modelo.
    - **Progress**: Tareas completadas `[x]` y tareas pendientes `[ ]`.
    - **Exact Next Step**: La acción inmediata exacta que debe ejecutar el siguiente agente.
    - **Active Files & Context**: Archivos modificados o clave.
    - **Gotchas / Blockers**: Hallazgos o bloqueos críticos.
  - Guardar también en Engram: `mem_save(topic_key="handover/<repo>", type="pattern", ...)`.
- **Cierre de Tarea**:
  - Al terminar el trabajo al 100%, marca `Status: COMPLETED` en `.agents/handoff.md` o límpialo. No crear archivos `.md` dispersos de notas de sesión.

## Gestión Centralizada de Presets, Skills y Rules (CasaAdminDock)
- Las reglas de la casa, presets de agente, MCPs y skills se gestionan y distribuyen centralizadamente desde **CasaAdminDock** (`CasaAdminDock/presets/` y Presets Explorer).
- Si creas o actualizas una skill, subagente, MCP o regla común, debe registrarse en los presets del Dock para que se sincronice automáticamente con Claude Code, Antigravity y todos los repositorios en `C:\repos`. No las dupliques manualmente en carpetas locales sueltas.

