// Proveedor LLM simulado para tests: devuelve respuestas guionadas y cuenta llamadas (sin red ni claves).
import type { LlamadaHerramienta, MensajeConversacion, ProveedorLLM, RespuestaModelo } from "../src/llm/adapter"

/** Un paso del guion: recibe la conversación y devuelve la respuesta (o lanza para simular un error del proveedor). */
export type Paso = (mensajes: MensajeConversacion[]) => RespuestaModelo | Promise<RespuestaModelo>

let contadorIds = 0

/** Respuesta con llamadas a herramientas [nombre, argumentos]. */
export function pedir(...llamadas: [string, Record<string, unknown>][]): RespuestaModelo {
  const lista: LlamadaHerramienta[] = llamadas.map(([nombre, argumentos]) => ({ id: `sim-${++contadorIds}`, nombre, argumentos }))
  return { texto: "", llamadas: lista, uso: { tokensEntrada: 10, tokensSalida: 5 } }
}

/** Respuesta final de texto, sin llamadas. */
export function texto(contenido: string): RespuestaModelo {
  return { texto: contenido, llamadas: [], uso: { tokensEntrada: 10, tokensSalida: 5 } }
}

/** Contrato devuelto por la última llamada exitosa a contratos_extraer (como lo pasaría el modelo). */
export function ultimoContrato(mensajes: MensajeConversacion[]): unknown {
  const resultado = [...mensajes].reverse().find((m) => m.rol === "resultado_herramienta" && m.nombre === "contratos_extraer")
  if (!resultado || resultado.rol !== "resultado_herramienta") throw new Error("no hay resultado de contratos_extraer")
  const json: unknown = JSON.parse(resultado.contenido)
  if (typeof json === "object" && json !== null && "data" in json && typeof json.data === "object" && json.data !== null && "contrato" in json.data) {
    return json.data.contrato
  }
  throw new Error("el resultado de contratos_extraer no trae contrato")
}

/** Proveedor que sigue un guion; al acabarse usa `porDefecto` (o responde un texto fijo). */
export class ProveedorSimulado implements ProveedorLLM {
  readonly nombre = "simulado"
  readonly modelo = "guion"
  llamadas = 0
  private indice = 0

  constructor(
    private readonly pasos: Paso[],
    private readonly porDefecto?: Paso,
  ) {}

  /** Devuelve el siguiente paso del guion (6.1: misma interfaz que un proveedor real). */
  async enviar(_sistema: string, mensajes: MensajeConversacion[]): Promise<RespuestaModelo> {
    this.llamadas++
    const paso = this.pasos[this.indice++] ?? this.porDefecto
    return paso ? paso(mensajes) : texto("(fin del guion)")
  }
}
