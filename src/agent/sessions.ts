// Sesiones de chat en memoria (6.1: memoria o archivo): historial del modelo, historial visible y consumo de tokens.
import { z } from "zod"
import type { MensajeConversacion } from "../llm/adapter"

/** Llamada a herramienta tal como la ve la analista en el chat (6.1, CA4). */
export type LlamadaVisible = {
  nombre: string
  argumentos: Record<string, unknown>
  ok: boolean
  resumen: string
  bloqueada?: boolean
}

/** Entrada del historial visible: nunca incluye datosProveedor ni el prompt de sistema (6.4). */
export type EntradaVisible = {
  rol: "usuario" | "asistente"
  texto: string
  toolCalls?: LlamadaVisible[]
  needsConfirmation?: boolean
  proveedor?: string
  ts: string
}

/**
 * Sesión de chat: `mensajes` es lo que ve el modelo; `historialVisible` lo que ve la analista;
 * `pendientes` = mensajes del buzón que esperan confirmación humana y sus campos (CA3).
 */
export type Sesion = {
  id: string
  mensajes: MensajeConversacion[]
  historialVisible: EntradaVisible[]
  tokensUsados: number
  pendientes: Map<string, string[]>
  turnoEnCurso: boolean
}

/** sessionId válido: 1–100 caracteres [A-Za-z0-9-] (evita ids arbitrarios en memoria y en logs). */
export const esquemaSessionId = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,100}$/, "sessionId debe tener entre 1 y 100 caracteres (letras, números o guiones)")

const sesiones = new Map<string, Sesion>()

/** Devuelve la sesión con ese id o crea una vacía (6.1). */
export function obtenerOCrearSesion(id: string): Sesion {
  const existente = sesiones.get(id)
  if (existente) return existente
  const nueva: Sesion = { id, mensajes: [], historialVisible: [], tokensUsados: 0, pendientes: new Map(), turnoEnCurso: false }
  sesiones.set(id, nueva)
  return nueva
}

/** Devuelve la sesión si existe (GET /api/sessions/:id, 6.4). */
export function obtenerSesion(id: string): Sesion | undefined {
  return sesiones.get(id)
}

/** Borra todas las sesiones (POST /api/reset). */
export function borrarTodasLasSesiones(): void {
  sesiones.clear()
}
