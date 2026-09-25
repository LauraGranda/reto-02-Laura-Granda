import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { cp, mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { extraer, validar } from "../src/tools/contratos"
import { similitudObjeto, validarContrato } from "../src/tools/dominio/clasificacion"
import { escribirMaestro, leerMaestro } from "../src/tools/dominio/maestro"
import { rutaMaestroFixture } from "../src/tools/dominio/rutas"
import type {
  ContextoHerramienta,
  ContratoExtraido,
  FilaMaestro,
  ResultadoHerramienta,
  ResultadoValidacion,
} from "../src/tools/dominio/tipos"

const FIXTURES_REALES = path.join(import.meta.dir, "..", "fixtures", "reto-02")

let ctx: ContextoHerramienta

/** Extrae un mensaje con la herramienta y devuelve el contrato (exige ok). */
async function extraerContratoDe(mensajeId: string): Promise<ContratoExtraido> {
  const resultado = JSON.parse(await extraer.execute({ mensaje_id: mensajeId }, ctx)) as ResultadoHerramienta<{ contrato: ContratoExtraido }>
  if (!resultado.ok) throw new Error(resultado.error)
  return resultado.data.contrato
}

/** Llama a validar con un contrato cualquiera (incluso inválido) y parsea la respuesta. */
async function validarCon(mensajeId: string, contrato: unknown): Promise<ResultadoHerramienta<ResultadoValidacion>> {
  const respuesta = await validar.execute({ mensaje_id: mensajeId, contrato } as { mensaje_id: string; contrato: ContratoExtraido }, ctx)
  return JSON.parse(respuesta) as ResultadoHerramienta<ResultadoValidacion>
}

/** Flujo del agente: extraer y validar lo extraído (exige ok). */
async function extraerYValidar(mensajeId: string): Promise<ResultadoValidacion> {
  const resultado = await validarCon(mensajeId, await extraerContratoDe(mensajeId))
  if (!resultado.ok) throw new Error(resultado.error)
  return resultado.data
}

beforeEach(async () => {
  const directorio = await mkdtemp(path.join(os.tmpdir(), "reto02-validar-"))
  await cp(FIXTURES_REALES, path.join(directorio, "fixtures", "reto-02"), { recursive: true })
  ctx = { directory: directorio, sessionId: "test" }
})

afterEach(async () => {
  await rm(ctx.directory, { recursive: true, force: true })
})

describe("flujo extraer → validar de los mensajes del buzón", () => {
  test("msg-001: nuevo, sin revisión, comercial registrado", async () => {
    const resultado = await extraerYValidar("msg-001")
    expect(resultado).toMatchObject({ clasificacion: "nuevo", id_contrato_existente: null, requiere_revision: [], conflictos: [] })
    expect(resultado.comercial).toEqual({ email: "lgomez@periferia-ficticia.com", nombre: "Laura Gómez Restrepo", registrado: true })
  })

  test("msg-002: nuevo, sin revisión", async () => {
    const resultado = await extraerYValidar("msg-002")
    expect(resultado).toMatchObject({ clasificacion: "nuevo", requiere_revision: [], conflictos: [] })
  })

  test("msg-003: actualización de CT-2026-011 con fecha_fin, valor y estado_poliza", async () => {
    const resultado = await extraerYValidar("msg-003")
    expect(resultado).toMatchObject({ clasificacion: "actualizacion", id_contrato_existente: "CT-2026-011", requiere_revision: [], conflictos: [] })
    expect(resultado.diferencias).toEqual({
      valor: { antes: "350000", despues: "520000" },
      fecha_fin: { antes: "2027-05-01", despues: "2027-11-01" },
      estado_poliza: { antes: "vigente", despues: "pendiente" },
    })
  })

  test("msg-004: duplicado de CT-2026-012", async () => {
    const resultado = await extraerYValidar("msg-004")
    expect(resultado).toMatchObject({
      clasificacion: "duplicado",
      id_contrato_existente: "CT-2026-012",
      requiere_revision: [],
      diferencias: {},
      motivo: "Ya existe CT-2026-012 con el mismo valor y fechas",
    })
  })

  test("msg-006: nuevo con revisión de valor y fecha_fin; remitente no registrado", async () => {
    const resultado = await extraerYValidar("msg-006")
    expect(resultado).toMatchObject({ clasificacion: "nuevo", requiere_revision: ["valor", "fecha_fin"], conflictos: [] })
    expect(resultado.comercial).toEqual({ email: "jperez@periferia-ficticia.com", nombre: null, registrado: false })
  })
})

describe("reglas adicionales", () => {
  test("idempotencia: con el otrosí ya aplicado en el maestro, msg-003 es duplicado", async () => {
    const filas = await leerMaestro(ctx)
    const aplicadas: FilaMaestro[] = filas.map((fila) =>
      fila.id_contrato === "CT-2026-011" ? { ...fila, fecha_fin: "2027-11-01", valor: 520000, estado_poliza: "pendiente" } : fila,
    )
    await escribirMaestro(ctx, aplicadas)
    const resultado = await extraerYValidar("msg-003")
    expect(resultado).toMatchObject({ clasificacion: "duplicado", motivo: "El otrosí ya está aplicado en el maestro", requiere_revision: [] })
  })

  test("re-extracción: un valor cambiado por el modelo se reporta con ambos valores y va a revisión", async () => {
    const extraido = await extraerContratoDe("msg-004")
    const alterado = { ...extraido, valor: { ...extraido.valor, valor: 250000000 } }
    const resultado = await validarCon("msg-004", alterado)
    if (!resultado.ok) throw new Error(resultado.error)
    expect(resultado.data.conflictos).toContain("valor: recibido 250000000 ≠ extraído 210000000")
    expect(resultado.data.requiere_revision).toContain("valor")
  })

  test("re-extracción: una confianza subida por el modelo no evita la revisión", async () => {
    const extraido = await extraerContratoDe("msg-006")
    const inflado = { ...extraido, valor: { ...extraido.valor, confianza: 0.95 }, fecha_fin: { ...extraido.fecha_fin, confianza: 0.95 } }
    const resultado = await validarCon("msg-006", inflado)
    if (!resultado.ok) throw new Error(resultado.error)
    expect(resultado.data.requiere_revision).toEqual(["valor", "fecha_fin"])
  })

  test("mismo id con otro NIT → conflicto y nit_cliente en revisión", async () => {
    const filas = await leerMaestro(ctx)
    const contrato = await extraerContratoDe("msg-004")
    const otroNit = { ...contrato, nit_cliente: { ...contrato.nit_cliente, valor: "811111111" } }
    const resultado = validarContrato({ recibido: otroNit, extraido: otroNit, filas })
    expect(resultado.conflictos).toContain("CT-2026-012 existe en el maestro con NIT 890903456, pero el contrato trae 811111111")
    expect(resultado.requiere_revision).toContain("nit_cliente")
  })

  test("sin cliente, NIT ni objeto → rechazado con motivo", async () => {
    const filas = await leerMaestro(ctx)
    const contrato = await extraerContratoDe("msg-001")
    const vacio = { valor: null, confianza: 0, evidencia: null }
    const sinPartes = { ...contrato, cliente: vacio, nit_cliente: vacio, objeto: vacio }
    const resultado = validarContrato({ recibido: sinPartes, extraido: sinPartes, filas })
    expect(resultado).toMatchObject({ clasificacion: "rechazado", requiere_revision: [] })
    expect(resultado.motivo).toBe("El documento no identifica a la contraparte (sin cliente ni NIT)")
  })

  test("validar un mensaje sin contrato (msg-005) → rechazado con el motivo del adjunto", async () => {
    const contrato = await extraerContratoDe("msg-001")
    const resultado = await validarCon("msg-005", contrato)
    if (!resultado.ok) throw new Error(resultado.error)
    expect(resultado.data).toMatchObject({
      clasificacion: "rechazado",
      motivo: "El adjunto cotizacion.txt no es un contrato (parece una cotización)",
    })
  })
})

describe("similitud de objeto (RN2)", () => {
  test("textos iguales = 1, distintos del mismo cliente < 0.9", async () => {
    const texto = "Mesa de servicio TI nivel 1 y 2"
    expect(similitudObjeto(texto, texto)).toBe(1)
    const pares: [string, string][] = [
      ["msg-001", "Soporte y mantenimiento plataforma SAP"],
      ["msg-002", "Servicios de arquitectura de nube y migración"],
      ["msg-006", "Desarrollo de portal de pedidos B2B"],
    ]
    for (const [mensajeId, objetoMaestro] of pares) {
      const contrato = await extraerContratoDe(mensajeId)
      expect(similitudObjeto(objetoMaestro, contrato.objeto.valor ?? "")).toBeLessThan(0.9)
    }
  })
})

describe("errores (HU-6) y solo lectura", () => {
  test("moneda fuera de MONEDAS o fecha inexistente → ok:false legible", async () => {
    const contrato = await extraerContratoDe("msg-001")
    const conEur = await validarCon("msg-001", { ...contrato, moneda: { ...contrato.moneda, valor: "EUR" } })
    const conFecha = await validarCon("msg-001", { ...contrato, fecha_fin: { ...contrato.fecha_fin, valor: "2026-02-30" } })
    expect(conEur.ok).toBe(false)
    if (!conEur.ok) expect(conEur.error).toStartWith("Argumentos inválidos: contrato.moneda.valor")
    expect(conFecha.ok).toBe(false)
    if (!conFecha.ok) expect(conFecha.error).toContain("Fecha inexistente")
  })

  test("validar no modifica el maestro del fixture", async () => {
    const antes = await readFile(rutaMaestroFixture(ctx.directory), "utf8")
    for (const mensajeId of ["msg-001", "msg-003", "msg-004", "msg-006"]) await extraerYValidar(mensajeId)
    expect(await readFile(rutaMaestroFixture(ctx.directory), "utf8")).toBe(antes)
  })
})
