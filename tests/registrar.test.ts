import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cp, mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { descartar, extraer, registrar } from "../src/tools/contratos"
import { existeArchivo } from "../src/tools/dominio/archivos"
import { leerMaestro, leerProcesados } from "../src/tools/dominio/maestro"
import {
  escribirMaestroSeguro,
  faltantesObligatorios,
  generarIdAuto,
  nombreArchivoVersion,
} from "../src/tools/dominio/registro"
import { carpetaSharepoint, rutaHistorial, rutaMaestroFixture, rutaMaestroSalida } from "../src/tools/dominio/rutas"
import {
  COLUMNAS_MAESTRO,
  type ContextoHerramienta,
  type ContratoExtraido,
  type EntradaHistorial,
  type FilaMaestro,
  type ResultadoHerramienta,
} from "../src/tools/dominio/tipos"
import type { ResultadoRegistro } from "../src/tools/dominio/registro"

const FIXTURES_REALES = path.join(import.meta.dir, "..", "fixtures", "reto-02")

/** Carpeta temporal con copia de fixtures/reto-02 como raíz del proyecto. */
async function crearCopia(): Promise<ContextoHerramienta> {
  const directorio = await mkdtemp(path.join(os.tmpdir(), "reto02-registrar-"))
  await cp(FIXTURES_REALES, path.join(directorio, "fixtures", "reto-02"), { recursive: true })
  return { directory: directorio, sessionId: "test" }
}

/** Contrato extraído por la herramienta (exige ok). */
async function extraerContrato(ctx: ContextoHerramienta, mensajeId: string): Promise<ContratoExtraido> {
  const resultado = JSON.parse(await extraer.execute({ mensaje_id: mensajeId }, ctx)) as ResultadoHerramienta<{ contrato: ContratoExtraido }>
  if (!resultado.ok) throw new Error(resultado.error)
  return resultado.data.contrato
}

/** Flujo del agente: extraer y registrar (con o sin confirmación, o con un contrato corregido). */
async function registrarMensaje(
  ctx: ContextoHerramienta,
  mensajeId: string,
  opciones: { confirmado?: boolean; corregir?: (contrato: ContratoExtraido) => ContratoExtraido } = {},
): Promise<ResultadoHerramienta<ResultadoRegistro>> {
  const extraido = await extraerContrato(ctx, mensajeId)
  const contrato = opciones.corregir ? opciones.corregir(extraido) : extraido
  const args = { mensaje_id: mensajeId, contrato, ...(opciones.confirmado === undefined ? {} : { confirmado: opciones.confirmado }) }
  return JSON.parse(await registrar.execute(args, ctx)) as ResultadoHerramienta<ResultadoRegistro>
}

/** Registrar exigiendo ok. */
async function registrarOk(ctx: ContextoHerramienta, mensajeId: string, confirmado?: boolean): Promise<ResultadoRegistro> {
  const resultado = await registrarMensaje(ctx, mensajeId, confirmado === undefined ? {} : { confirmado })
  if (!resultado.ok) throw new Error(resultado.error)
  return resultado.data
}

/** Descartar y parsear. */
async function descartarMensaje(ctx: ContextoHerramienta, mensajeId: string, motivo: string) {
  return JSON.parse(await descartar.execute({ mensaje_id: mensajeId, motivo }, ctx)) as ResultadoHerramienta<{ accion: string }>
}

/** Líneas de out/sharepoint/historial.jsonl. */
async function leerHistorial(ctx: ContextoHerramienta): Promise<EntradaHistorial[]> {
  const texto = await readFile(rutaHistorial(ctx.directory), "utf8").catch(() => "")
  return texto.trim() === "" ? [] : texto.trim().split("\n").map((linea) => JSON.parse(linea) as EntradaHistorial)
}

/** Fila del maestro de salida por id. */
async function filaDe(ctx: ContextoHerramienta, id: string): Promise<FilaMaestro | undefined> {
  return (await leerMaestro(ctx)).find((fila) => fila.id_contrato === id)
}

describe("flujo completo del buzón sobre una sola copia", () => {
  let ctx: ContextoHerramienta
  let fixtureOriginal: string

  beforeAll(async () => {
    ctx = await crearCopia()
    fixtureOriginal = await readFile(rutaMaestroFixture(ctx.directory), "utf8")
  })

  afterAll(async () => {
    await rm(ctx.directory, { recursive: true, force: true })
  })

  test("msg-001 → insertado con póliza pendiente, archivo, historial y procesados", async () => {
    const resultado = await registrarOk(ctx, "msg-001")
    const ruta = "Contratos/2026/industrias-delta/CT-2026-015.txt"
    expect(resultado).toEqual({ id_contrato: "CT-2026-015", accion: "insertado", ruta_archivo: ruta, clasificacion: "nuevo" })
    expect(await filaDe(ctx, "CT-2026-015")).toMatchObject({
      estado_poliza: "pendiente",
      comercial: "Laura Gómez Restrepo",
      ruta_sharepoint: ruta,
      fuente: "buzon",
      nit_cliente: "890900111",
    })
    expect(await existeArchivo(path.join(carpetaSharepoint(ctx.directory), ...ruta.split("/")))).toBe(true)
    expect((await leerHistorial(ctx)).at(-1)).toMatchObject({ id_contrato: "CT-2026-015", accion: "insertado", cambios: {}, mensaje_id: "msg-001" })
    expect((await leerProcesados(ctx))["msg-001"]).toMatchObject({ clasificacion: "nuevo", accion: "insertado" })
  })

  test("msg-002 → insertado sin póliza (no_aplica, tipo vacío)", async () => {
    expect((await registrarOk(ctx, "msg-002")).accion).toBe("insertado")
    expect(await filaDe(ctx, "CT-2026-016")).toMatchObject({ estado_poliza: "no_aplica", tipo_poliza: "", requiere_poliza: false })
  })

  test("msg-003 → actualizado; ruta .pdf original intacta; otrosí archivado como versión", async () => {
    const resultado = await registrarOk(ctx, "msg-003")
    expect(resultado).toMatchObject({ id_contrato: "CT-2026-011", accion: "actualizado", clasificacion: "actualizacion" })
    expect(resultado.ruta_archivo).toBe("Contratos/2026/minera-los-andes/CT-2026-011-otrosi-1.txt")
    expect(await filaDe(ctx, "CT-2026-011")).toMatchObject({
      fecha_inicio: "2026-05-02",
      fecha_fin: "2027-11-01",
      valor: 520000,
      estado_poliza: "pendiente",
      ruta_sharepoint: "Contratos/2026/minera-los-andes/CT-2026-011.pdf",
    })
    expect(await existeArchivo(path.join(carpetaSharepoint(ctx.directory), "Contratos", "2026", "minera-los-andes", "CT-2026-011-otrosi-1.txt"))).toBe(true)
    expect((await leerHistorial(ctx)).at(-1)).toMatchObject({
      id_contrato: "CT-2026-011",
      accion: "actualizado",
      cambios: {
        valor: { antes: "350000", despues: "520000" },
        fecha_fin: { antes: "2027-05-01", despues: "2027-11-01" },
        estado_poliza: { antes: "vigente", despues: "pendiente" },
      },
    })
  })

  test("msg-004 → sin_escritura; el maestro no cambia", async () => {
    const antes = await readFile(rutaMaestroSalida(ctx.directory), "utf8")
    const historialAntes = (await leerHistorial(ctx)).length
    expect(await registrarOk(ctx, "msg-004")).toEqual({ id_contrato: "CT-2026-012", accion: "sin_escritura", ruta_archivo: null, clasificacion: "duplicado" })
    expect(await readFile(rutaMaestroSalida(ctx.directory), "utf8")).toBe(antes)
    expect(await leerHistorial(ctx)).toHaveLength(historialAntes)
  })

  test("msg-006 sin confirmar → requiere revisión y no queda procesado", async () => {
    expect(await registrarMensaje(ctx, "msg-006")).toEqual({ ok: false, error: "requiere revisión: valor, fecha_fin" })
    expect("msg-006" in (await leerProcesados(ctx))).toBe(false)
  })

  test("msg-006 con confirmado → insertado; comercial = email; historial confirmado_por usuario", async () => {
    expect(await registrarOk(ctx, "msg-006", true)).toMatchObject({ id_contrato: "CM-2026-03", accion: "insertado" })
    expect(await filaDe(ctx, "CM-2026-03")).toMatchObject({
      comercial: "jperez@periferia-ficticia.com",
      valor: 0,
      fecha_inicio: "2026-08-31",
      fecha_fin: "2027-08-31",
      estado_poliza: "pendiente",
    })
    expect((await leerHistorial(ctx)).at(-1)).toMatchObject({
      id_contrato: "CM-2026-03",
      confirmado_por: "usuario",
      campos_confirmados: ["valor", "fecha_fin"],
      correcciones: {},
    })
  })

  test("msg-005 → descartar ok", async () => {
    expect(await descartarMensaje(ctx, "msg-005", "El adjunto es una cotización, no un contrato")).toMatchObject({
      ok: true,
      data: { accion: "descartado" },
    })
    expect((await leerProcesados(ctx))["msg-005"]).toMatchObject({ clasificacion: "rechazado", accion: "descartado" })
  })

  test("registrar msg-001 otra vez → ya fue procesado", async () => {
    expect(await registrarMensaje(ctx, "msg-001")).toEqual({ ok: false, error: "El mensaje msg-001 ya fue procesado" })
  })

  test("al final: 11 filas, columnas en orden y fixture sin cambios", async () => {
    const texto = await readFile(rutaMaestroSalida(ctx.directory), "utf8")
    expect(texto.split("\n")[0]).toBe(COLUMNAS_MAESTRO.join(","))
    expect(await leerMaestro(ctx)).toHaveLength(11)
    expect(await readFile(rutaMaestroFixture(ctx.directory), "utf8")).toBe(fixtureOriginal)
  })
})

describe("casos en copias limpias", () => {
  let ctx: ContextoHerramienta

  beforeAll(async () => {
    ctx = await crearCopia()
  })

  afterAll(async () => {
    await rm(ctx.directory, { recursive: true, force: true })
  })

  test("descartar un contrato registrable (msg-001) → error", async () => {
    expect(await descartarMensaje(ctx, "msg-001", "no lo quiero")).toEqual({
      ok: false,
      error: "El mensaje contiene un contrato registrable; usa registrar",
    })
  })

  test("corrección humana: msg-006 con fecha_fin 2027-07-31 → se guarda y el historial muestra extraído y final", async () => {
    const corregir = (contrato: ContratoExtraido) => ({ ...contrato, fecha_fin: { ...contrato.fecha_fin, valor: "2027-07-31" } })
    const resultado = await registrarMensaje(ctx, "msg-006", { confirmado: true, corregir })
    expect(resultado.ok).toBe(true)
    expect((await filaDe(ctx, "CM-2026-03"))?.fecha_fin).toBe("2027-07-31")
    expect((await leerHistorial(ctx)).at(-1)).toMatchObject({
      confirmado_por: "usuario",
      correcciones: { fecha_fin: { extraido: "2027-08-31", final: "2027-07-31" } },
    })
  })

  test("un id corregido con ruta ('../x') no se archiva fuera de la carpeta", async () => {
    const corregir = (contrato: ContratoExtraido) => ({ ...contrato, id_contrato: { ...contrato.id_contrato, valor: "../../x" } })
    const resultado = await registrarMensaje(ctx, "msg-002", { confirmado: true, corregir })
    expect(resultado).toEqual({ ok: false, error: 'Nombre no permitido para archivar: "../../x.txt"' })
    expect("msg-002" in (await leerProcesados(ctx))).toBe(false)
  })

  test("escrituras en paralelo no se pisan: dos registrar y un descartar simultáneos", async () => {
    const paralelo = await crearCopia()
    try {
      const [c1, c2] = await Promise.all([extraerContrato(paralelo, "msg-001"), extraerContrato(paralelo, "msg-002")])
      const respuestas = await Promise.all([
        registrar.execute({ mensaje_id: "msg-001", contrato: c1 }, paralelo),
        registrar.execute({ mensaje_id: "msg-002", contrato: c2 }, paralelo),
        descartar.execute({ mensaje_id: "msg-005", motivo: "cotización" }, paralelo),
      ])
      expect(respuestas.map((r) => (JSON.parse(r) as { ok: boolean }).ok)).toEqual([true, true, true])
      const ids = (await leerMaestro(paralelo)).map((fila) => fila.id_contrato)
      expect(ids).toHaveLength(10)
      expect(ids).toEqual(expect.arrayContaining(["CT-2026-015", "CT-2026-016"]))
      expect(Object.keys(await leerProcesados(paralelo)).sort()).toEqual(["msg-001", "msg-002", "msg-005"])
    } finally {
      await rm(paralelo.directory, { recursive: true, force: true })
    }
  })

  test("falta un dato obligatorio aunque haya confirmación → error", async () => {
    const corregir = (contrato: ContratoExtraido) => ({ ...contrato, nit_cliente: { valor: null, confianza: 0, evidencia: null } })
    expect(await registrarMensaje(ctx, "msg-002", { confirmado: true, corregir })).toEqual({
      ok: false,
      error: "Falta nit_cliente; indícalo para poder registrar",
    })
  })
})

describe("unitarios de registro", () => {
  const fila = (id: string): FilaMaestro => ({
    id_contrato: id, cliente: "X", nit_cliente: "1", pais: "CO", objeto: "", valor: 1, moneda: "COP",
    fecha_inicio: "2026-01-01", fecha_fin: "2026-12-31", requiere_poliza: false, tipo_poliza: "",
    estado_poliza: "no_aplica", comercial: "", ruta_sharepoint: "", fecha_registro: "2026-01-01", fuente: "buzon",
  })

  test("generarIdAuto usa el siguiente número libre del año", () => {
    expect(generarIdAuto([fila("CT-2026-001")], "2026")).toBe("AUTO-2026-001")
    expect(generarIdAuto([fila("AUTO-2026-001"), fila("AUTO-2026-003"), fila("AUTO-2025-009")], "2026")).toBe("AUTO-2026-004")
  })

  test("un segundo otrosí del mismo contrato se numera -otrosi-2", async () => {
    const ctx = await crearCopia()
    try {
      await registrarOk(ctx, "msg-003")
      const carpeta = path.join(carpetaSharepoint(ctx.directory), "Contratos", "2026", "minera-los-andes")
      expect(await nombreArchivoVersion(carpeta, "CT-2026-011", "otrosi", ".txt")).toBe("CT-2026-011-otrosi-2.txt")
    } finally {
      await rm(ctx.directory, { recursive: true, force: true })
    }
  })

  test("escribirMaestroSeguro rechaza ids repetidos (O2) y no escribe", async () => {
    const ctx = await crearCopia()
    try {
      await expect(escribirMaestroSeguro(ctx, [fila("CT-1"), fila("CT-1")])).rejects.toThrow("CT-1 repetido")
      expect(await existeArchivo(rutaMaestroSalida(ctx.directory))).toBe(false)
    } finally {
      await rm(ctx.directory, { recursive: true, force: true })
    }
  })

  test("faltantesObligatorios lista lo que el maestro no admite vacío", () => {
    const vacio = { valor: null, confianza: 0, evidencia: null }
    const campo = <T,>(valor: T) => ({ valor, confianza: 0.95, evidencia: null })
    const contrato: ContratoExtraido = {
      tipo_documento: "contrato", id_contrato: vacio, cliente: campo("X"), nit_cliente: vacio, pais: campo("CO"),
      objeto: vacio, valor: campo(1), moneda: vacio, fecha_inicio: campo("2026-01-01"), fecha_fin: campo("2026-02-01"),
      requiere_poliza: campo(false), tipo_poliza: campo(""), valor_indeterminado: false, exige_ampliar_garantias: false,
    }
    expect(faltantesObligatorios(contrato)).toEqual(["nit_cliente", "moneda"])
  })
})
