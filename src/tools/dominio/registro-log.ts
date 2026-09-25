// Escritura de out/log.jsonl con { ts, herramienta, mensaje_id, ok, resumen } (RN7).
import { appendFile, mkdir } from "node:fs/promises"
import { carpetaSalida, rutaLog } from "./rutas"
import type { ContextoHerramienta, EntradaLog } from "./tipos"

/**
 * Agrega una línea JSON a out/log.jsonl con la marca de tiempo actual (RN7, CA4).
 * Nunca lanza: un fallo del log no debe tumbar la herramienta que lo llama.
 */
export async function registrarEnLog(
  ctx: ContextoHerramienta,
  entrada: Omit<EntradaLog, "ts">,
): Promise<void> {
  try {
    const linea: EntradaLog = { ts: new Date().toISOString(), ...entrada }
    await mkdir(carpetaSalida(ctx.directory), { recursive: true })
    await appendFile(rutaLog(ctx.directory), JSON.stringify(linea) + "\n", "utf8")
  } catch (error) {
    console.error("No se pudo escribir en out/log.jsonl:", error)
  }
}
