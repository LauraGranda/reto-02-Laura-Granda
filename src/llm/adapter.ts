// Interfaz ProveedorLLM (enviar(mensajes, herramientas) → respuesta) y tipos neutrales entre proveedores (PRD 6.1).
// No importa ningún SDK: el ciclo del agente solo conoce estos tipos, así cambiar de proveedor no lo toca.

/** Llamada a herramienta pedida por el modelo, en forma neutral. */
export type LlamadaHerramienta = { id: string; nombre: string; argumentos: Record<string, unknown> }

/** Proveedores con adaptador; identifican al dueño de datosProveedor. */
export type NombreProveedor = "gemini" | "anthropic"

/**
 * Datos opacos que un adaptador exige reenviar tal cual (ej. las parts de Gemini con thoughtSignature o los bloques
 * thinking de Claude), marcados con su dueño: cada adaptador solo reenvía los suyos. El ciclo del agente nunca los lee.
 */
export type DatosProveedor = { proveedor: NombreProveedor; datos: unknown }

/** Mensaje de la conversación en forma neutral (PRD 6.1). */
export type MensajeConversacion =
  | { rol: "usuario"; texto: string }
  | { rol: "asistente"; texto: string; llamadas: LlamadaHerramienta[]; datosProveedor?: DatosProveedor }
  | { rol: "resultado_herramienta"; idLlamada: string; nombre: string; contenido: string }

/** Herramienta que ve el modelo: nombre "contratos_<export>", descripción y parámetros en JSON Schema (6.2). */
export type DefinicionHerramienta = { nombre: string; descripcion: string; parametros: Record<string, unknown> }

/** Respuesta del modelo en forma neutral, con el uso de tokens para el tope por sesión (PRD 8, costo). */
export type RespuestaModelo = {
  texto: string
  llamadas: LlamadaHerramienta[]
  uso: { tokensEntrada: number; tokensSalida: number }
  datosProveedor?: DatosProveedor
}

/**
 * Datos propios de un proveedor: los devuelve solo si datosProveedor es suyo; si es de otro (o no hay), undefined,
 * y el adaptador construye el mensaje desde texto y llamadas. Así se puede cambiar de proveedor entre turnos.
 */
export function datosPropios(datosProveedor: DatosProveedor | undefined, proveedor: NombreProveedor): unknown {
  return datosProveedor?.proveedor === proveedor ? datosProveedor.datos : undefined
}

/** Adaptador de proveedor (PRD 6.1): una implementación por proveedor, elegida por variable de entorno. */
export interface ProveedorLLM {
  readonly nombre: string
  readonly modelo: string
  enviar(sistema: string, mensajes: MensajeConversacion[], herramientas: DefinicionHerramienta[]): Promise<RespuestaModelo>
}

/** Esfuerzo de razonamiento configurable (se cobra como tokens de salida; para orquestar herramientas basta "bajo"). */
export type Esfuerzo = "bajo" | "medio" | "alto"

/** Opciones ya validadas que la fábrica entrega a cada adaptador; los adaptadores no leen el entorno. */
export type OpcionesProveedor = {
  apiKey: string
  modelo: string
  timeoutMs: number
  maxTokensRespuesta: number
  esfuerzo: Esfuerzo
}

// ── Errores ────────────────────────────────────────────────────────────────

/** Tipos de error del proveedor que el chat muestra en lenguaje claro (CA5). */
export type TipoErrorProveedor =
  | "autenticacion"
  | "limite_uso"
  | "tiempo_agotado"
  | "solicitud_invalida"
  | "configuracion"
  | "otro"

/** Mensajes en español para la analista; nunca incluyen clave, headers ni el cuerpo del error original (PRD 8). */
const MENSAJES_ERROR: Record<TipoErrorProveedor, string> = {
  autenticacion: "El proveedor rechazó la clave de API; revisa la configuración del servidor",
  limite_uso: "Se alcanzó el límite de uso del proveedor; intenta en unos minutos",
  tiempo_agotado: "El modelo no respondió a tiempo; intenta de nuevo",
  solicitud_invalida: "El proveedor rechazó la solicitud; revisa el modelo configurado",
  configuracion: "Falta configurar el proveedor de IA en el servidor",
  otro: "El proveedor de IA no está disponible en este momento",
}

/**
 * Error del proveedor con un tipo y un mensaje legible (CA5). El mensaje sale de una tabla fija o de un detalle
 * construido por el propio código (ej. el nombre de la variable que falta), nunca del error del SDK.
 */
export class ErrorProveedor extends Error {
  readonly tipo: TipoErrorProveedor
  readonly status: number | undefined

  constructor(tipo: TipoErrorProveedor, detalle?: string, status?: number) {
    super(detalle ?? MENSAJES_ERROR[tipo])
    this.name = "ErrorProveedor"
    this.tipo = tipo
    this.status = status
  }
}

/**
 * Traduce un código HTTP o un timeout a ErrorProveedor (CA5): 401/403 autenticación, 429 límite de uso,
 * 400/404 solicitud inválida (404 = modelo inexistente), timeout tiempo agotado; el resto, "otro".
 */
export function errorDesdeEstado(status: number | undefined, esTimeout: boolean): ErrorProveedor {
  if (esTimeout) return new ErrorProveedor("tiempo_agotado")
  if (status === 401 || status === 403) return new ErrorProveedor("autenticacion", undefined, status)
  if (status === 429) return new ErrorProveedor("limite_uso", undefined, status)
  if (status === 404) return new ErrorProveedor("solicitud_invalida", "El modelo configurado no existe o no está disponible", status)
  if (status === 400) return new ErrorProveedor("solicitud_invalida", undefined, status)
  return new ErrorProveedor("otro", undefined, status)
}

/** Indica si un valor es un objeto plano (no null ni arreglo); sirve para validar argumentos que llegan del modelo. */
export function esObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === "object" && valor !== null && !Array.isArray(valor)
}
