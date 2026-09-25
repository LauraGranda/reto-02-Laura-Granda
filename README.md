# Registro de Contratos Vigentes · Agente conversacional

Agente que actúa como punto único de recepción de contratos: lee el buzón, extrae los datos de cada contrato con su nivel de confianza, detecta duplicados y actualizaciones, pide confirmación humana para los datos dudosos, alimenta el maestro y genera alertas para gerencia.

Reto técnico 02 · Periferia IT Group. **Los datos son ficticios.**

**Link público:** https://reto-02-laura-granda-production.up.railway.app/

La explicación de la solución, las decisiones y los riesgos está en [SOLUCION.md](SOLUCION.md).

---

## Cómo probarlo en el link

1. Pulsa **Reiniciar demo** para dejar el buzón con sus 6 correos.
2. Elige la sugerencia **"Procesa el buzón…"** o escribe tu propia instrucción.
3. Debajo de cada respuesta, abre **🔧** para ver las herramientas que usó el agente.
4. Cuando aparezca el aviso amarillo, confirma o corrige los valores.
5. Pide las alertas indicando la fecha, por ejemplo: *Muéstrame las alertas con fecha 2026-09-03.*

---

## Levantar en local

Requisito: [Bun](https://bun.sh).

```bash
bun install && bun run dev
```

En PowerShell: `bun install; bun run dev`. Luego abre `http://localhost:3000`.

Antes, copia `.env.example` a `.env` y completa al menos el proveedor, el modelo y su clave.

---

## Variables de entorno

| Variable | Obligatoria | Para qué sirve | Ejemplo |
|---|---|---|---|
| `LLM_PROVIDER` | Sí | Proveedor del modelo: `gemini` o `anthropic` | `gemini` |
| `LLM_MODEL` | Sí | Modelo del proveedor | `gemini-3.8-flash` |
| `GEMINI_API_KEY` | Si usas Gemini | Clave de Google AI Studio | — |
| `ANTHROPIC_API_KEY` | Si usas Anthropic | Clave de Anthropic | — |
| `LLM_ESFUERZO` | No | Razonamiento del modelo: `bajo`, `medio`, `alto` | `bajo` |
| `LLM_MAX_TOKENS_RESPUESTA` | No | Máximo de tokens por respuesta del modelo | `2048` |
| `LLM_TIMEOUT_MS` | No | Espera máxima al proveedor (ms) | `60000` |
| `MAX_ITERATIONS` | No | Llamadas al modelo por turno (CA1) | `25` |
| `MAX_TOKENS_SESSION` | No | Tope de tokens por conversación | `300000` |
| `MAX_TOKENS_DIA` | No | Tope global de tokens por día | `2000000` |
| `MAX_CARACTERES_MENSAJE` | No | Largo máximo del mensaje de la analista | `2000` |
| `PRECIO_ENTRADA_MTOK` | No | Precio de entrada del modelo (USD por millón de tokens), para estimar el costo con `bun run probar-llm` | `0.75` |
| `PRECIO_SALIDA_MTOK` | No | Precio de salida del modelo (USD por millón de tokens), para `bun run probar-llm` | `3.75` |
| `PORT` | No | Puerto local (en Railway lo asigna la plataforma) | `3000` |

Las claves solo se leen en el backend. Nunca aparecen en el repositorio, el front, los logs ni las respuestas de la API.

**Cambiar de proveedor:** modifica `LLM_PROVIDER` y `LLM_MODEL` (por ejemplo `anthropic` y `claude-sonnet-5`) y reinicia. El ciclo del agente no cambia.

**Costo:** el servidor registra en consola los tokens de entrada y de salida de cada turno. Una conversación completa (buzón + confirmación) cuesta unos USD 0,12 con Gemini 3.8 Flash y unos USD 0,56 con Claude Sonnet 5; el detalle está en la sección 4 de [SOLUCION.md](SOLUCION.md).

---

## Demo sin modelo y tests

```bash
bun run demo.ts   # procesa los 6 mensajes llamando las herramientas directamente, sin clave
bun test          # tests automatizados (usan un modelo simulado; sin red ni claves)
bun run typecheck # verificación de tipos
```

La demo borra `out/` al inicio, muestra la clasificación y la acción de cada mensaje, registra el msg-006 en una segunda llamada con confirmación, genera las alertas y se autoverifica. Dos ejecuciones seguidas producen la misma salida.

---

## API

| Método | Ruta | Entrada | Salida |
|---|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` | `{ reply, toolCalls[], needsConfirmation, proveedor }` |
| `GET` | `/api/sessions/:id` | — | Historial visible de la sesión |
| `GET` | `/api/health` | — | `{ ok, provider, model }` (sin claves) |
| `POST` | `/api/reset` | — | Borra `out/` y las sesiones para repetir la demo |

---

## Despliegue

Desplegado en **Railway** desde la rama `main`:

- Comando de arranque: `bun run start`. Healthcheck: `/api/health`.
- Variables: las de la tabla anterior, configuradas en Railway (nunca en el repositorio).
- **Una sola réplica**: las sesiones y el candado de escritura viven en memoria.
- Sin suspensión por inactividad, para no perder las sesiones abiertas.

---

## Estructura

```
agent/prompt.md                     comportamiento del agente (system prompt)
src/server.ts                       API HTTP
src/agent/                          ciclo del agente, sesiones, presupuesto de tokens
src/llm/                            adaptador de proveedor (Gemini, Anthropic) y fábrica
src/tools/contratos.ts              herramientas del agente (contratos_<export>)
src/tools/dominio/                  lógica pura: extracción, clasificación, maestro, alertas
src/knowledge/registro-contratos.md conocimiento del proceso
web/                                front de chat
fixtures/reto-02/                   datos entregados (solo lectura)
out/                                generado en ejecución (no se versiona)
tests/                              tests automatizados
modulo/                             agente empaquetado para otras plataformas
scripts/                            generador del módulo y prueba manual del proveedor
docs/                               PRD y supuestos
demo.ts                             demo sin modelo
```

---

## Módulo reutilizable

`modulo/` empaqueta el agente para integrarlo en otras plataformas: `agent.md` (prompt), `tools/contratos.ts` (las mismas herramientas, reexportadas) y `skill/registro-contratos/SKILL.md` (conocimiento). Se regenera con `bun run modulo` y nunca se edita a mano; un test falla si diverge de la aplicación.