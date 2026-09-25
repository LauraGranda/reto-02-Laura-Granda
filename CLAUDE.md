# Proyecto
Reto técnico 02 de Periferia IT Group: agente conversacional "Registro de Contratos Vigentes".
docs/PRD.md es la fuente de verdad. Si algo de este archivo contradice el PRD, gana el PRD y me avisas.

# Stack (no cambiar)
- Bun + TypeScript estricto. Un solo servidor (Bun.serve) sirve web/index.html y la API.
- zod v4 (usar z.toJSONSchema para pasar herramientas al modelo). papaparse para el CSV.
- Front: HTML + JS plano en web/index.html. Sin frameworks, sin build.
- Proveedores LLM: @anthropic-ai/sdk y @google/genai, elegidos por variable de entorno.

# Estructura (respeta los nombres del PRD 6.5; lo añadido está justificado)
agent/prompt.md                       comportamiento del agente (system prompt)
src/server.ts                         solo HTTP: rutas y wiring; delega el ciclo a src/agent/loop.ts
src/agent/loop.ts                     bucle del agente (CA1–CA5)
src/agent/sessions.ts                 sesiones en memoria
src/llm/adapter.ts                    interfaz ProveedorLLM + tipos neutrales
src/llm/anthropic.ts, src/llm/gemini.ts, src/llm/fabrica.ts
src/tools/contratos.ts                SOLO exporta herramientas; cada export → contratos_<export>
src/tools/dominio/                    lógica pura usada por las herramientas (no exporta herramientas):
  tipos.ts, reglas.ts, rutas.ts, registro-log.ts, fechas.ts, extraccion.ts, maestro.ts, clasificacion.ts
src/knowledge/registro-contratos.md   conocimiento del proceso
web/index.html                        chat
tests/                                pruebas con bun test
scripts/generar-modulo.ts             genera modulo/ (bonus)
demo.ts                               ejecuta herramientas sin modelo
docs/PRD.md, docs/supuestos.md        PRD original y supuestos para SOLUCION.md

# Reglas de código (obligatorias)
- Prohibido `any`. Tipos derivados de esquemas zod con z.infer.
- Nombres en español, descriptivos: tipos en PascalCase (ContratoExtraido), funciones con verbo (extraerValor), constantes en MAYUSCULAS (UMBRAL_CONFIANZA).
- Cada función exportada lleva JSDoc de 1–3 líneas: qué hace y POR QUÉ (qué regla del PRD cumple, ej. "Cumple RN1").
- Funciones cortas (idealmente < 30 líneas).
- Herramientas: { description: una frase, args: objeto de esquemas zod con .describe() en CADA campo, execute(args, ctx) }.
  execute devuelve SIEMPRE string JSON { ok: true, data } o { ok: false, error }. NUNCA lanza (try/catch interno).
- Rutas siempre relativas a ctx.directory. Nunca rutas absolutas. Nunca comandos de shell.
- fixtures/ es SOLO LECTURA. Todo lo generado va en out/.
- Cada herramienta escribe en out/log.jsonl: { ts, herramienta, mensaje_id, ok, resumen }.
- Fechas: trabajar con strings YYYY-MM-DD y aritmética manual; nunca new Date("YYYY-MM-DD") con zona local.
- La clave del modelo solo se lee de process.env en el backend. Nunca se loguea ni se devuelve.

# Resultados esperados de los 6 mensajes (tests deben verificarlos)
msg-001: nuevo. id CT-2026-015, cliente Industrias Delta S.A.S., nit 890900111 (el del CONTRATANTE, no el de Periferia 900123456), CO, valor 265000000 COP, 2026-08-01 → 2027-07-31, requiere_poliza true, tipo "cumplimiento", estado "pendiente".
msg-002: nuevo. id CT-2026-016, Corporación Andina de Servicios S.A., 1790012345001, EC, valor 120000 USD (formato "120,000.00"), 2026-08-15 → 2027-08-14, sin póliza → "no_aplica".
msg-003: actualizacion de CT-2026-011 (otrosí). Cambia fecha_fin 2027-05-01→2027-11-01 y valor 350000→520000 PEN. NO tocar fecha_inicio ("2 de mayo" es la fecha de suscripción original). estado_poliza pasa a "pendiente" porque el otrosí exige ampliar garantías. requiere_revision vacío. Historial con los cambios.
msg-004: duplicado de CT-2026-012 (mismo id, valor 210000000, 2026-05-15, 2026-11-14). Sin escritura en el maestro.
msg-005: rechazado, motivo "el adjunto es una cotización, no un contrato".
msg-006: nuevo. id CM-2026-03, Distribuidora Caribe S.A.S., 800222333, CO, valor 0 con valor_indeterminado true (confianza 0.5), moneda COP, fecha_inicio 2026-08-31 (firma sin día → fecha del correo, confianza 0.8), fecha_fin 2027-08-31 (derivada de 12 meses, confianza 0.6), requiere_poliza true (póliza condicional, se registra conservadoramente como "pendiente"), tipo "cumplimiento". requiere_revision = [valor, fecha_fin]. Remitente jperez@ no está en comerciales.json: se reporta, no bloquea.

# Alertas con hoy = 2026-09-03 (límite 60 días = 2026-11-02)
Vencen ≤ 60 días: CT-2026-009 (2026-09-30), CT-2026-004 (2026-10-15). No CT-2026-012 (2026-11-14).
Ya vencidos (sección informativa extra): CT-2025-018, CT-2026-002.
Pólizas no vigentes: CT-2026-004, CT-2026-011, CT-2026-015, CM-2026-03.
Registrados desde el corte 2026-05-30: CT-2026-015, CT-2026-016, CM-2026-03.

# Forma de trabajar
- Una fase a la vez. Al terminar, dime qué archivos creaste y cómo verificarlo. No avances solo a la siguiente fase.
- Si algo del PRD es ambiguo, propón una opción, dímela y anótala en docs/supuestos.md para la sección "Supuestos" de SOLUCION.md.
- Nunca hagas commits ni push: los hago yo.

# Compatibilidad Windows (desarrollo) / Linux (despliegue)
- Desarrollo en Windows con PowerShell; despliegue en Linux (Railway). El código debe funcionar igual en ambos.
- Rutas SIEMPRE con path.join / path.resolve de "node:path". Nunca concatenar con "/" o "\".
- Al leer cualquier archivo de texto, normalizar saltos de línea: texto.replace(/\r\n/g, "\n") ANTES de aplicar regex.
- Leer archivos siempre como UTF-8 (hay tildes y ñ en los fixtures).
- Si me das comandos de terminal, dámelos para PowerShell.
- Variables de entorno locales en .env (Bun lo carga solo); nunca usar "export" de bash.