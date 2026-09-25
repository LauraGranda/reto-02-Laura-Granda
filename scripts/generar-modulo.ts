// Genera modulo/ (agent.md, tools/, skill/) a partir de las mismas piezas que usa la app (bonus 9.4).
// Uso en PowerShell: bun run modulo. El módulo nunca se edita a mano: se regenera con este script.
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

/** Frontmatter de agent.md: agente principal sin permisos de edición ni de shell (9.4). */
const FRONTMATTER_AGENTE = [
  "description: Agente de recepción de contratos de Periferia IT Group; procesa el buzón, registra contratos en el maestro y genera alertas.",
  "mode: primary",
  "permission:",
  "  edit: deny",
  "  bash: deny",
]

/** Frontmatter de SKILL.md: nombre y cuándo usar el conocimiento del proceso (9.4). */
const FRONTMATTER_SKILL = [
  "name: registro-contratos",
  "description: Manual del proceso de registro de contratos vigentes (clasificaciones, reglas RN1–RN7, confianza, esquema del maestro y alertas). Úsalo al procesar contratos del buzón.",
]

/** tools/contratos.ts: reexporta las herramientas de la app; no hay copia que pueda divergir. */
const TOOLS_MODULO = `// Reexportación de las herramientas de la aplicación (src/tools/contratos.ts): el módulo usa EXACTAMENTE los mismos
// objetos que la app, así nunca diverge. Generado por scripts/generar-modulo.ts; no editar a mano.
export * from "../../src/tools/contratos"
`

const README_MODULO = `# Módulo reutilizable: agente de registro de contratos

Empaqueta el agente para integrarlo en otra plataforma de agentes, sin depender del servidor de esta aplicación (PRD 9.4).
Las tres piezas son las mismas que usa la aplicación: se generan desde sus archivos fuente.

| Pieza | Qué es | Fuente |
|---|---|---|
| \`agent.md\` | Agente principal: frontmatter (descripción, \`mode: primary\`, sin permisos de edición ni de shell) + system prompt. | \`agent/prompt.md\` |
| \`tools/contratos.ts\` | Herramientas del agente. Es una reexportación, no una copia. | \`src/tools/contratos.ts\` |
| \`skill/registro-contratos/SKILL.md\` | Skill con el conocimiento del proceso (reglas, confianza, maestro, alertas). | \`src/knowledge/registro-contratos.md\` |

## Cómo integrarlo
1. Carga \`agent.md\` como agente principal.
2. Registra cada export de \`tools/contratos.ts\` como herramienta con el nombre \`contratos_<export>\` (ej. \`contratos_leer_buzon\`).
   La descripción es \`description\` y los parámetros se obtienen con \`z.toJSONSchema(z.object(args))\`.
   Para ejecutarla, llama \`execute(args, ctx)\`: devuelve siempre un JSON \`{ ok, data | error }\` y nunca lanza.
3. Agrega \`skill/registro-contratos/SKILL.md\` como skill del agente (el prompt lo cita como "registro-contratos process knowledge").

## Requisito de las herramientas
\`ctx.directory\` debe apuntar a la **raíz del proyecto**: ahí se leen \`fixtures/\` (solo lectura) y se escribe \`out/\`
(maestro, archivo de contratos, historial, alertas y log). \`ctx.sessionId\` identifica la sesión.

## Mantenimiento
El módulo se regenera con \`bun run modulo\` y **nunca se edita a mano**. Un test (\`tests/modulo.test.ts\`) falla si queda
desactualizado respecto de la aplicación.
`

/** Une un frontmatter YAML con un cuerpo que se copia tal cual, byte a byte (9.4: mismas piezas que la app). */
function conFrontmatter(lineas: string[], cuerpo: string): string {
  return `---\n${lineas.join("\n")}\n---\n${cuerpo}`
}

/** Escribe un archivo del módulo en UTF-8, creando sus carpetas, y devuelve su ruta relativa con "/". */
async function escribir(raiz: string, relativa: string[], contenido: string): Promise<string> {
  const ruta = path.join(raiz, "modulo", ...relativa)
  await mkdir(path.dirname(ruta), { recursive: true })
  await writeFile(ruta, contenido, "utf8")
  return ["modulo", ...relativa].join("/")
}

/**
 * Genera modulo/ desde las fuentes de la app (PRD 9.4): agent.md (prompt), skill (conocimiento), tools (reexportación)
 * y README. Devuelve las rutas generadas.
 */
export async function generarModulo(raiz: string): Promise<string[]> {
  const prompt = await readFile(path.join(raiz, "agent", "prompt.md"), "utf8")
  const conocimiento = await readFile(path.join(raiz, "src", "knowledge", "registro-contratos.md"), "utf8")
  return Promise.all([
    escribir(raiz, ["agent.md"], conFrontmatter(FRONTMATTER_AGENTE, prompt)),
    escribir(raiz, ["skill", "registro-contratos", "SKILL.md"], conFrontmatter(FRONTMATTER_SKILL, conocimiento)),
    escribir(raiz, ["tools", "contratos.ts"], TOOLS_MODULO),
    escribir(raiz, ["README.md"], README_MODULO),
  ])
}

if (import.meta.main) {
  const generados = await generarModulo(path.join(import.meta.dir, ".."))
  console.log(`Módulo generado:\n${generados.map((ruta) => `  - ${ruta}`).join("\n")}`)
}
