import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { cp, mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { alertas, descartar, extraer, registrar } from "../src/tools/contratos"
import {
  contratosPorVencer,
  contratosVencidos,
  formatearValor,
  generarReporteMarkdown,
  type SeccionesAlertas,
} from "../src/tools/dominio/alertas"
import { rutaAlertas, rutaMaestroSalida } from "../src/tools/dominio/rutas"
import type { ContextoHerramienta, ContratoExtraido, FilaMaestro, ResultadoHerramienta } from "../src/tools/dominio/tipos"

const FIXTURES_REALES = path.join(import.meta.dir, "..", "fixtures", "reto-02")
const HOY = "2026-09-03"

type DatosAlertas = SeccionesAlertas & { ruta: string }

let ctx: ContextoHerramienta

/** Ejecuta la herramienta alertas con cualquier `hoy` y parsea la respuesta. */
async function ejecutarAlertas(hoy: string): Promise<ResultadoHerramienta<DatosAlertas>> {
  return JSON.parse(await alertas.execute({ hoy }, ctx)) as ResultadoHerramienta<DatosAlertas>
}

/** Ejecuta alertas exigiendo ok. */
async function alertasOk(hoy = HOY): Promise<DatosAlertas> {
  const resultado = await ejecutarAlertas(hoy)
  if (!resultado.ok) throw new Error(resultado.error)
  return resultado.data
}

/** Procesa el buzón completo con las herramientas, como lo haría el agente. */
async function procesarBuzon(): Promise<void> {
  for (const [mensajeId, confirmado] of [["msg-001", false], ["msg-002", false], ["msg-003", false], ["msg-004", false], ["msg-006", true]] as const) {
    const extraido = JSON.parse(await extraer.execute({ mensaje_id: mensajeId }, ctx)) as ResultadoHerramienta<{ contrato: ContratoExtraido }>
    if (!extraido.ok) throw new Error(extraido.error)
    const registro = JSON.parse(await registrar.execute({ mensaje_id: mensajeId, contrato: extraido.data.contrato, confirmado }, ctx)) as ResultadoHerramienta<unknown>
    if (!registro.ok) throw new Error(`${mensajeId}: ${registro.error}`)
  }
  await descartar.execute({ mensaje_id: "msg-005", motivo: "El adjunto es una cotización, no un contrato" }, ctx)
}

/** Fila sintética para probar los bordes del rango de 60 días. */
function fila(id: string, fechaFin: string): FilaMaestro {
  return {
    id_contrato: id, cliente: "Cliente", nit_cliente: "1", pais: "CO", objeto: "", valor: 1, moneda: "COP",
    fecha_inicio: "2026-01-01", fecha_fin: fechaFin, requiere_poliza: false, tipo_poliza: "", estado_poliza: "no_aplica",
    comercial: "", ruta_sharepoint: "", fecha_registro: "2026-01-01", fuente: "buzon",
  }
}

beforeEach(async () => {
  const directorio = await mkdtemp(path.join(os.tmpdir(), "reto02-alertas-"))
  await cp(FIXTURES_REALES, path.join(directorio, "fixtures", "reto-02"), { recursive: true })
  ctx = { directory: directorio, sessionId: "test" }
})

afterEach(async () => {
  await rm(ctx.directory, { recursive: true, force: true })
})

describe("maestro sin procesar, hoy 2026-09-03", () => {
  test("secciones esperadas según CLAUDE.md", async () => {
    const datos = await alertasOk()
    expect(datos.ruta).toBe("out/alertas.md")
    expect(datos.vencen.map(({ id_contrato, dias_restantes }) => [id_contrato, dias_restantes])).toEqual([["CT-2026-009", 27], ["CT-2026-004", 42]])
    expect(datos.vencen.some((c) => c.id_contrato === "CT-2026-012")).toBe(false)
    expect(datos.polizas_pendientes.map((c) => c.id_contrato)).toEqual(["CT-2026-004"])
    expect(datos.registrados_desde_corte).toEqual([])
    expect(datos.ya_vencidos.map((c) => c.id_contrato)).toEqual(["CT-2025-018", "CT-2026-002"])
    expect(datos.actualizados_desde_corte).toEqual([])
  })

  test("alertas.md: sección vacía con su texto y sin hora de generación", async () => {
    await alertasOk()
    const reporte = await readFile(rutaAlertas(ctx.directory), "utf8")
    expect(reporte).toContain("Fecha de referencia: 2026-09-03")
    expect(reporte).toContain("## Vencen en los próximos 60 días (hasta 2026-11-02)")
    expect(reporte).toContain("Sin contratos en esta categoría.")
    expect(reporte).not.toMatch(/\d{2}:\d{2}/)
  })
})

describe("tras procesar el buzón completo", () => {
  test("pólizas, registrados y actualizados desde el corte", async () => {
    await procesarBuzon()
    const datos = await alertasOk()
    expect(datos.polizas_pendientes.map((c) => c.id_contrato)).toEqual(["CM-2026-03", "CT-2026-004", "CT-2026-011", "CT-2026-015"])
    expect(datos.registrados_desde_corte.map((c) => c.id_contrato)).toEqual(["CM-2026-03", "CT-2026-015", "CT-2026-016"])
    expect(datos.actualizados_desde_corte).toEqual([
      { id_contrato: "CT-2026-011", cliente: "Minera Los Andes S.A.C.", campos_cambiados: ["valor", "fecha_fin", "estado_poliza"], fecha_fin: "2027-11-01" },
    ])
    expect(datos.vencen.map((c) => c.id_contrato)).toEqual(["CT-2026-009", "CT-2026-004"])
  })

  test("dos ejecuciones con la misma fecha dan el mismo alertas.md y no cambian el maestro", async () => {
    await procesarBuzon()
    const maestroAntes = await readFile(rutaMaestroSalida(ctx.directory), "utf8")
    await alertasOk()
    const primero = await readFile(rutaAlertas(ctx.directory), "utf8")
    await alertasOk()
    expect(await readFile(rutaAlertas(ctx.directory), "utf8")).toBe(primero)
    expect(await readFile(rutaMaestroSalida(ctx.directory), "utf8")).toBe(maestroAntes)
  })
})

describe("bordes y formato", () => {
  test("rango de 60 días con ambos extremos incluidos", () => {
    const filas = [fila("HOY", HOY), fila("MAS-60", "2026-11-02"), fila("MAS-61", "2026-11-03"), fila("AYER", "2026-09-02")]
    expect(contratosPorVencer(filas, HOY).map(({ id_contrato, dias_restantes }) => [id_contrato, dias_restantes])).toEqual([
      ["HOY", 0],
      ["MAS-60", 60],
    ])
    expect(contratosVencidos(filas, HOY).map(({ id_contrato, dias_vencido }) => [id_contrato, dias_vencido])).toEqual([["AYER", 1]])
  })

  test("formatearValor con separador de miles manual", () => {
    expect(formatearValor(265000000, "COP")).toBe("COP 265.000.000")
    expect(formatearValor(120000, "USD")).toBe("USD 120.000")
    expect(formatearValor(520000, "PEN")).toBe("PEN 520.000")
    expect(formatearValor(0, "COP")).toBe("COP 0")
    expect(formatearValor(1234.5, "USD")).toBe("USD 1.234,50")
  })

  test("el reporte escapa '|' en las celdas", () => {
    const secciones: SeccionesAlertas = {
      vencen: [], registrados_desde_corte: [], ya_vencidos: [], actualizados_desde_corte: [],
      polizas_pendientes: [{ id_contrato: "X", cliente: "A|B", tipo_poliza: "", estado_poliza: "pendiente", fecha_fin: HOY, comercial: "" }],
    }
    expect(generarReporteMarkdown(secciones, HOY)).toContain("| X | A\\|B |")
  })

  test("fecha inválida → ok:false legible (HU-6)", async () => {
    for (const hoy of ["2026-02-30", "03-09-2026"]) {
      const resultado = await ejecutarAlertas(hoy)
      expect(resultado.ok).toBe(false)
      if (!resultado.ok) expect(resultado.error).toStartWith("Argumentos inválidos: hoy")
    }
  })
})
