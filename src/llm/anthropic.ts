// Implementación de ProveedorLLM con @anthropic-ai/sdk (proveedor alternativo, PRD 6.1).
import Anthropic, { APIConnectionTimeoutError, APIError, APIUserAbortError } from "@anthropic-ai/sdk"
import type {
  ContentBlock,
  Message,
  MessageParam,
  RedactedThinkingBlockParam,
  TextBlockParam,
  ThinkingBlockParam,
  Tool,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from "@anthropic-ai/sdk/resources/messages"
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

/** Bloques del asistente que se reenvían tal cual (el razonamiento con firma debe volver intacto en turnos con herramientas). */
type BloqueAsistente = TextBlockParam | ThinkingBlockParam | RedactedThinkingBlockParam | ToolUseBlockParam

const TIPOS_BLOQUE_ASISTENTE = new Set(["text", "thinking", "redacted_thinking", "tool_use"])

/** Esfuerzo de Claude por esfuerzo neutral (output_config.effort); el razonamiento se cobra como tokens de salida. */
const ESFUERZO_CLAUDE: Record<Esfuerzo, "low" | "medium" | "high"> = { bajo: "low", medio: "medium", alto: "high" }

// ── Conversión de mensajes ─────────────────────────────────────────────────

/** Indica si un valor es la lista de bloques que este adaptador guarda para reenviar. */
function esListaDeBloques(valor: unknown): valor is BloqueAsistente[] {
  return Array.isArray(valor) && valor.every((b) => esObjeto(b) && typeof b.type === "string" && TIPOS_BLOQUE_ASISTENTE.has(b.type))
}

/** Id con el formato que exige Claude ([a-zA-Z0-9_-]); se aplica igual a tool_use y tool_result para que coincidan. */
function normalizarId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "sin_id"
}

/** Bloques del turno del asistente: los propios si datosProveedor es de Anthropic; si no, texto (si hay) y tool_use desde las llamadas. */
function bloquesAsistente(mensaje: Extract<MensajeConversacion, { rol: "asistente" }>): BloqueAsistente[] {
  const propios = datosPropios(mensaje.datosProveedor, "anthropic")
  if (esListaDeBloques(propios) && propios.length > 0) return propios
  const texto: BloqueAsistente[] = mensaje.texto ? [{ type: "text", text: mensaje.texto }] : []
  const llamadas: BloqueAsistente[] = mensaje.llamadas.map((llamada) => ({
    type: "tool_use",
    id: normalizarId(llamada.id),
    name: llamada.nombre,
    input: llamada.argumentos,
  }))
  const bloques = [...texto, ...llamadas]
  return bloques.length > 0 ? bloques : [{ type: "text", text: "(sin texto)" }]
}

/** Agrega un tool_result; los resultados consecutivos quedan en UN solo mensaje de usuario. */
function agregarResultado(mensajes: MessageParam[], mensaje: Extract<MensajeConversacion, { rol: "resultado_herramienta" }>): void {
  const bloque: ToolResultBlockParam = { type: "tool_result", tool_use_id: normalizarId(mensaje.idLlamada), content: mensaje.contenido }
  const ultimo = mensajes.at(-1)
  if (ultimo?.role === "user" && Array.isArray(ultimo.content) && ultimo.content.every((b) => b.type === "tool_result")) {
    ultimo.content.push(bloque)
  } else {
    mensajes.push({ role: "user", content: [bloque] })
  }
}

/** Convierte la conversación neutral a `messages` de Claude (PRD 6.1). */
export function aMensajesAnthropic(mensajes: MensajeConversacion[]): MessageParam[] {
  const resultado: MessageParam[] = []
  for (const mensaje of mensajes) {
    if (mensaje.rol === "resultado_herramienta") agregarResultado(resultado, mensaje)
    else if (mensaje.rol === "usuario") resultado.push({ role: "user", content: mensaje.texto })
    else resultado.push({ role: "assistant", content: bloquesAsistente(mensaje) })
  }
  return resultado
}

/** Herramientas con name, description e input_schema (JSON Schema de tipo objeto). */
export function aHerramientasAnthropic(herramientas: DefinicionHerramienta[]): Tool[] {
  return herramientas.map((h) => ({ name: h.nombre, description: h.descripcion, input_schema: { ...h.parametros, type: "object" } }))
}

// ── Respuesta ──────────────────────────────────────────────────────────────

/** Bloque de respuesta → bloque de parámetro reenviable; los demás tipos no se conservan. */
function aBloqueParametro(bloque: ContentBlock): BloqueAsistente | null {
  if (bloque.type === "text") return { type: "text", text: bloque.text }
  if (bloque.type === "thinking") return { type: "thinking", thinking: bloque.thinking, signature: bloque.signature }
  if (bloque.type === "redacted_thinking") return { type: "redacted_thinking", data: bloque.data }
  if (bloque.type === "tool_use") return { type: "tool_use", id: bloque.id, name: bloque.name, input: bloque.input }
  return null
}

/** tool_use → LlamadaHerramienta; argumentos que no sean objeto quedan vacíos (el backend los valida con zod). */
function aLlamada(bloque: ContentBlock): LlamadaHerramienta | null {
  if (bloque.type !== "tool_use") return null
  return { id: bloque.id, nombre: bloque.name, argumentos: esObjeto(bloque.input) ? bloque.input : {} }
}

/** Respuesta de Claude → RespuestaModelo: texto, llamadas, tokens (output_tokens ya incluye el razonamiento) y bloques propios. */
export function desdeRespuestaAnthropic(respuesta: {
  content: Message["content"]
  usage: Pick<Message["usage"], "input_tokens" | "output_tokens">
}): RespuestaModelo {
  const texto = respuesta.content.map((b) => (b.type === "text" ? b.text : "")).join("")
  const llamadas = respuesta.content.map(aLlamada).filter((l): l is LlamadaHerramienta => l !== null)
  const bloques = respuesta.content.map(aBloqueParametro).filter((b): b is BloqueAsistente => b !== null)
  return {
    texto,
    llamadas,
    uso: { tokensEntrada: respuesta.usage.input_tokens, tokensSalida: respuesta.usage.output_tokens },
    datosProveedor: { proveedor: "anthropic", datos: bloques },
  }
}

/** Error del SDK de Anthropic → ErrorProveedor sin su mensaje original (CA5, PRD 8). */
export function mapearErrorAnthropic(error: unknown): ErrorProveedor {
  if (error instanceof ErrorProveedor) return error
  const esTimeout = error instanceof APIConnectionTimeoutError || error instanceof APIUserAbortError
  return errorDesdeEstado(error instanceof APIError ? error.status : undefined, esTimeout)
}

// ── Proveedor ──────────────────────────────────────────────────────────────

/** ProveedorLLM para Claude: un reintento, timeout del SDK y esfuerzo por output_config.effort. */
export class ProveedorAnthropic implements ProveedorLLM {
  readonly nombre = "anthropic"
  readonly modelo: string
  private readonly cliente: Anthropic
  private readonly maxTokens: number
  private readonly esfuerzo: Esfuerzo

  constructor(opciones: OpcionesProveedor) {
    this.modelo = opciones.modelo
    this.maxTokens = opciones.maxTokensRespuesta
    this.esfuerzo = opciones.esfuerzo
    this.cliente = new Anthropic({ apiKey: opciones.apiKey, timeout: opciones.timeoutMs, maxRetries: 1 })
  }

  /** Envía la conversación a Claude y la devuelve en forma neutral; cualquier fallo sale como ErrorProveedor (CA5). */
  async enviar(sistema: string, mensajes: MensajeConversacion[], herramientas: DefinicionHerramienta[]): Promise<RespuestaModelo> {
    try {
      const respuesta = await this.cliente.messages.create({
        model: this.modelo,
        max_tokens: this.maxTokens,
        system: sistema,
        messages: aMensajesAnthropic(mensajes),
        ...(herramientas.length > 0 ? { tools: aHerramientasAnthropic(herramientas) } : {}),
        output_config: { effort: ESFUERZO_CLAUDE[this.esfuerzo] },
      })
      return desdeRespuestaAnthropic(respuesta)
    } catch (error) {
      throw mapearErrorAnthropic(error)
    }
  }
}
