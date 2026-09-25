// Bucle del agente: prompt → modelo → herramientas → respuesta, con tope de iteraciones y confirmación (CA1–CA5).
import { ErrorProveedor, type LlamadaHerramienta, type ProveedorLLM } from "../llm/adapter"
import { registrarEnLog } from "../tools/dominio/registro-log"
import type { ContextoHerramienta } from "../tools/dominio/tipos"
import { buscarHerramienta, leerResultado, obtenerDefiniciones, resumirResultado } from "./herramientas"
import { leerLimites, motivoSinPresupuesto, registrarUso, type Limites } from "./presupuesto"
import type { LlamadaVisible, Sesion } from "./sessions"

/** Lo que el ciclo necesita del exterior; se inyecta para probar sin red (6.1). */
export type Dependencias = { proveedor: ProveedorLLM; sistema: string; ctx: ContextoHerramienta; limites?: Limites }

/** Respuesta de un turno para POST /api/chat (6.4). */
export type RespuestaTurno = { reply: string; toolCalls: LlamadaVisible[]; needsConfirmation: boolean; proveedor: string }

/** Estado de un turno en curso. */
type EstadoTurno = {
  sesion: Sesion
  deps: Dependencias
  limites: Limites
  pendientesAlInicio: ReadonlySet<string>
  llamadas: LlamadaVisible[]
  iteraciones: number
  tokens: { entrada: number; salida: number }
}

const MENSAJE_BLOQUEO = "Requiere confirmación explícita de la analista en un turno posterior"
const MENSAJE_INESPERADO = "Ocurrió un error inesperado; la sesión sigue activa, intenta de nuevo."

// ── Entrada y presupuesto ──────────────────────────────────────────────────

/** Rechazo previo al modelo (PRD 8): mensaje vacío, demasiado largo o sin presupuesto. null si se puede continuar. */
function validarEntrada(sesion: Sesion, texto: string, limites: Limites): string | null {
  if (texto.trim() === "") return "Escribe un mensaje para empezar."
  if (texto.length > limites.maxCaracteresMensaje) {
    return `El mensaje es demasiado largo (máximo ${limites.maxCaracteresMensaje} caracteres). Resúmelo e intenta de nuevo.`
  }
  return motivoSinPresupuesto(sesion, limites)
}

// ── Herramientas ───────────────────────────────────────────────────────────

/** Respuesta de error en el formato de las herramientas (6.2). */
function errorHerramienta(error: string): string {
  return JSON.stringify({ ok: false, error })
}

/**
 * CA3: confirmado=true en contratos_registrar solo vale para un mensaje que quedó pendiente en un turno ANTERIOR
 * (así el "sí" vino de la analista y no del propio modelo en el mismo turno).
 */
function esConfirmacionNoAutorizada(llamada: LlamadaHerramienta, pendientesAlInicio: ReadonlySet<string>): boolean {
  const { confirmado, mensaje_id: mensajeId } = llamada.argumentos
  if (llamada.nombre !== "contratos_registrar" || confirmado !== true) return false
  return typeof mensajeId !== "string" || !pendientesAlInicio.has(mensajeId)
}

/**
 * CA4: una llamada que no llega a ejecutarse (herramienta inexistente, argumentos inválidos o bloqueada por CA3)
 * también queda en out/log.jsonl, con el mensaje_id si viene y el motivo.
 */
async function anotarRechazo(estado: EstadoTurno, llamada: LlamadaHerramienta, motivo: string): Promise<void> {
  const mensajeId = typeof llamada.argumentos.mensaje_id === "string" ? llamada.argumentos.mensaje_id : null
  await registrarEnLog(estado.deps.ctx, { herramienta: llamada.nombre, mensaje_id: mensajeId, ok: false, resumen: motivo.slice(0, 120) })
}

/** Ejecuta una llamada: herramienta inexistente, argumentos inválidos, guarda CA3 o ejecución; nunca lanza (CA5). */
async function ejecutarLlamada(estado: EstadoTurno, llamada: LlamadaHerramienta): Promise<{ contenido: string; bloqueada: boolean }> {
  const herramienta = buscarHerramienta(llamada.nombre)
  if (!herramienta) {
    const error = `La herramienta ${llamada.nombre} no existe`
    await anotarRechazo(estado, llamada, error)
    return { contenido: errorHerramienta(error), bloqueada: false }
  }
  const errorArgumentos = herramienta.validar(llamada.argumentos)
  if (errorArgumentos) {
    await anotarRechazo(estado, llamada, errorArgumentos)
    return { contenido: errorHerramienta(errorArgumentos), bloqueada: false }
  }
  if (esConfirmacionNoAutorizada(llamada, estado.pendientesAlInicio)) {
    await anotarRechazo(estado, llamada, `bloqueada: ${MENSAJE_BLOQUEO}`)
    return { contenido: errorHerramienta(MENSAJE_BLOQUEO), bloqueada: true }
  }
  try {
    return { contenido: await herramienta.ejecutar(llamada.argumentos, estado.deps.ctx), bloqueada: false }
  } catch {
    return { contenido: errorHerramienta(`La herramienta ${llamada.nombre} falló inesperadamente`), bloqueada: false }
  }
}

/** Campos de "requiere revisión: a, b" en un error de contratos_registrar. */
function camposDeError(error: string): string[] | null {
  const prefijo = "requiere revisión:"
  return error.startsWith(prefijo) ? error.slice(prefijo.length).split(",").map((c) => c.trim()).filter(Boolean) : null
}

/**
 * Mantiene los pendientes de confirmación (CA3): validar/registrar con campos en revisión → pendiente;
 * registrar o descartar exitosos → el mensaje ya no está pendiente.
 */
function actualizarPendientes(sesion: Sesion, llamada: LlamadaHerramienta, contenido: string): void {
  const mensajeId = llamada.argumentos.mensaje_id
  if (typeof mensajeId !== "string") return
  const resultado = leerResultado(contenido)
  if (!resultado.ok) {
    const campos = llamada.nombre === "contratos_registrar" ? camposDeError(resultado.error) : null
    if (campos) sesion.pendientes.set(mensajeId, campos)
    return
  }
  const revision = resultado.data.requiere_revision
  if (llamada.nombre === "contratos_validar" && Array.isArray(revision) && revision.length > 0) {
    sesion.pendientes.set(mensajeId, revision.map(String))
  }
  if (llamada.nombre === "contratos_registrar" || llamada.nombre === "contratos_descartar") sesion.pendientes.delete(mensajeId)
}

/** Ejecuta en paralelo las llamadas pedidas (el candado protege las escrituras) y agrega resultados en el orden pedido (CA4). */
async function ejecutarLlamadas(estado: EstadoTurno, llamadas: LlamadaHerramienta[]): Promise<void> {
  const resultados = await Promise.all(llamadas.map((llamada) => ejecutarLlamada(estado, llamada)))
  llamadas.forEach((llamada, indice) => {
    const { contenido, bloqueada } = resultados[indice] ?? { contenido: errorHerramienta("Sin resultado"), bloqueada: false }
    estado.sesion.mensajes.push({ rol: "resultado_herramienta", idLlamada: llamada.id, nombre: llamada.nombre, contenido })
    const visible: LlamadaVisible = { nombre: llamada.nombre, argumentos: llamada.argumentos, ok: leerResultado(contenido).ok, resumen: resumirResultado(llamada.nombre, contenido) }
    estado.llamadas.push(bloqueada ? { ...visible, bloqueada: true } : visible)
    actualizarPendientes(estado.sesion, llamada, contenido)
  })
}

// ── Modelo ─────────────────────────────────────────────────────────────────

/** Una iteración (CA1): llama al modelo, cuenta tokens (PRD 8) y agrega su mensaje al historial. */
async function llamarModelo(estado: EstadoTurno): Promise<LlamadaHerramienta[] | string> {
  const { proveedor, sistema } = estado.deps
  const respuesta = await proveedor.enviar(sistema, estado.sesion.mensajes, obtenerDefiniciones())
  estado.iteraciones++
  estado.tokens.entrada += respuesta.uso.tokensEntrada
  estado.tokens.salida += respuesta.uso.tokensSalida
  registrarUso(estado.sesion, respuesta.uso)
  const datos = respuesta.datosProveedor ? { datosProveedor: respuesta.datosProveedor } : {}
  estado.sesion.mensajes.push({ rol: "asistente", texto: respuesta.texto, llamadas: respuesta.llamadas, ...datos })
  return respuesta.llamadas.length > 0 ? respuesta.llamadas : respuesta.texto || "(El modelo no devolvió texto.)"
}

/** Lista legible de lo que se hizo en el turno (para el tope y los errores). */
function resumenHecho(estado: EstadoTurno): string {
  return estado.llamadas.map((l) => `${l.nombre} → ${l.resumen}`).join("; ") || "nada todavía"
}

/** Cierra el turno con un mensaje del asistente propio, sin llamar al modelo, para mantener la alternancia de roles. */
function cerrarSinModelo(estado: EstadoTurno, texto: string): string {
  estado.sesion.mensajes.push({ rol: "asistente", texto, llamadas: [] })
  return texto
}

/** CA1: respuesta determinista al llegar al tope de iteraciones, con lo hecho y lo que falta; sin llamada extra al modelo. */
function respuestaTope(estado: EstadoTurno): string {
  const texto = `Alcancé el límite de pasos de este turno. Hice: ${resumenHecho(estado)}. Falta: continuar con los mensajes pendientes; escríbeme 'continúa'.`
  return cerrarSinModelo(estado, texto)
}

/** Bucle modelo → herramientas hasta la respuesta final, el tope de iteraciones (CA1) o el fin del presupuesto (PRD 8). */
async function cicloDelModelo(estado: EstadoTurno): Promise<string> {
  while (estado.iteraciones < estado.limites.maxIteraciones) {
    const resultado = await llamarModelo(estado)
    if (typeof resultado === "string") return resultado
    await ejecutarLlamadas(estado, resultado)
    const sinPresupuesto = motivoSinPresupuesto(estado.sesion, estado.limites)
    if (sinPresupuesto) return cerrarSinModelo(estado, `Hice: ${resumenHecho(estado)}. ${sinPresupuesto}`)
  }
  return respuestaTope(estado)
}

// ── Errores y cierre ───────────────────────────────────────────────────────

/**
 * CA5: el error se muestra claro y la sesión sigue viva. Sin herramientas ejecutadas → se deshace el turno;
 * con herramientas ya ejecutadas → se conserva lo hecho y se cierra con "(Turno interrumpido: …)".
 */
function manejarError(estado: EstadoTurno, error: unknown, posicion: number): string {
  const mensaje = error instanceof ErrorProveedor ? error.message : MENSAJE_INESPERADO
  if (!(error instanceof ErrorProveedor)) console.error(`[turno ${estado.sesion.id}] error inesperado: ${error instanceof Error ? error.name : "desconocido"}`)
  if (estado.llamadas.length === 0) {
    estado.sesion.mensajes.length = posicion
    return mensaje
  }
  cerrarSinModelo(estado, `(Turno interrumpido: ${mensaje})`)
  return `Hice: ${resumenHecho(estado)}. No pude terminar el turno: ${mensaje}`
}

/**
 * Registra el turno en el historial visible (6.1) y en consola (sin contenido de mensajes) y arma la respuesta (6.4).
 * El mensaje de la analista lleva la hora en que se recibió; la respuesta, la hora en que terminó el turno.
 */
function cerrarTurno(estado: EstadoTurno, textoUsuario: string, recibido: string, reply: string): RespuestaTurno {
  const { sesion, deps } = estado
  const needsConfirmation = sesion.pendientes.size > 0
  const proveedor = deps.proveedor.nombre
  sesion.historialVisible.push({ rol: "usuario", texto: textoUsuario, ts: recibido })
  sesion.historialVisible.push({ rol: "asistente", texto: reply, toolCalls: estado.llamadas, needsConfirmation, proveedor, ts: new Date().toISOString() })
  console.log(`[turno] sesion=${sesion.id} proveedor=${proveedor} iteraciones=${estado.iteraciones} tokens_entrada=${estado.tokens.entrada} tokens_salida=${estado.tokens.salida}`)
  return { reply, toolCalls: estado.llamadas, needsConfirmation, proveedor }
}

/**
 * Ejecuta un turno completo del agente (6.3): valida la entrada y el presupuesto, corre el ciclo modelo → herramientas
 * con tope (CA1), guarda de confirmación (CA3), traza de llamadas (CA4) y errores claros sin matar la sesión (CA5).
 */
export async function ejecutarTurno(sesion: Sesion, textoUsuario: string, deps: Dependencias): Promise<RespuestaTurno> {
  const recibido = new Date().toISOString()
  const limites = deps.limites ?? leerLimites()
  const estado: EstadoTurno = {
    sesion, deps, limites, pendientesAlInicio: new Set(sesion.pendientes.keys()), llamadas: [], iteraciones: 0, tokens: { entrada: 0, salida: 0 },
  }
  const rechazo = validarEntrada(sesion, textoUsuario, limites)
  if (rechazo) return cerrarTurno(estado, textoUsuario, recibido, rechazo)
  const posicion = sesion.mensajes.length
  sesion.mensajes.push({ rol: "usuario", texto: textoUsuario })
  let reply: string
  try {
    reply = await cicloDelModelo(estado)
  } catch (error) {
    reply = manejarError(estado, error, posicion)
  }
  return cerrarTurno(estado, textoUsuario, recibido, reply)
}
