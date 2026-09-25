// Control de costo (PRD 8): tope de iteraciones por turno, de tokens por sesión y de tokens por día, configurables.
import { fechaHoyISO } from "../tools/dominio/fechas"
import type { Sesion } from "./sessions"

/** Límites del ciclo; se leen del entorno y se pueden inyectar en tests. */
export type Limites = {
  maxIteraciones: number
  maxCaracteresMensaje: number
  maxTokensSesion: number
  maxTokensDia: number
}

type Entorno = Record<string, string | undefined>

const POR_DEFECTO: Limites = { maxIteraciones: 25, maxCaracteresMensaje: 4000, maxTokensSesion: 300_000, maxTokensDia: 2_000_000 }

/** Contador global del día, en memoria: se reinicia al cambiar de día (y al reiniciar el servidor). */
let contadorDia = { dia: "", tokens: 0 }

/** Entero positivo de una variable; si falta o no es válido, el valor por defecto. */
function entero(env: Entorno, nombre: string, porDefecto: number): number {
  const valor = Number(env[nombre])
  return Number.isInteger(valor) && valor > 0 ? valor : porDefecto
}

/** Lee los límites del entorno (MAX_ITERATIONS, MAX_CARACTERES_MENSAJE, MAX_TOKENS_SESSION, MAX_TOKENS_DIA) (PRD 8, CA1). */
export function leerLimites(env: Entorno = process.env): Limites {
  return {
    maxIteraciones: entero(env, "MAX_ITERATIONS", POR_DEFECTO.maxIteraciones),
    maxCaracteresMensaje: entero(env, "MAX_CARACTERES_MENSAJE", POR_DEFECTO.maxCaracteresMensaje),
    maxTokensSesion: entero(env, "MAX_TOKENS_SESSION", POR_DEFECTO.maxTokensSesion),
    maxTokensDia: entero(env, "MAX_TOKENS_DIA", POR_DEFECTO.maxTokensDia),
  }
}

/** Contador del día actual; si cambió la fecha, empieza en cero. */
function contadorDeHoy(): { dia: string; tokens: number } {
  const hoy = fechaHoyISO()
  if (contadorDia.dia !== hoy) contadorDia = { dia: hoy, tokens: 0 }
  return contadorDia
}

/** Motivo legible si ya no se puede gastar (tope de la sesión o del día, PRD 8); null si hay presupuesto. */
export function motivoSinPresupuesto(sesion: Sesion, limites: Limites): string | null {
  if (sesion.tokensUsados >= limites.maxTokensSesion) return "Se alcanzó el límite de uso de esta sesión. Abre una sesión nueva."
  if (contadorDeHoy().tokens >= limites.maxTokensDia) return "Se alcanzó el límite de uso del día. Intenta mañana."
  return null
}

/** Indica si la sesión y el día aún tienen presupuesto de tokens (PRD 8: un usuario no puede gastar la clave sin límite). */
export function puedeGastar(sesion: Sesion, limites: Limites): boolean {
  return motivoSinPresupuesto(sesion, limites) === null
}

/** Suma el uso de una respuesta del modelo a la sesión y al contador del día (PRD 8). */
export function registrarUso(sesion: Sesion, uso: { tokensEntrada: number; tokensSalida: number }): void {
  const total = uso.tokensEntrada + uso.tokensSalida
  sesion.tokensUsados += total
  contadorDeHoy().tokens += total
}

/** Reinicia el contador global del día (solo para tests). */
export function reiniciarContadorDiario(): void {
  contadorDia = { dia: "", tokens: 0 }
}
