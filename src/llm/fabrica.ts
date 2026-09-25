// Fábrica que elige el proveedor LLM según LLM_PROVIDER / LLM_MODEL (PRD 6.1). Único archivo que importa los adaptadores.
import { ErrorProveedor, type Esfuerzo, type OpcionesProveedor, type ProveedorLLM } from "./adapter"
import { ProveedorAnthropic } from "./anthropic"
import { ProveedorGemini } from "./gemini"

/** Variables de entorno como las entrega process.env; se inyectan para probar sin tocar el entorno real. */
export type Entorno = Record<string, string | undefined>

const PROVEEDORES = ["gemini", "anthropic"] as const
type NombreProveedor = (typeof PROVEEDORES)[number]

/** Variable con la clave de cada proveedor; la clave solo se lee aquí, en el backend (PRD 8). */
const VARIABLE_CLAVE: Record<NombreProveedor, string> = { gemini: "GEMINI_API_KEY", anthropic: "ANTHROPIC_API_KEY" }

const ESFUERZOS: readonly Esfuerzo[] = ["bajo", "medio", "alto"]
const SIN_CONFIGURAR = "sin_configurar"

/** Error de configuración que nombra la variable, nunca su valor. */
function errorConfiguracion(detalle: string): ErrorProveedor {
  return new ErrorProveedor("configuracion", detalle)
}

/** Valor no vacío de una variable obligatoria. */
function requerida(env: Entorno, nombre: string): string {
  const valor = env[nombre]?.trim()
  if (!valor) throw errorConfiguracion(`Falta la variable de entorno ${nombre}`)
  return valor
}

/** Entero positivo de una variable opcional, con valor por defecto (PRD 8: timeout y tope de salida configurables). */
function enteroPositivo(env: Entorno, nombre: string, porDefecto: number): number {
  const texto = env[nombre]?.trim()
  if (!texto) return porDefecto
  const valor = Number(texto)
  if (!Number.isInteger(valor) || valor <= 0) throw errorConfiguracion(`${nombre} debe ser un número entero positivo`)
  return valor
}

/** Proveedor válido de LLM_PROVIDER. */
function leerProveedor(env: Entorno): NombreProveedor {
  const valor = requerida(env, "LLM_PROVIDER").toLowerCase()
  const proveedor = PROVEEDORES.find((nombre) => nombre === valor)
  if (!proveedor) throw errorConfiguracion(`LLM_PROVIDER debe ser "gemini" o "anthropic"`)
  return proveedor
}

/** Esfuerzo de razonamiento de LLM_ESFUERZO (bajo por defecto: orquestar herramientas no necesita más). */
function leerEsfuerzo(env: Entorno): Esfuerzo {
  const valor = env.LLM_ESFUERZO?.trim().toLowerCase() || "bajo"
  const esfuerzo = ESFUERZOS.find((nombre) => nombre === valor)
  if (!esfuerzo) throw errorConfiguracion(`LLM_ESFUERZO debe ser "bajo", "medio" o "alto"`)
  return esfuerzo
}

/** Lee y valida toda la configuración del proveedor desde el entorno (PRD 8: timeout, tope de salida, esfuerzo). */
export function leerOpciones(env: Entorno = process.env): { proveedor: NombreProveedor; opciones: OpcionesProveedor } {
  const proveedor = leerProveedor(env)
  const opciones: OpcionesProveedor = {
    modelo: requerida(env, "LLM_MODEL"),
    apiKey: requerida(env, VARIABLE_CLAVE[proveedor]),
    timeoutMs: enteroPositivo(env, "LLM_TIMEOUT_MS", 60_000),
    maxTokensRespuesta: enteroPositivo(env, "LLM_MAX_TOKENS_RESPUESTA", 2048),
    esfuerzo: leerEsfuerzo(env),
  }
  return { proveedor, opciones }
}

/** Crea el proveedor configurado; si falta algo, ErrorProveedor("configuracion") con el nombre de la variable (CA5). */
export function crearProveedor(env: Entorno = process.env): ProveedorLLM {
  const { proveedor, opciones } = leerOpciones(env)
  return proveedor === "gemini" ? new ProveedorGemini(opciones) : new ProveedorAnthropic(opciones)
}

/** Proveedor y modelo para /api/health (6.4) sin leer claves; "sin_configurar" si faltan o no son válidos. */
export function describirProveedor(env: Entorno = process.env): { provider: string; model: string } {
  const proveedor = env.LLM_PROVIDER?.trim().toLowerCase() ?? ""
  const valido = PROVEEDORES.some((nombre) => nombre === proveedor)
  return { provider: valido ? proveedor : SIN_CONFIGURAR, model: env.LLM_MODEL?.trim() || SIN_CONFIGURAR }
}
