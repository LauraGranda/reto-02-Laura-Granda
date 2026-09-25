// Implementación de ProveedorLLM con @google/genai (proveedor principal, PRD 6.1).
import { ApiError, GoogleGenAI, ThinkingLevel, type Content, type GenerateContentConfig, type GenerateContentResponse, type Part, type Tool } from "@google/genai"
import {
  ErrorProveedor,
  datosPropios,
  errorDesdeEstado,
  esObjeto,
  type DefinicionHerramienta,
  type Esfuerzo,
  type LlamadaHerramienta,
  type MensajeConversacion,
  type OpcionesProveedor,
  type ProveedorLLM,
  type RespuestaModelo,
} from "./adapter"

/** Prefijo de los modelos que aceptan thinkingConfig.thinkingLevel (Gemini 3.x). */
const PREFIJO_MODELOS_CON_NIVEL = "gemini-3"

/** Prefijo de los ids que genera el adaptador cuando Gemini no manda uno; no se reenvían a Gemini. */
const PREFIJO_ID_GENERADO = "sin-id-"

/**
 * Firma de relleno documentada por Google para llamadas a funciones que no vienen de Gemini (ej. un historial creado con
 * otro proveedor): los modelos Gemini 3.x exigen thoughtSignature en cada functionCall del turno actual.
 */
const FIRMA_SIN_VALIDAR = "skip_thought_signature_validator"

/** Nivel de pensamiento de Gemini por esfuerzo (solo modelos 3.x); el razonamiento se cobra como tokens de salida. */
const NIVEL_PENSAMIENTO: Record<Esfuerzo, ThinkingLevel> = {
  bajo: ThinkingLevel.LOW,
  medio: ThinkingLevel.MEDIUM,
  alto: ThinkingLevel.HIGH,
}

/** Claves de JSON Schema que Gemini rechaza en las declaraciones de funciones. */
const CLAVES_NO_ADMITIDAS = new Set(["$schema", "additionalProperties"])

// ── Conversión de mensajes ─────────────────────────────────────────────────

/** Indica si un valor es una lista de parts de Gemini (los datos que este adaptador guarda para reenviar). */
function esListaDeParts(valor: unknown): valor is Part[] {
  return Array.isArray(valor) && valor.every(esObjeto)
}

/** Indica si un id lo generó el adaptador (Gemini no lo conoce y no debe recibirlo). */
function esIdGenerado(id: string): boolean {
  return id.startsWith(PREFIJO_ID_GENERADO)
}

/** Resultado de herramienta como objeto `response`: el JSON si es un objeto; si no, { resultado: texto }. */
function aRespuestaFuncion(contenido: string): Record<string, unknown> {
  try {
    const valor: unknown = JSON.parse(contenido)
    return esObjeto(valor) ? valor : { resultado: contenido }
  } catch {
    return { resultado: contenido }
  }
}

/** Turno del modelo: las parts originales si son de Gemini (conserva thoughtSignature); si no, texto + functionCall. */
function contenidoAsistente(mensaje: Extract<MensajeConversacion, { rol: "asistente" }>): Content {
  const propias = datosPropios(mensaje.datosProveedor, "gemini")
  if (esListaDeParts(propias)) return { role: "model", parts: propias }
  const llamadas: Part[] = mensaje.llamadas.map((llamada) => ({
    functionCall: { ...(esIdGenerado(llamada.id) ? {} : { id: llamada.id }), name: llamada.nombre, args: llamada.argumentos },
    thoughtSignature: FIRMA_SIN_VALIDAR,
  }))
  const parts: Part[] = [...(mensaje.texto ? [{ text: mensaje.texto }] : []), ...llamadas]
  return { role: "model", parts: parts.length > 0 ? parts : [{ text: "" }] }
}

/** Agrega un functionResponse; los resultados consecutivos quedan en un solo turno de usuario. */
function agregarResultado(contenidos: Content[], mensaje: Extract<MensajeConversacion, { rol: "resultado_herramienta" }>): void {
  const id = esIdGenerado(mensaje.idLlamada) ? {} : { id: mensaje.idLlamada }
  const parte: Part = { functionResponse: { ...id, name: mensaje.nombre, response: aRespuestaFuncion(mensaje.contenido) } }
  const ultimo = contenidos.at(-1)
  if (ultimo?.role === "user" && ultimo.parts?.every((p) => p.functionResponse !== undefined)) ultimo.parts.push(parte)
  else contenidos.push({ role: "user", parts: [parte] })
}

/** Convierte la conversación neutral a `contents` de Gemini (PRD 6.1). */
export function aContenidosGemini(mensajes: MensajeConversacion[]): Content[] {
  const contenidos: Content[] = []
  for (const mensaje of mensajes) {
    if (mensaje.rol === "resultado_herramienta") agregarResultado(contenidos, mensaje)
    else if (mensaje.rol === "usuario") contenidos.push({ role: "user", parts: [{ text: mensaje.texto }] })
    else contenidos.push(contenidoAsistente(mensaje))
  }
  return contenidos
}

// ── Herramientas ───────────────────────────────────────────────────────────

/** Quita en todos los niveles las claves de JSON Schema que Gemini no admite ($schema, additionalProperties). */
export function limpiarEsquema(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(limpiarEsquema)
  if (!esObjeto(valor)) return valor
  return Object.fromEntries(
    Object.entries(valor).filter(([clave]) => !CLAVES_NO_ADMITIDAS.has(clave)).map(([clave, v]) => [clave, limpiarEsquema(v)]),
  )
}

/** Herramientas como functionDeclarations con JSON Schema directo (parametersJsonSchema), ya limpio. */
export function aHerramientasGemini(herramientas: DefinicionHerramienta[]): Tool[] {
  const declaraciones = herramientas.map((h) => ({ name: h.nombre, description: h.descripcion, parametersJsonSchema: limpiarEsquema(h.parametros) }))
  return [{ functionDeclarations: declaraciones }]
}

// ── Respuesta ──────────────────────────────────────────────────────────────

/** functionCall → LlamadaHerramienta; sin id del modelo se genera uno estable por posición y nombre. */
function aLlamada(parte: Part, indice: number): LlamadaHerramienta | null {
  const llamada = parte.functionCall
  if (!llamada) return null
  const nombre = llamada.name ?? ""
  return { id: llamada.id ?? `${PREFIJO_ID_GENERADO}${indice}-${nombre}`, nombre, argumentos: llamada.args ?? {} }
}

/**
 * Respuesta de Gemini → RespuestaModelo: texto sin los pensamientos, llamadas, tokens (los de razonamiento suman a la
 * salida porque se cobran como tal) y las parts originales para reenviarlas intactas.
 */
export function desdeRespuestaGemini(respuesta: Pick<GenerateContentResponse, "candidates" | "usageMetadata">): RespuestaModelo {
  const parts = respuesta.candidates?.[0]?.content?.parts ?? []
  const texto = parts.filter((p) => p.text !== undefined && p.thought !== true).map((p) => p.text).join("")
  const llamadas = parts.map(aLlamada).filter((llamada): llamada is LlamadaHerramienta => llamada !== null)
  const uso = respuesta.usageMetadata
  return {
    texto,
    llamadas,
    uso: { tokensEntrada: uso?.promptTokenCount ?? 0, tokensSalida: (uso?.candidatesTokenCount ?? 0) + (uso?.thoughtsTokenCount ?? 0) },
    datosProveedor: { proveedor: "gemini", datos: parts },
  }
}

/** Error del SDK de Gemini → ErrorProveedor sin su mensaje original (puede traer datos de la solicitud) (CA5, PRD 8). */
export function mapearErrorGemini(error: unknown): ErrorProveedor {
  if (error instanceof ErrorProveedor) return error
  const esTimeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
  return errorDesdeEstado(error instanceof ApiError ? error.status : undefined, esTimeout)
}

// ── Proveedor ──────────────────────────────────────────────────────────────

/** Indica si el modelo acepta thinkingLevel (solo Gemini 3.x); con otro modelo el API respondería 400. */
export function admiteNivelPensamiento(modelo: string): boolean {
  return modelo.startsWith(PREFIJO_MODELOS_CON_NIVEL)
}

/**
 * Configuración de la solicitud (PRD 8): prompt de sistema, herramientas, tope de salida, timeout total y, solo en
 * modelos Gemini 3.x, el nivel de pensamiento según el esfuerzo (el razonamiento se cobra como tokens de salida).
 */
export function configuracionGemini(
  opciones: Pick<OpcionesProveedor, "modelo" | "timeoutMs" | "maxTokensRespuesta" | "esfuerzo">,
  sistema: string,
  herramientas: DefinicionHerramienta[],
): GenerateContentConfig {
  return {
    systemInstruction: sistema,
    ...(herramientas.length > 0 ? { tools: aHerramientasGemini(herramientas) } : {}),
    maxOutputTokens: opciones.maxTokensRespuesta,
    ...(admiteNivelPensamiento(opciones.modelo) ? { thinkingConfig: { thinkingLevel: NIVEL_PENSAMIENTO[opciones.esfuerzo] } } : {}),
    abortSignal: AbortSignal.timeout(opciones.timeoutMs),
  }
}

/** ProveedorLLM para Gemini: un reintento, timeout total por AbortSignal y nivel de pensamiento si el modelo lo admite. */
export class ProveedorGemini implements ProveedorLLM {
  readonly nombre = "gemini"
  readonly modelo: string
  private readonly cliente: GoogleGenAI
  private readonly opciones: Pick<OpcionesProveedor, "modelo" | "timeoutMs" | "maxTokensRespuesta" | "esfuerzo">

  constructor(opciones: OpcionesProveedor) {
    const { apiKey, ...resto } = opciones
    this.modelo = opciones.modelo
    this.opciones = resto
    this.cliente = new GoogleGenAI({ apiKey, httpOptions: { retryOptions: { attempts: 2 } } })
    if (!admiteNivelPensamiento(opciones.modelo)) {
      console.warn(`LLM_ESFUERZO se ignora: el modelo ${opciones.modelo} no admite nivel de pensamiento (solo modelos gemini-3.x)`)
    }
  }

  /** Configuración de esta instancia para una solicitud. */
  private configuracion(sistema: string, herramientas: DefinicionHerramienta[]): GenerateContentConfig {
    return configuracionGemini(this.opciones, sistema, herramientas)
  }

  /** Envía la conversación a Gemini y la devuelve en forma neutral; cualquier fallo sale como ErrorProveedor (CA5). */
  async enviar(sistema: string, mensajes: MensajeConversacion[], herramientas: DefinicionHerramienta[]): Promise<RespuestaModelo> {
    try {
      const respuesta = await this.cliente.models.generateContent({
        model: this.modelo,
        contents: aContenidosGemini(mensajes),
        config: this.configuracion(sistema, herramientas),
      })
      return desdeRespuestaGemini(respuesta)
    } catch (error) {
      throw mapearErrorGemini(error)
    }
  }
}
