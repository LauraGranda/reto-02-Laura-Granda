// Infraestructura común de las herramientas (6.2): tipo, validación de argumentos y ejecución segura con log.
import { z } from "zod"
import { registrarEnLog } from "./registro-log"
import type { ContextoHerramienta } from "./tipos"

const LARGO_RESUMEN_LOG = 120

/**
 * Contrato de una herramienta (6.2): una frase de descripción, argumentos como esquemas zod
 * con .describe() y execute que devuelve SIEMPRE un string JSON { ok, data | error }.
 */
export type Herramienta<Args extends z.ZodRawShape> = {
  description: string
  args: Args
  execute(args: z.infer<z.ZodObject<Args>>, ctx: ContextoHerramienta): Promise<string>
}

/**
 * Id de un mensaje del buzón ("msg-001"). El formato estricto impide ids con "..", "/" o "\",
 * así ningún argumento del modelo puede salir de la carpeta del buzón (seguridad, 8).
 */
export const esquemaMensajeId = z
  .string()
  .regex(/^msg-\d{3}$/, "mensaje_id debe tener el formato msg-NNN (ej. msg-001)")
  .describe("Id del mensaje del buzón, formato msg-NNN (ej. msg-001)")

/**
 * Valida los argumentos contra el esquema de la herramienta y lanza un error legible si no cumplen (6.2).
 * Se aplica dentro de execute para que también quede validado lo que llega desde demo.ts o tests.
 */
export function validarArgumentos<Args extends z.ZodRawShape>(forma: Args, args: unknown): z.infer<z.ZodObject<Args>> {
  const resultado = z.object(forma).safeParse(args)
  if (resultado.success) return resultado.data
  const detalle = resultado.error.issues.map((problema) => `${problema.path.join(".") || "args"}: ${problema.message}`)
  throw new Error(`Argumentos inválidos: ${detalle.join("; ")}`)
}

/** Mensaje legible de un error, sin la ruta absoluta del proyecto (no se expone en el chat ni en el log). */
function describirError(error: unknown, ctx: ContextoHerramienta): string {
  const mensaje = error instanceof Error ? error.message : String(error)
  return ctx.directory ? mensaje.replaceAll(ctx.directory, ".") : mensaje
}

/**
 * Ejecuta la lógica de una herramienta sin lanzar nunca (6.2, HU-6): devuelve JSON { ok: true, data }
 * o { ok: false, error } y deja una línea en out/log.jsonl con un resumen corto (RN7, CA4).
 */
export async function ejecutarConSeguridad<T>(
  herramienta: string,
  mensajeId: string | null,
  ctx: ContextoHerramienta,
  fn: () => Promise<{ data: T; resumen: string }>,
): Promise<string> {
  try {
    const { data, resumen } = await fn()
    const respuesta = JSON.stringify({ ok: true, data })
    await registrarEnLog(ctx, { herramienta, mensaje_id: mensajeId, ok: true, resumen: resumen.slice(0, LARGO_RESUMEN_LOG) })
    return respuesta
  } catch (error) {
    const mensaje = describirError(error, ctx)
    await registrarEnLog(ctx, { herramienta, mensaje_id: mensajeId, ok: false, resumen: mensaje.slice(0, LARGO_RESUMEN_LOG) })
    return JSON.stringify({ ok: false, error: mensaje })
  }
}
