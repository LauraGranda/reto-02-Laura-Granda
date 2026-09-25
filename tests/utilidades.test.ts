import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { diasEntre, esFechaValida, fechaDeRegistro, fechaHoyISO, sumarDias, sumarMeses } from "../src/tools/dominio/fechas"
import {
  agregarHistorial,
  crearSlugCliente,
  escribirMaestro,
  leerMaestro,
  leerProcesados,
  marcarProcesado,
} from "../src/tools/dominio/maestro"
import { registrarEnLog } from "../src/tools/dominio/registro-log"
import { rutaHistorial, rutaLog, rutaMaestroFixture, rutaMaestroSalida } from "../src/tools/dominio/rutas"
import { COLUMNAS_MAESTRO, type ContextoHerramienta } from "../src/tools/dominio/tipos"

const RAIZ_PROYECTO = path.join(import.meta.dir, "..")

describe("fechas", () => {
  test("sumarMeses conserva el día o usa el último del mes", () => {
    expect(sumarMeses("2026-08-31", 12)).toBe("2027-08-31")
    expect(sumarMeses("2026-01-31", 1)).toBe("2026-02-28")
    expect(sumarMeses("2028-01-31", 1)).toBe("2028-02-29")
    expect(sumarMeses("2026-11-15", 3)).toBe("2027-02-15")
  })

  test("diasEntre y sumarDias cubren el límite de alertas de 60 días", () => {
    expect(diasEntre("2026-09-03", "2026-11-02")).toBe(60)
    expect(diasEntre("2026-11-02", "2026-09-03")).toBe(-60)
    expect(sumarDias("2026-09-03", 60)).toBe("2026-11-02")
  })

  test("fechaDeRegistro usa la fecha del contexto solo si es válida", () => {
    expect(fechaDeRegistro({ fechaActual: "2026-09-03" })).toBe("2026-09-03")
    expect(fechaDeRegistro({})).toBe(fechaHoyISO())
    expect(fechaDeRegistro({ fechaActual: "2026-02-30" })).toBe(fechaHoyISO())
  })

  test("esFechaValida rechaza formatos y fechas imposibles", () => {
    expect(esFechaValida("2026-02-28")).toBe(true)
    expect(esFechaValida("2026-02-29")).toBe(false)
    expect(esFechaValida("2026-13-01")).toBe(false)
    expect(esFechaValida("31/08/2026")).toBe(false)
    expect(() => sumarMeses("2026-02-30", 1)).toThrow("Fecha inválida")
  })
})

describe("crearSlugCliente", () => {
  test("casos del buzón", () => {
    expect(crearSlugCliente("Industrias Delta S.A.S.")).toBe("industrias-delta")
    expect(crearSlugCliente("Corporación Andina de Servicios S.A.")).toBe("corporacion-andina-de-servicios")
    expect(crearSlugCliente("Minera Los Andes S.A.C.")).toBe("minera-los-andes")
    expect(crearSlugCliente("Distribuidora Caribe S.A.S.")).toBe("distribuidora-caribe")
  })

  test("coincide con la carpeta de cada fila del maestro del fixture", async () => {
    const ctx = { directory: RAIZ_PROYECTO, sessionId: "test" }
    const texto = await readFile(rutaMaestroFixture(ctx.directory), "utf8")
    const filas = texto.replace(/\r\n/g, "\n").trim().split("\n").slice(1)
    for (const fila of filas) {
      const [, cliente] = fila.split(",")
      const carpeta = fila.split(",")[13]?.split("/")[2]
      expect(crearSlugCliente(cliente ?? "")).toBe(carpeta ?? "")
    }
  })
})

describe("archivos en out/", () => {
  let ctx: ContextoHerramienta

  beforeEach(async () => {
    const directorio = await mkdtemp(path.join(os.tmpdir(), "reto02-"))
    ctx = { directory: directorio, sessionId: "test" }
    await mkdir(path.dirname(rutaMaestroFixture(directorio)), { recursive: true })
    await copyFile(rutaMaestroFixture(RAIZ_PROYECTO), rutaMaestroFixture(directorio))
  })

  afterEach(async () => {
    await rm(ctx.directory, { recursive: true, force: true })
  })

  test("leerMaestro copia el fixture y devuelve sus filas tipadas", async () => {
    const filas = await leerMaestro(ctx)
    expect(filas).toHaveLength(8)
    const minera = filas.find((fila) => fila.id_contrato === "CT-2026-011")
    expect(minera?.valor).toBe(350000)
    expect(minera?.requiere_poliza).toBe(true)
    expect(filas.find((fila) => fila.pais === "HN")?.nit_cliente).toBe("08019995123456")
  })

  test("escribirMaestro mantiene el orden de columnas y deja el CSV idéntico al fixture", async () => {
    const filas = await leerMaestro(ctx)
    await escribirMaestro(ctx, filas)
    const escrito = await readFile(rutaMaestroSalida(ctx.directory), "utf8")
    const fixture = await readFile(rutaMaestroFixture(ctx.directory), "utf8")
    expect(escrito.split("\n")[0]).toBe(COLUMNAS_MAESTRO.join(","))
    expect(escrito).toBe(fixture.replace(/\r\n/g, "\n"))
  })

  test("procesados, historial y log escriben en out/", async () => {
    await marcarProcesado(ctx, "msg-004", { clasificacion: "duplicado", accion: "sin_escritura" })
    expect((await leerProcesados(ctx))["msg-004"]?.clasificacion).toBe("duplicado")

    const cambios = { fecha_fin: { antes: "2027-05-01", despues: "2027-11-01" } }
    await agregarHistorial(ctx, { id_contrato: "CT-2026-011", accion: "actualizado", cambios, mensaje_id: "msg-003" })
    const historial = JSON.parse(await readFile(rutaHistorial(ctx.directory), "utf8"))
    expect(historial.cambios).toEqual(cambios)

    await registrarEnLog(ctx, { herramienta: "contratos_leer_buzon", mensaje_id: null, ok: true, resumen: "6 mensajes" })
    const log = JSON.parse(await readFile(rutaLog(ctx.directory), "utf8"))
    expect(log.ok).toBe(true)
    expect(typeof log.ts).toBe("string")
  })
})
