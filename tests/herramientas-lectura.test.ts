import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { extraer, leer_buzon } from "../src/tools/contratos"
import { esquemaMensajeId } from "../src/tools/dominio/herramienta"
import { marcarProcesado } from "../src/tools/dominio/maestro"
import { carpetaMensaje, rutaLog } from "../src/tools/dominio/rutas"
import type {
  ContextoHerramienta,
  ContratoExtraido,
  EntradaLog,
  MensajeBuzon,
  ResultadoHerramienta,
} from "../src/tools/dominio/tipos"

const FIXTURES_REALES = path.join(import.meta.dir, "..", "fixtures", "reto-02")

type DatosBuzon = { mensajes: MensajeBuzon[]; total_pendientes: number }
type DatosExtraccion = { mensaje_id: string; adjunto: string; contrato: ContratoExtraido }

let ctx: ContextoHerramienta

/** Crea una carpeta temporal como raíz del proyecto; con `conFixtures`, copia fixtures/reto-02. */
async function crearProyectoTemporal(conFixtures: boolean): Promise<ContextoHerramienta> {
  const directorio = await mkdtemp(path.join(os.tmpdir(), "reto02-herr-"))
  if (conFixtures) await cp(FIXTURES_REALES, path.join(directorio, "fixtures", "reto-02"), { recursive: true })
  return { directory: directorio, sessionId: "test" }
}

/** Lee las líneas de out/log.jsonl de la carpeta temporal. */
async function leerLog(): Promise<EntradaLog[]> {
  const texto = await readFile(rutaLog(ctx.directory), "utf8").catch(() => "")
  return texto.trim() === "" ? [] : texto.trim().split("\n").map((linea) => JSON.parse(linea) as EntradaLog)
}

/** Parsea la respuesta string de una herramienta (debe ser JSON). */
function parsear<T>(respuesta: string): ResultadoHerramienta<T> {
  expect(typeof respuesta).toBe("string")
  return JSON.parse(respuesta) as ResultadoHerramienta<T>
}

/** Ejecuta leer_buzon y exige ok: true. */
async function leerBuzonOk(): Promise<DatosBuzon> {
  const resultado = parsear<DatosBuzon>(await leer_buzon.execute({}, ctx))
  if (!resultado.ok) throw new Error(resultado.error)
  return resultado.data
}

/** Ejecuta extraer con un mensaje_id cualquiera (incluso inválido) y devuelve el resultado parseado. */
async function extraerMensaje(mensajeId: unknown): Promise<ResultadoHerramienta<DatosExtraccion>> {
  return parsear<DatosExtraccion>(await extraer.execute({ mensaje_id: mensajeId } as { mensaje_id: string }, ctx))
}

describe("con copia de los fixtures", () => {
  beforeEach(async () => {
    ctx = await crearProyectoTemporal(true)
  })

  afterEach(async () => {
    await rm(ctx.directory, { recursive: true, force: true })
  })

  test("leer_buzon: 6 pendientes, msg-005 prerrechazado y el resto con contrato", async () => {
    const { mensajes, total_pendientes } = await leerBuzonOk()
    expect(total_pendientes).toBe(6)
    expect(mensajes.map((mensaje) => mensaje.id)).toEqual(["msg-001", "msg-002", "msg-003", "msg-004", "msg-005", "msg-006"])
    const cotizacion = mensajes.find((mensaje) => mensaje.id === "msg-005")
    expect(cotizacion).toMatchObject({
      tiene_contrato: false,
      clasificacion_previa: "rechazado",
      motivo: "El adjunto cotizacion.txt no es un contrato (parece una cotización)",
      adjuntos: ["cotizacion.txt"],
    })
    for (const mensaje of mensajes.filter((m) => m.id !== "msg-005")) {
      expect({ id: mensaje.id, tiene_contrato: mensaje.tiene_contrato, previa: mensaje.clasificacion_previa, motivo: mensaje.motivo })
        .toEqual({ id: mensaje.id, tiene_contrato: true, previa: null, motivo: null })
    }
  })

  test("leer_buzon omite los mensajes que ya están en out/procesados.json", async () => {
    await marcarProcesado(ctx, "msg-001", { clasificacion: "nuevo", accion: "registrado" })
    const { mensajes, total_pendientes } = await leerBuzonOk()
    expect(total_pendientes).toBe(5)
    expect(mensajes.some((mensaje) => mensaje.id === "msg-001")).toBe(false)
  })

  test("leer_buzon: correo sin adjuntos → rechazado con motivo", async () => {
    const ruta = path.join(carpetaMensaje(ctx.directory, "msg-002"), "correo.json")
    const correo = JSON.parse(await readFile(ruta, "utf8")) as { adjuntos: string[] }
    await writeFile(ruta, JSON.stringify({ ...correo, adjuntos: [] }), "utf8")
    const { mensajes } = await leerBuzonOk()
    expect(mensajes.find((mensaje) => mensaje.id === "msg-002")).toMatchObject({
      tiene_contrato: false,
      clasificacion_previa: "rechazado",
      motivo: "El correo no trae adjuntos",
    })
  })

  test("extraer msg-001 → CT-2026-015", async () => {
    const resultado = await extraerMensaje("msg-001")
    if (!resultado.ok) throw new Error(resultado.error)
    expect(resultado.data.mensaje_id).toBe("msg-001")
    expect(resultado.data.adjunto).toBe("contrato.txt")
    expect(resultado.data.contrato.id_contrato.valor).toBe("CT-2026-015")
  })

  test("extraer msg-005 → ok:false con el motivo", async () => {
    expect(await extraerMensaje("msg-005")).toEqual({
      ok: false,
      error: "El adjunto cotizacion.txt no es un contrato (parece una cotización)",
    })
  })

  test("extraer msg-999 → ok:false, no existe", async () => {
    expect(await extraerMensaje("msg-999")).toEqual({ ok: false, error: "El mensaje msg-999 no existe en el buzón" })
  })

  test("mensaje_id con ruta ('../.env') o de otro tipo → rechazado por el esquema", async () => {
    expect(esquemaMensajeId.safeParse("../.env").success).toBe(false)
    for (const invalido of ["../.env", "msg-001/../../.env", "msg-1", 7]) {
      const resultado = await extraerMensaje(invalido)
      expect(resultado.ok).toBe(false)
      if (!resultado.ok) expect(resultado.error).toStartWith("Argumentos inválidos")
    }
  })

  test("un adjunto con nombre que sale de la carpeta no se lee", async () => {
    const ruta = path.join(carpetaMensaje(ctx.directory, "msg-001"), "correo.json")
    const correo = JSON.parse(await readFile(ruta, "utf8")) as { adjuntos: string[] }
    await writeFile(ruta, JSON.stringify({ ...correo, adjuntos: ["../../../.env"] }), "utf8")
    expect(await extraerMensaje("msg-001")).toEqual({
      ok: false,
      error: 'El adjunto "../../../.env" tiene un nombre no permitido',
    })
  })

  test("cada llamada devuelve JSON y deja exactamente una línea en out/log.jsonl", async () => {
    await leer_buzon.execute({}, ctx)
    await extraerMensaje("msg-001")
    await extraerMensaje("msg-005")
    await extraerMensaje("../.env")
    const log = await leerLog()
    expect(log.map(({ herramienta, mensaje_id, ok }) => ({ herramienta, mensaje_id, ok }))).toEqual([
      { herramienta: "contratos_leer_buzon", mensaje_id: null, ok: true },
      { herramienta: "contratos_extraer", mensaje_id: "msg-001", ok: true },
      { herramienta: "contratos_extraer", mensaje_id: "msg-005", ok: false },
      { herramienta: "contratos_extraer", mensaje_id: "../.env", ok: false },
    ])
    expect(log[0]?.resumen).toBe("6 pendientes, 1 sin contrato")
    expect(log[1]?.resumen).toBe("CT-2026-015; campos < 0.8: ninguno")
  })
})

describe("sin carpeta del buzón", () => {
  beforeEach(async () => {
    ctx = await crearProyectoTemporal(false)
  })

  afterEach(async () => {
    await rm(ctx.directory, { recursive: true, force: true })
  })

  test("las herramientas no lanzan: ok:false legible y sin rutas absolutas", async () => {
    const buzon = parsear<DatosBuzon>(await leer_buzon.execute({}, ctx))
    const extraccion = await extraerMensaje("msg-001")
    expect(buzon).toEqual({ ok: false, error: "No se encontró la carpeta del buzón (fixtures/reto-02/buzon)" })
    expect(extraccion).toEqual({ ok: false, error: "El mensaje msg-001 no existe en el buzón" })
    for (const resultado of [buzon, extraccion]) {
      if (!resultado.ok) expect(resultado.error).not.toContain(ctx.directory)
    }
    expect(await leerLog()).toHaveLength(2)
  })
})
