// Lectura del buzón simulado: mensajes, correo.json y adjuntos (HU-1, 7.1). Solo lectura sobre fixtures/.
import { readdir } from "node:fs/promises"
import path from "node:path"
import { existeArchivo, leerTextoUtf8 } from "./archivos"
import { extraerContrato, motivoNoEsContrato } from "./extraccion"
import { leerProcesados } from "./maestro"
import { carpetaBuzon, carpetaMensaje } from "./rutas"
import {
  esquemaCorreo,
  type ContextoHerramienta,
  type ContratoExtraido,
  type Correo,
  type MensajeBuzon,
  type ResultadoHerramienta,
} from "./tipos"

/** Adjunto ya leído: nombre del archivo y su texto. */
export type AdjuntoLeido = { nombre: string; texto: string }

/** Resultado de revisar los adjuntos de un correo: el contrato encontrado o el motivo de rechazo (RN4). */
export type EvaluacionAdjuntos = { adjunto: AdjuntoLeido; motivo: null } | { adjunto: null; motivo: string }

/** Nombre de archivo simple, sin separadores ni "..": evita salir de la carpeta del mensaje (seguridad). */
function esNombreSimple(nombre: string): boolean {
  return nombre !== "" && !nombre.includes("..") && !/[\\/]/.test(nombre) && path.basename(nombre) === nombre
}

/** Ids de los mensajes del buzón (subcarpetas de fixtures/reto-02/buzon), ordenados (HU-1). */
export async function listarIdsMensajes(ctx: ContextoHerramienta): Promise<string[]> {
  try {
    const entradas = await readdir(carpetaBuzon(ctx.directory), { withFileTypes: true })
    return entradas.filter((entrada) => entrada.isDirectory()).map((entrada) => entrada.name).sort()
  } catch {
    throw new Error("No se encontró la carpeta del buzón (fixtures/reto-02/buzon)")
  }
}

/** Lee y valida el correo.json de un mensaje (7.1); mensaje inexistente o mal formado → error legible (HU-6). */
export async function leerCorreo(ctx: ContextoHerramienta, mensajeId: string): Promise<Correo> {
  const ruta = path.join(carpetaMensaje(ctx.directory, mensajeId), "correo.json")
  if (!esNombreSimple(mensajeId) || !(await existeArchivo(ruta))) {
    throw new Error(`El mensaje ${mensajeId} no existe en el buzón`)
  }
  let datos: unknown
  try {
    datos = JSON.parse(await leerTextoUtf8(ruta))
  } catch {
    throw new Error(`El correo.json de ${mensajeId} no es un JSON válido`)
  }
  const resultado = esquemaCorreo.safeParse(datos)
  if (resultado.success) return resultado.data
  const problema = resultado.error.issues[0]
  throw new Error(`El correo.json de ${mensajeId} no tiene el formato esperado: ${problema?.path.join(".")} ${problema?.message}`)
}

/** Texto UTF-8 de un adjunto con saltos \n; rechaza nombres que intenten salir de la carpeta del mensaje. */
export async function leerAdjunto(ctx: ContextoHerramienta, mensajeId: string, nombre: string): Promise<string> {
  if (!esNombreSimple(nombre)) throw new Error(`El adjunto "${nombre}" tiene un nombre no permitido`)
  try {
    return await leerTextoUtf8(path.join(carpetaMensaje(ctx.directory, mensajeId), nombre))
  } catch {
    throw new Error(`No se pudo leer el adjunto ${nombre}`)
  }
}

/** Indica si un texto es un contrato u otrosí; usa la misma regla que la extracción (RN4, regla A). */
export function esDocumentoContrato(texto: string): boolean {
  return motivoNoEsContrato(texto) === null
}

/** Lee un adjunto y dice si es contrato; si no, devuelve el motivo legible. */
async function revisarAdjunto(ctx: ContextoHerramienta, mensajeId: string, nombre: string): Promise<EvaluacionAdjuntos> {
  try {
    const texto = await leerAdjunto(ctx, mensajeId, nombre)
    const motivo = motivoNoEsContrato(texto)
    return motivo === null ? { adjunto: { nombre, texto }, motivo: null } : { adjunto: null, motivo: `El adjunto ${nombre} ${motivo}` }
  } catch (error) {
    return { adjunto: null, motivo: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Busca el primer adjunto que sea contrato u otrosí (HU-1). Si ninguno lo es, explica por qué:
 * sin adjuntos, un adjunto que no es contrato, o varios sin contrato (RN4).
 */
export async function evaluarAdjuntos(ctx: ContextoHerramienta, mensajeId: string, correo: Correo): Promise<EvaluacionAdjuntos> {
  if (correo.adjuntos.length === 0) return { adjunto: null, motivo: "El correo no trae adjuntos" }
  const motivos: string[] = []
  for (const nombre of correo.adjuntos) {
    const revision = await revisarAdjunto(ctx, mensajeId, nombre)
    if (revision.adjunto !== null) return revision
    motivos.push(revision.motivo)
  }
  const motivo = motivos.length === 1 ? (motivos[0] ?? "") : `Ningún adjunto es un contrato: ${motivos.join("; ")}`
  return { adjunto: null, motivo }
}

/**
 * Extrae el contrato adjunto a un mensaje (HU-2): busca el adjunto de contrato y aplica extraerContrato con la fecha
 * del correo. Única ruta de extracción: la usan contratos_extraer y contratos_validar (re-extracción, CA2).
 */
export async function extraerContratoDelMensaje(
  ctx: ContextoHerramienta,
  mensajeId: string,
  correo: Correo,
): Promise<ResultadoHerramienta<{ adjunto: string; contrato: ContratoExtraido }>> {
  const evaluacion = await evaluarAdjuntos(ctx, mensajeId, correo)
  if (evaluacion.adjunto === null) return { ok: false, error: evaluacion.motivo }
  const resultado = extraerContrato(evaluacion.adjunto.texto, { fecha: correo.fecha.slice(0, 10) })
  if (!resultado.ok) return resultado
  return { ok: true, data: { adjunto: evaluacion.adjunto.nombre, contrato: resultado.data } }
}

/** Primer adjunto del correo cuyo contenido es un contrato, o null (HU-1). */
export async function identificarAdjuntoContrato(
  ctx: ContextoHerramienta,
  mensajeId: string,
  correo: Correo,
): Promise<AdjuntoLeido | null> {
  return (await evaluarAdjuntos(ctx, mensajeId, correo)).adjunto
}

/**
 * Resumen de un mensaje para contratos_leer_buzon (HU-1). Sin contrato → clasificación previa "rechazado"
 * con motivo (RN4). Un correo.json roto no detiene el lote: se reporta igual como rechazado (HU-6).
 */
export async function resumirMensaje(ctx: ContextoHerramienta, mensajeId: string): Promise<MensajeBuzon> {
  try {
    const correo = await leerCorreo(ctx, mensajeId)
    const { adjunto, motivo } = await evaluarAdjuntos(ctx, mensajeId, correo)
    const base = { id: mensajeId, de: correo.de, asunto: correo.asunto, fecha: correo.fecha, adjuntos: correo.adjuntos }
    if (adjunto) return { ...base, tiene_contrato: true, clasificacion_previa: null, motivo: null }
    return { ...base, tiene_contrato: false, clasificacion_previa: "rechazado", motivo }
  } catch (error) {
    const motivo = error instanceof Error ? error.message : String(error)
    return { id: mensajeId, de: "", asunto: "", fecha: "", adjuntos: [], tiene_contrato: false, clasificacion_previa: "rechazado", motivo }
  }
}

/** Mensajes del buzón que aún no están en out/procesados.json, resumidos y en orden (HU-1). */
export async function listarMensajesPendientes(ctx: ContextoHerramienta): Promise<MensajeBuzon[]> {
  const [ids, procesados] = await Promise.all([listarIdsMensajes(ctx), leerProcesados(ctx)])
  const pendientes = ids.filter((id) => !(id in procesados))
  return Promise.all(pendientes.map((id) => resumirMensaje(ctx, id)))
}
