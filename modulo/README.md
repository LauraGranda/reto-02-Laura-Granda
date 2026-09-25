# Módulo reutilizable: agente de registro de contratos

Empaqueta el agente para integrarlo en otra plataforma de agentes, sin depender del servidor de esta aplicación (PRD 9.4).
Las tres piezas son las mismas que usa la aplicación: se generan desde sus archivos fuente.

| Pieza | Qué es | Fuente |
|---|---|---|
| `agent.md` | Agente principal: frontmatter (descripción, `mode: primary`, sin permisos de edición ni de shell) + system prompt. | `agent/prompt.md` |
| `tools/contratos.ts` | Herramientas del agente. Es una reexportación, no una copia. | `src/tools/contratos.ts` |
| `skill/registro-contratos/SKILL.md` | Skill con el conocimiento del proceso (reglas, confianza, maestro, alertas). | `src/knowledge/registro-contratos.md` |

## Cómo integrarlo
1. Carga `agent.md` como agente principal.
2. Registra cada export de `tools/contratos.ts` como herramienta con el nombre `contratos_<export>` (ej. `contratos_leer_buzon`).
   La descripción es `description` y los parámetros se obtienen con `z.toJSONSchema(z.object(args))`.
   Para ejecutarla, llama `execute(args, ctx)`: devuelve siempre un JSON `{ ok, data | error }` y nunca lanza.
3. Agrega `skill/registro-contratos/SKILL.md` como skill del agente (el prompt lo cita como "registro-contratos process knowledge").

## Requisito de las herramientas
`ctx.directory` debe apuntar a la **raíz del proyecto**: ahí se leen `fixtures/` (solo lectura) y se escribe `out/`
(maestro, archivo de contratos, historial, alertas y log). `ctx.sessionId` identifica la sesión.

## Mantenimiento
El módulo se regenera con `bun run modulo` y **nunca se edita a mano**. Un test (`tests/modulo.test.ts`) falla si queda
desactualizado respecto de la aplicación.
