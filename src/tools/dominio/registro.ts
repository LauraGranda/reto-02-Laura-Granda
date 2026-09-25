// Escritura del registro (HU-4): maestro sin corrupción ni duplicados (O2), archivo del documento, historial y procesados.
import { constants } from "node:fs"
import { copyFile, mkdir, readdir } from "node:fs/promises"
import path from "node:path"
import { esNombreSimple } from "./archivos"
import { fechaHoyISO } from "./fechas"
import { agregarHistorial, crearSlugCliente, escribirMaestro, leerProcesados, marcarProcesado } from "./maestro"
import { LARGO_MAXIMO_OBJETO } from "./reglas"
import { carpetaContratosSharepoint, carpetaMensaje } from "./rutas"
import {
  esquemaFilaMaestro,
  type AccionRegistro,
  type Clasificacion,
  type ContextoHerramienta,
  type ContratoExtraido,
  type Diferencias,
  type EntradaHistorial,
  type FilaMaestro,
  type ResultadoValidacion,
} from "./tipos"
import { validarMensaje, type MensajeValidado } from "./validacion"

/** Lo que devuelve contratos_registrar (6.2): id, acción, ruta del archivo archivado y clasificación. */
export type ResultadoRegistro = {
  id_contrato: string
  accion: AccionRegistro
  ruta_archivo: string | null
  clasificacion: Clasificacion
}

type Escritura = Omit<ResultadoRegistro, "clasificacion">
type Comercial = ResultadoValidacion["comercial"]

/** Columnas de una fila nueva que deben venir del contrato: el maestro no las admite vacías (7.2). */
const CAMPOS_OBLIGATORIOS = [
  "cliente", "nit_cliente", "pais", "valor", "moneda", "fecha_inicio", "fecha_fin", "requiere_poliza",
] as const satisfies readonly (keyof ContratoExtraido)[]

// ── Maestro ────────────────────────────────────────────────────────────────

/**
 * Escribe el maestro solo si cada fila cumple el esquema 7.2 y no hay id_contrato repetido (O2: cero duplicados).
 * La escritura es atómica (temporal + renombrar), así un fallo no deja el CSV corrupto.
 */
export async function escribirMaestroSeguro(ctx: ContextoHerramienta, filas: FilaMaestro[]): Promise<void> {
  const ids = new Set<string>()
  for (const fila of filas) {
    const resultado = esquemaFilaMaestro.safeParse(fila)
    if (!resultado.success) throw new Error(`Fila inválida para ${fila.id_contrato}: ${resultado.error.issues[0]?.message}`)
    if (ids.has(fila.id_contrato)) throw new Error(`El maestro quedaría con ${fila.id_contrato} repetido; no se escribe`)
    ids.add(fila.id_contrato)
  }
  await escribirMaestro(ctx, filas)
}

/** Id para un contrato sin número (7.2): "AUTO-<año>-<NNN>" con el siguiente número libre de ese año. */
export function generarIdAuto(filas: FilaMaestro[], anio: string): string {
  const patron = new RegExp(`^AUTO-${anio}-(\\d+)$`)
  const mayor = filas.reduce((maximo, fila) => {
    const coincidencia = patron.exec(fila.id_contrato)
    return coincidencia ? Math.max(maximo, Number(coincidencia[1])) : maximo
  }, 0)
  return `AUTO-${anio}-${String(mayor + 1).padStart(3, "0")}`
}

/**
 * Fila nueva con las 16 columnas de 7.2: póliza → estado "pendiente", sin póliza → "no_aplica" y tipo "";
 * comercial resuelto o, si no está registrado, el email del remitente (HU-3); fuente "buzon".
 */
export function construirFilaNueva(contrato: ContratoExtraido, comercial: Comercial, rutaSharepoint: string, hoy: string): FilaMaestro {
  const requiere = contrato.requiere_poliza.valor === true
  return esquemaFilaMaestro.parse({
    id_contrato: contrato.id_contrato.valor,
    cliente: contrato.cliente.valor,
    nit_cliente: contrato.nit_cliente.valor,
    pais: contrato.pais.valor,
    objeto: (contrato.objeto.valor ?? "").slice(0, LARGO_MAXIMO_OBJETO),
    valor: contrato.valor.valor,
    moneda: contrato.moneda.valor,
    fecha_inicio: contrato.fecha_inicio.valor,
    fecha_fin: contrato.fecha_fin.valor,
    requiere_poliza: requiere,
    tipo_poliza: requiere ? (contrato.tipo_poliza.valor ?? "") : "",
    estado_poliza: requiere ? "pendiente" : "no_aplica",
    comercial: comercial.nombre ?? comercial.email,
    ruta_sharepoint: rutaSharepoint,
    fecha_registro: hoy,
    fuente: "buzon",
  })
}

/** Convierte el texto de una diferencia al tipo de su columna (valor numérico, requiere_poliza booleano). */
function convertirColumna(campo: string, texto: string): string | number | boolean {
  if (campo === "valor") return Number(texto)
  if (campo === "requiere_poliza") return texto === "true"
  return texto
}

/** Fila nueva con SOLO los campos de `diferencias` cambiados (incluido estado_poliza); el resto intacto (RN2). */
export function aplicarDiferencias(fila: FilaMaestro, diferencias: Diferencias): FilaMaestro {
  const cambios = Object.entries(diferencias).map(([campo, { despues }]) => [campo, convertirColumna(campo, despues)])
  return esquemaFilaMaestro.parse({ ...fila, ...Object.fromEntries(cambios) })
}

// ── Archivo del documento ──────────────────────────────────────────────────

/**
 * Copia el adjunto a out/sharepoint/Contratos/<anio>/<slug>/<nombre> sin sobrescribir nunca (HU-4) y devuelve
 * la ruta relativa a out/sharepoint con "/" como en el maestro. Rechaza nombres que salgan de la carpeta.
 */
export async function archivarDocumento(
  ctx: ContextoHerramienta,
  origen: string,
  anio: string,
  slugCliente: string,
  nombreArchivo: string,
): Promise<string> {
  for (const parte of [anio, slugCliente, nombreArchivo]) {
    if (!esNombreSimple(parte)) throw new Error(`Nombre no permitido para archivar: "${parte}"`)
  }
  const relativa = ["Contratos", anio, slugCliente, nombreArchivo].join("/")
  const carpeta = path.join(carpetaContratosSharepoint(ctx.directory), anio, slugCliente)
  await mkdir(carpeta, { recursive: true })
  try {
    await copyFile(origen, path.join(carpeta, nombreArchivo), constants.COPYFILE_EXCL)
  } catch (error) {
    const existe = error instanceof Error && "code" in error && error.code === "EEXIST"
    throw new Error(existe ? `Ya existe ${relativa}; no se sobrescribe` : `No se pudo archivar ${nombreArchivo}`)
  }
  return relativa
}

/** Escapa un texto para usarlo literal dentro de una RegExp. */
function escaparRegex(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** "<id>-<etiqueta>-<n><ext>" con n = el mayor existente en la carpeta + 1: un otrosí nunca pisa a otro (HU-4). */
export async function nombreArchivoVersion(carpeta: string, id: string, etiqueta: "otrosi" | "actualizacion", ext: string): Promise<string> {
  const existentes = await readdir(carpeta).catch(() => [])
  const patron = new RegExp(`^${escaparRegex(id)}-${etiqueta}-(\\d+)\\.`)
  const mayor = existentes.reduce((maximo, nombre) => Math.max(maximo, Number(patron.exec(nombre)?.[1] ?? 0)), 0)
  return `${id}-${etiqueta}-${mayor + 1}${ext}`
}

// ── Registro ───────────────────────────────────────────────────────────────

/** Campos obligatorios de una fila nueva que siguen vacíos aunque haya confirmación (7.2). */
export function faltantesObligatorios(contrato: ContratoExtraido): string[] {
  return CAMPOS_OBLIGATORIOS.filter((campo) => contrato[campo].valor === null)
}

/**
 * Entrada de historial (HU-4). Si hubo confirmación humana de algo (campos en revisión o valores corregidos),
 * agrega confirmado_por "usuario", los campos confirmados y cada corrección { extraido, final } (CA3, supuestos).
 */
function entradaHistorial(
  base: Omit<EntradaHistorial, "ts">,
  validado: MensajeValidado,
  confirmado: boolean,
): Omit<EntradaHistorial, "ts"> {
  const revision = validado.resultado.requiere_revision
  const hayQueConfirmar = revision.length > 0 || Object.keys(validado.correcciones).length > 0
  if (!confirmado || !hayQueConfirmar) return base
  return { ...base, confirmado_por: "usuario", campos_confirmados: revision, correcciones: validado.correcciones }
}

/** Ruta del adjunto dentro del buzón, para copiarlo al archivo. */
function rutaAdjunto(ctx: ContextoHerramienta, mensajeId: string, adjunto: string): string {
  return path.join(carpetaMensaje(ctx.directory, mensajeId), adjunto)
}

/** RN3 + HU-4: archiva el contrato, inserta la fila (AUTO si no tiene número) y deja historial "insertado". */
async function registrarNuevo(ctx: ContextoHerramienta, mensajeId: string, v: MensajeValidado, contrato: ContratoExtraido, adjunto: string, confirmado: boolean): Promise<Escritura> {
  const faltan = faltantesObligatorios(contrato)
  if (faltan.length > 0) throw new Error(`Falta ${faltan.join(", ")}; indícalo para poder registrar`)
  const anio = (contrato.fecha_inicio.valor ?? "").slice(0, 4)
  const id = contrato.id_contrato.valor ?? generarIdAuto(v.filas, anio)
  const conId = { ...contrato, id_contrato: { ...contrato.id_contrato, valor: id } }
  const base = construirFilaNueva(conId, v.resultado.comercial, "", fechaHoyISO())
  const ruta = await archivarDocumento(ctx, rutaAdjunto(ctx, mensajeId, adjunto), anio, crearSlugCliente(base.cliente), `${id}${path.extname(adjunto)}`)
  await escribirMaestroSeguro(ctx, [...v.filas, { ...base, ruta_sharepoint: ruta }])
  await agregarHistorial(ctx, entradaHistorial({ id_contrato: id, accion: "insertado", cambios: {}, mensaje_id: mensajeId, ruta_archivo: ruta }, v, confirmado))
  return { id_contrato: id, accion: "insertado", ruta_archivo: ruta }
}

/** RN2 + HU-4: archiva el otrosí como versión nueva, aplica solo las diferencias y deja historial "actualizado". */
async function registrarActualizacion(ctx: ContextoHerramienta, mensajeId: string, v: MensajeValidado, contrato: ContratoExtraido, adjunto: string, confirmado: boolean): Promise<Escritura> {
  const idExistente = v.resultado.id_contrato_existente
  const fila = v.filas.find((candidata) => candidata.id_contrato === idExistente)
  if (!fila) throw new Error(`El contrato ${contrato.id_contrato.valor ?? "sin número"} no existe en el maestro; no hay fila que actualizar`)
  const anio = fila.fecha_inicio.slice(0, 4)
  const slug = crearSlugCliente(fila.cliente)
  const etiqueta = contrato.tipo_documento === "otrosi" ? "otrosi" : "actualizacion"
  const carpeta = path.join(carpetaContratosSharepoint(ctx.directory), anio, slug)
  const nombre = await nombreArchivoVersion(carpeta, fila.id_contrato, etiqueta, path.extname(adjunto))
  const ruta = await archivarDocumento(ctx, rutaAdjunto(ctx, mensajeId, adjunto), anio, slug, nombre)
  const actualizada = aplicarDiferencias(fila, v.resultado.diferencias)
  await escribirMaestroSeguro(ctx, v.filas.map((candidata) => (candidata === fila ? actualizada : candidata)))
  const base = { id_contrato: fila.id_contrato, accion: "actualizado", cambios: v.resultado.diferencias, mensaje_id: mensajeId, ruta_archivo: ruta }
  await agregarHistorial(ctx, entradaHistorial(base, v, confirmado))
  return { id_contrato: fila.id_contrato, accion: "actualizado", ruta_archivo: ruta }
}

/** Escribe según la clasificación: nuevo inserta, actualización modifica, duplicado no escribe nada (RN1). */
async function escribirSegunClasificacion(ctx: ContextoHerramienta, mensajeId: string, v: MensajeValidado, confirmado: boolean): Promise<Escritura> {
  const { clasificacion, id_contrato_existente } = v.resultado
  if (clasificacion === "duplicado") return { id_contrato: id_contrato_existente ?? "", accion: "sin_escritura", ruta_archivo: null }
  if (!v.contrato || !v.adjunto) throw new Error("El mensaje no tiene un contrato para registrar")
  if (clasificacion === "actualizacion") return registrarActualizacion(ctx, mensajeId, v, v.contrato, v.adjunto, confirmado)
  return registrarNuevo(ctx, mensajeId, v, v.contrato, v.adjunto, confirmado)
}

/** Error legible si el mensaje ya está en out/procesados.json: nunca se registra dos veces (O2). */
async function exigirNoProcesado(ctx: ContextoHerramienta, mensajeId: string): Promise<void> {
  if (mensajeId in (await leerProcesados(ctx))) throw new Error(`El mensaje ${mensajeId} ya fue procesado`)
}

/**
 * contratos_registrar (HU-4): valida de nuevo con la misma lógica de validar (CA2), exige confirmación si hay
 * campos en revisión (RN5), escribe según la clasificación y SOLO al final marca el mensaje como procesado.
 */
export async function registrarMensaje(
  ctx: ContextoHerramienta,
  mensajeId: string,
  recibido: ContratoExtraido,
  confirmado: boolean,
): Promise<ResultadoRegistro> {
  await exigirNoProcesado(ctx, mensajeId)
  const validado = await validarMensaje(ctx, mensajeId, recibido)
  const { clasificacion, requiere_revision, motivo } = validado.resultado
  if (clasificacion === "rechazado") throw new Error(`El mensaje fue rechazado: ${motivo ?? "sin motivo"}. Usa descartar`)
  if (requiere_revision.length > 0 && !confirmado) throw new Error(`requiere revisión: ${requiere_revision.join(", ")}`)
  const escritura = await escribirSegunClasificacion(ctx, mensajeId, validado, confirmado)
  await marcarProcesado(ctx, mensajeId, { clasificacion, accion: escritura.accion })
  return { ...escritura, clasificacion }
}

/**
 * contratos_descartar (RN4, RN1): cierra un mensaje que no se registra. Solo si no trae contrato o su validación
 * da rechazado o duplicado; si trae un contrato registrable, se exige usar registrar. No toca el maestro.
 */
export async function descartarMensaje(
  ctx: ContextoHerramienta,
  mensajeId: string,
  motivo: string,
): Promise<{ mensaje_id: string; clasificacion: Clasificacion; accion: "descartado" }> {
  await exigirNoProcesado(ctx, mensajeId)
  const { clasificacion } = (await validarMensaje(ctx, mensajeId, null)).resultado
  if (clasificacion !== "rechazado" && clasificacion !== "duplicado") {
    throw new Error("El mensaje contiene un contrato registrable; usa registrar")
  }
  await marcarProcesado(ctx, mensajeId, { clasificacion, accion: "descartado", motivo })
  return { mensaje_id: mensajeId, clasificacion, accion: "descartado" }
}
