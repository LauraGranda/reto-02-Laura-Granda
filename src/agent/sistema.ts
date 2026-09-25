// Prompt de sistema = comportamiento (agent/prompt.md) + conocimiento del proceso (src/knowledge/), unidos al arrancar (PRD 6.5).
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

const SEPARADOR = "\n\n# Process knowledge\n\n"

/**
 * Lee agent/prompt.md y src/knowledge/registro-contratos.md y los une (6.1: prompt en archivo aparte; 6.5: separación
 * comportamiento/conocimiento). Si falta alguno, lanza un error que dice cuál: el servidor no debe arrancar sin ellos.
 */
export function construirSistema(raiz: string): string {
  const archivos = [path.join("agent", "prompt.md"), path.join("src", "knowledge", "registro-contratos.md")]
  const faltantes = archivos.filter((relativo) => !existsSync(path.join(raiz, relativo)))
  if (faltantes.length > 0) throw new Error(`Falta ${faltantes.join(" y ")}; el servidor no puede arrancar sin el prompt y el conocimiento`)
  const [prompt = "", conocimiento = ""] = archivos.map((relativo) => readFileSync(path.join(raiz, relativo), "utf8").replace(/\r\n/g, "\n").trim())
  return `${prompt}${SEPARADOR}${conocimiento}`
}
