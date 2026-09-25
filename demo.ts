// Demo sin modelo (PRD 6.6): procesa el buzón llamando directamente a las herramientas, sin clave de ningún proveedor.
import { readFile } from "node:fs/promises"
import { z } from "zod"
import { alertas, descartar, extraer, leer_buzon, registrar, validar } from "./src/tools/contratos"
import type { Herramienta } from "./src/tools/dominio/herramienta"
import { leerMaestro } from "./src/tools/dominio/maestro"
import { FECHA_CORTE_MAESTRO } from "./src/tools/dominio/reglas"
import { reiniciarSalida } from "./src/tools/dominio/registro"
import { rutaMaestroFixture } from "./src/tools/dominio/rutas"
import {
  ACCIONES_REGISTRO,
  esquemaClasificacion,
  esquemaContratoExtraido,
  esquemaMensajeBuzon,
  esquemaResultadoValidacion,
  type AccionRegistro,
  type ContextoHerramienta,
  type ContratoExtraido,
  type MensajeBuzon,
  type ResultadoHerramienta,
  type ResultadoValidacion,
} from "./src/tools/dominio/tipos"

// ── Constantes y esquemas de las respuestas ────────────────────────────────

/** Fecha de referencia de la demo: registro y alertas (determinismo, PRD 8). */
const HOY_DEMO = "2026-09-03"
const FILAS_ESPERADAS = 11

/** Lo que "responde" la analista en la segunda pasada (PRD 11: "confirmo el valor 0 y la fecha fin 2027-08-31"). */
const CONFIRMACIONES_ANALISTA: Record<string, { valor?: number; fecha_inicio?: string; fecha_fin?: string }> = {
  "msg-006": { valor: 0, fecha_fin: "2027-08-31" },
}

const TEXTO_ACCION: Record<AccionRegistro, string> = { insertado: "insertado", actualizado: "actualizado", sin_escritura: "sin escritura" }

const CONTRATO_CON_ID = z.object({ id_contrato: z.string() })
const DATA_BUZON = z.object({ mensajes: z.array(esquemaMensajeBuzon), total_pendientes: z.number() })
const DATA_EXTRAER = z.object({ mensaje_id: z.string(), adjunto: z.string(), contrato: esquemaContratoExtraido })
const DATA_DESCARTAR = z.object({ clasificacion: esquemaClasificacion, accion: z.literal("descartado") })
const DATA_REGISTRAR = z.object({
  id_contrato: z.string(),
  accion: z.enum(ACCIONES_REGISTRO),
  ruta_archivo: z.string().nullable(),
  clasificacion: esquemaClasificacion,
})
const DATA_ALERTAS = z.object({
  ruta: z.string(),
  vencen: z.array(CONTRATO_CON_ID),
  polizas_pendientes: z.array(CONTRATO_CON_ID),
  registrados_desde_corte: z.array(CONTRATO_CON_ID),
  ya_vencidos: z.array(CONTRATO_CON_ID),
  actualizados_desde_corte: z.array(CONTRATO_CON_ID),
})

// ── Tipos del resumen ──────────────────────────────────────────────────────

/** Una fila de la tabla de la primera pasada (PRD 6.6: clasificación, campos en revisión, acción). */
export type FilaResumen = { mensaje_id: string; clasificacion: string; en_revision: string[]; accion: string; id_contrato: string | null }

/** Resultado de la segunda pasada con confirmado=true. */
export type Confirmacion = { mensaje_id: string; confirmados: string; accion: string; id_contrato: string | null; ruta_archivo: string | null }

/** Cantidad e ids por sección de alertas. */
export type ResumenAlertas = { ruta: string; secciones: { titulo: string; ids: string[] }[] }

/** Un chequeo de la verificación final con su resultado. */
export type Chequeo = { descripcion: string; ok: boolean }

/** Todo lo que produce la demo; `lineas` es la salida ya formateada (idéntica entre ejecuciones). */
export type ResumenDemo = {
  filas: FilaResumen[]
  avisos: string[]
  confirmaciones: Confirmacion[]
  alertas: ResumenAlertas
  verificacion: { ok: boolean; chequeos: Chequeo[] }
  lineas: string[]
}

type Pendiente = { mensaje_id: string; contrato: ContratoExtraido; campos: string[] }
type Procesado = { fila: FilaResumen; pendiente?: Pendiente; aviso?: string }

/** Largo máximo del motivo de descarte en la columna acción. */
const LARGO_MOTIVO = 70

// ── Llamadas a herramientas ────────────────────────────────────────────────

/**
 * Llama una herramienta como lo haría el agente (6.2): execute → JSON → { ok, data | error }, validando la forma de
 * `data` con zod para tenerla tipada sin `any`.
 */
export async function llamarHerramienta<Args extends z.ZodRawShape, T>(
  herramienta: Herramienta<Args>,
  args: z.infer<z.ZodObject<Args>>,
  ctx: ContextoHerramienta,
  esquemaData: z.ZodType<T>,
): Promise<ResultadoHerramienta<T>> {
  const esquema = z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), data: esquemaData }),
    z.object({ ok: z.literal(false), error: z.string() }),
  ])
  const resultado = esquema.safeParse(JSON.parse(await herramienta.execute(args, ctx)))
  return resultado.success ? resultado.data : { ok: false, error: "La herramienta respondió con una forma inesperada" }
}

// ── Primera pasada ─────────────────────────────────────────────────────────

/** Fila de error: la demo reporta el problema y sigue con el siguiente mensaje (HU-6). */
function filaError(mensajeId: string, clasificacion: string, error: string): FilaResumen {
  return { mensaje_id: mensajeId, clasificacion, en_revision: [], accion: `error: ${error}`, id_contrato: null }
}

/** Recorta un texto a `largo` caracteres con "…" para que la tabla no se desborde. */
function recortar(texto: string, largo: number): string {
  return texto.length <= largo ? texto : `${texto.slice(0, largo - 1).trimEnd()}…`
}

/** Descarta un mensaje que no se registra (RN4) y devuelve su fila con el motivo en la acción. */
async function descartarFila(ctx: ContextoHerramienta, mensajeId: string, motivo: string): Promise<FilaResumen> {
  const resultado = await llamarHerramienta(descartar, { mensaje_id: mensajeId, motivo }, ctx, DATA_DESCARTAR)
  if (!resultado.ok) return filaError(mensajeId, "rechazado", resultado.error)
  const accion = `descartado: ${recortar(motivo, LARGO_MOTIVO)}`
  return { mensaje_id: mensajeId, clasificacion: resultado.data.clasificacion, en_revision: [], accion, id_contrato: null }
}

/**
 * Aviso de remitente no registrado (HU-3: se reporta, no bloquea). En un contrato nuevo se aclara que la columna
 * comercial guarda su correo (supuesto de registro).
 */
function avisoComercial(mensajeId: string, comercial: ResultadoValidacion["comercial"], clasificacion: string): string | undefined {
  if (comercial.registrado) return undefined
  const base = `${mensajeId}: el remitente ${comercial.email} no está en comerciales.json`
  return clasificacion === "nuevo" ? `${base}; se registró su correo en la columna comercial.` : `${base} (no bloquea).`
}

/** validar → descartar (rechazado) o registrar sin confirmar; "requiere revisión" queda pendiente (RN5, CA3). */
async function procesarConContrato(ctx: ContextoHerramienta, mensajeId: string, contrato: ContratoExtraido): Promise<Procesado> {
  const validacion = await llamarHerramienta(validar, { mensaje_id: mensajeId, contrato }, ctx, esquemaResultadoValidacion)
  if (!validacion.ok) return { fila: filaError(mensajeId, "—", validacion.error) }
  const { clasificacion, requiere_revision, motivo, comercial } = validacion.data
  if (clasificacion === "rechazado") return { fila: await descartarFila(ctx, mensajeId, motivo ?? "rechazado") }
  const aviso = avisoComercial(mensajeId, comercial, clasificacion)
  const registro = await llamarHerramienta(registrar, { mensaje_id: mensajeId, contrato }, ctx, DATA_REGISTRAR)
  const base = { mensaje_id: mensajeId, clasificacion, en_revision: requiere_revision }
  if (registro.ok) return { fila: { ...base, accion: TEXTO_ACCION[registro.data.accion], id_contrato: registro.data.id_contrato }, aviso }
  if (!registro.error.startsWith("requiere revisión:")) return { fila: filaError(mensajeId, clasificacion, registro.error), aviso }
  const pendiente = { mensaje_id: mensajeId, contrato, campos: requiere_revision }
  return { fila: { ...base, accion: "pendiente de confirmación", id_contrato: contrato.id_contrato.valor }, pendiente, aviso }
}

/** Un mensaje del buzón: sin contrato → descartar; con contrato → extraer y seguir (HU-1, HU-2). */
async function procesarMensaje(ctx: ContextoHerramienta, mensaje: MensajeBuzon): Promise<Procesado> {
  if (!mensaje.tiene_contrato) return { fila: await descartarFila(ctx, mensaje.id, mensaje.motivo ?? "El mensaje no trae contrato") }
  const extraccion = await llamarHerramienta(extraer, { mensaje_id: mensaje.id }, ctx, DATA_EXTRAER)
  if (!extraccion.ok) return { fila: filaError(mensaje.id, "—", extraccion.error) }
  return procesarConContrato(ctx, mensaje.id, extraccion.data.contrato)
}

/** Recorre el buzón en orden de id; un mensaje con error no detiene el lote (HU-6). */
async function primeraPasada(ctx: ContextoHerramienta): Promise<{ filas: FilaResumen[]; pendientes: Pendiente[]; avisos: string[] }> {
  const buzon = await llamarHerramienta(leer_buzon, {}, ctx, DATA_BUZON)
  if (!buzon.ok) throw new Error(buzon.error)
  const filas: FilaResumen[] = []
  const pendientes: Pendiente[] = []
  const avisos: string[] = []
  for (const mensaje of buzon.data.mensajes) {
    const { fila, pendiente, aviso } = await procesarMensaje(ctx, mensaje)
    filas.push(fila)
    if (pendiente) pendientes.push(pendiente)
    if (aviso) avisos.push(aviso)
  }
  return { filas, pendientes, avisos }
}

// ── Segunda pasada ─────────────────────────────────────────────────────────

/** Aplica los valores que confirma la analista sobre el contrato extraído (corrección humana, CA3). */
function aplicarConfirmacion(contrato: ContratoExtraido, valores: { valor?: number; fecha_inicio?: string; fecha_fin?: string }): ContratoExtraido {
  return {
    ...contrato,
    valor: valores.valor === undefined ? contrato.valor : { ...contrato.valor, valor: valores.valor },
    fecha_inicio: valores.fecha_inicio === undefined ? contrato.fecha_inicio : { ...contrato.fecha_inicio, valor: valores.fecha_inicio },
    fecha_fin: valores.fecha_fin === undefined ? contrato.fecha_fin : { ...contrato.fecha_fin, valor: valores.fecha_fin },
  }
}

/** Valor de un campo del contrato como texto, para mostrar qué se confirmó. */
function valorDeCampo(contrato: ContratoExtraido, campo: string): string {
  const entrada = Object.entries(contrato).find(([nombre]) => nombre === campo)?.[1]
  return typeof entrada === "object" ? String(entrada.valor) : String(entrada)
}

/** Registra cada pendiente con confirmado=true usando lo que confirmó la analista (PRD 6.6, segunda llamada). */
async function confirmarPendientes(ctx: ContextoHerramienta, pendientes: Pendiente[]): Promise<Confirmacion[]> {
  const confirmaciones: Confirmacion[] = []
  for (const { mensaje_id, contrato, campos } of pendientes) {
    const confirmado = aplicarConfirmacion(contrato, CONFIRMACIONES_ANALISTA[mensaje_id] ?? {})
    const confirmados = campos.map((campo) => `${campo} = ${valorDeCampo(confirmado, campo)}`).join(", ")
    const registro = await llamarHerramienta(registrar, { mensaje_id, contrato: confirmado, confirmado: true }, ctx, DATA_REGISTRAR)
    confirmaciones.push(registro.ok
      ? { mensaje_id, confirmados, accion: TEXTO_ACCION[registro.data.accion], id_contrato: registro.data.id_contrato, ruta_archivo: registro.data.ruta_archivo }
      : { mensaje_id, confirmados, accion: `error: ${registro.error}`, id_contrato: null, ruta_archivo: null })
  }
  return confirmaciones
}

// ── Alertas y verificación ─────────────────────────────────────────────────

/** Genera out/alertas.md con hoy 2026-09-03 y resume cantidad e ids por sección (HU-5). */
async function resumirAlertas(ctx: ContextoHerramienta): Promise<ResumenAlertas> {
  const resultado = await llamarHerramienta(alertas, { hoy: HOY_DEMO }, ctx, DATA_ALERTAS)
  if (!resultado.ok) throw new Error(resultado.error)
  const ids = (lista: { id_contrato: string }[]) => lista.map((contrato) => contrato.id_contrato)
  const d = resultado.data
  return {
    ruta: d.ruta,
    secciones: [
      { titulo: "Vencen en ≤ 60 días", ids: ids(d.vencen) },
      { titulo: "Pólizas no vigentes", ids: ids(d.polizas_pendientes) },
      { titulo: `Registrados desde el corte (${FECHA_CORTE_MAESTRO})`, ids: ids(d.registrados_desde_corte) },
      { titulo: "Ya vencidos (informativo)", ids: ids(d.ya_vencidos) },
      { titulo: "Actualizados desde el corte (informativo)", ids: ids(d.actualizados_desde_corte) },
    ],
  }
}

/**
 * Verificación final (PRD 6.6, O2, RN6): cada chequeo con su resultado. 11 filas en el maestro, 0 pendientes en el buzón,
 * fixture sin cambios y filas nuevas con la fecha de registro fijada.
 */
async function verificar(ctx: ContextoHerramienta, fixtureInicial: string): Promise<{ ok: boolean; chequeos: Chequeo[] }> {
  const filas = await leerMaestro(ctx)
  const buzon = await llamarHerramienta(leer_buzon, {}, ctx, DATA_BUZON)
  const pendientes = buzon.ok ? buzon.data.total_pendientes : Number.NaN
  const fixtureActual = await readFile(rutaMaestroFixture(ctx.directory), "utf8")
  const nuevas = filas.filter((fila) => fila.fecha_registro >= FECHA_CORTE_MAESTRO)
  const fecha = ctx.fechaActual ?? HOY_DEMO
  const chequeos: Chequeo[] = [
    { descripcion: `${filas.length} filas en el maestro de salida (se esperaban ${FILAS_ESPERADAS})`, ok: filas.length === FILAS_ESPERADAS },
    { descripcion: `${buzon.ok ? pendientes : "?"} mensajes pendientes en el buzón (se esperaban 0)`, ok: pendientes === 0 },
    { descripcion: "fixture maestro-contratos.csv sin cambios", ok: fixtureActual === fixtureInicial },
    { descripcion: `filas nuevas con fecha_registro ${fecha}`, ok: nuevas.every((fila) => fila.fecha_registro === fecha) },
  ]
  return { ok: chequeos.every((chequeo) => chequeo.ok), chequeos }
}

// ── Salida ─────────────────────────────────────────────────────────────────

/** Tabla de texto con columnas alineadas a mano (sin console.table ni horas: salida idéntica entre ejecuciones). */
function formatearTabla(encabezados: string[], filas: string[][]): string[] {
  const anchos = encabezados.map((titulo, i) => Math.max(titulo.length, ...filas.map((fila) => (fila[i] ?? "").length)))
  const linea = (celdas: string[]) => celdas.map((celda, i) => celda.padEnd(anchos[i] ?? 0)).join(" | ").trimEnd()
  return [linea(encabezados), anchos.map((ancho) => "-".repeat(ancho)).join("-+-"), ...filas.map(linea)]
}

/** Arma la salida en español de la demo a partir de sus resultados. */
function formatearSalida(resumen: Omit<ResumenDemo, "lineas">, fecha: string): string[] {
  const tabla = formatearTabla(
    ["mensaje", "clasificación", "en revisión", "acción"],
    resumen.filas.map((f) => [f.mensaje_id, f.clasificacion, f.en_revision.join(", ") || "—", [f.accion, f.id_contrato ?? ""].join(" ").trim()]),
  )
  const confirmaciones = resumen.confirmaciones.flatMap((c) => [
    `Confirmación de la analista (${c.mensaje_id}): ${c.confirmados}`,
    `  → ${[c.accion, c.id_contrato ?? "", c.ruta_archivo ? `(${c.ruta_archivo})` : ""].join(" ").trim()}`,
  ])
  const alertasTexto = resumen.alertas.secciones.map((s) => `  ${s.titulo}: ${s.ids.length}${s.ids.length ? ` (${s.ids.join(", ")})` : ""}`)
  const chequeos = resumen.verificacion.chequeos.map(({ descripcion, ok }) => `  [${ok ? "OK" : "FALLA"}] ${descripcion}`)
  return [
    "=== Demo: Registro de Contratos Vigentes (sin modelo de lenguaje) ===",
    `Fecha de registro y de referencia: ${fecha}`,
    "", "--- Primera pasada: procesar el buzón ---", ...tabla,
    "", "--- Avisos ---", ...(resumen.avisos.length ? resumen.avisos : ["Sin avisos."]),
    "", "--- Segunda pasada: confirmación humana ---", ...(confirmaciones.length ? confirmaciones : ["Sin mensajes pendientes de confirmación."]),
    "", `--- Alertas (hoy ${HOY_DEMO}) → ${resumen.alertas.ruta} ---`, ...alertasTexto,
    "", "--- Verificación ---", ...chequeos, resumen.verificacion.ok ? "Verificación OK" : "Verificación FALLÓ",
  ]
}

/**
 * Ejecuta la demo completa sin modelo (PRD 6.6): limpia out/, procesa el buzón, confirma los pendientes,
 * genera alertas y se autoverifica. Devuelve el resumen y la salida formateada.
 */
export async function ejecutarDemo(ctx: ContextoHerramienta): Promise<ResumenDemo> {
  const fixtureInicial = await readFile(rutaMaestroFixture(ctx.directory), "utf8")
  await reiniciarSalida(ctx)
  const { filas, pendientes, avisos } = await primeraPasada(ctx)
  const confirmaciones = await confirmarPendientes(ctx, pendientes)
  const resumenAlertas = await resumirAlertas(ctx)
  const verificacion = await verificar(ctx, fixtureInicial)
  const resumen = { filas, avisos, confirmaciones, alertas: resumenAlertas, verificacion }
  return { ...resumen, lineas: formatearSalida(resumen, ctx.fechaActual ?? HOY_DEMO) }
}

if (import.meta.main) {
  const ctx: ContextoHerramienta = { directory: import.meta.dir, sessionId: "demo", fechaActual: HOY_DEMO }
  try {
    const resumen = await ejecutarDemo(ctx)
    console.log(resumen.lineas.join("\n"))
    if (!resumen.verificacion.ok) process.exitCode = 1
  } catch (error) {
    console.error(`La demo falló: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
