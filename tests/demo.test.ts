import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cp, mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ejecutarDemo, type ResumenDemo } from "../demo"
import { leerMaestro } from "../src/tools/dominio/maestro"
import { rutaAlertas } from "../src/tools/dominio/rutas"
import type { ContextoHerramienta } from "../src/tools/dominio/tipos"

const RAIZ = path.join(import.meta.dir, "..")

describe("demo sin modelo (PRD 6.6)", () => {
  let ctx: ContextoHerramienta
  let primera: ResumenDemo
  let alertasPrimera: string

  beforeAll(async () => {
    const directorio = await mkdtemp(path.join(os.tmpdir(), "reto02-demo-"))
    await cp(path.join(RAIZ, "fixtures", "reto-02"), path.join(directorio, "fixtures", "reto-02"), { recursive: true })
    ctx = { directory: directorio, sessionId: "demo", fechaActual: "2026-09-03" }
    primera = await ejecutarDemo(ctx)
    alertasPrimera = await readFile(rutaAlertas(ctx.directory), "utf8")
  })

  afterAll(async () => {
    await rm(ctx.directory, { recursive: true, force: true })
  })

  test("primera pasada: tabla esperada por mensaje", () => {
    expect(primera.filas.map(({ mensaje_id, clasificacion, en_revision, accion, id_contrato }) => [mensaje_id, clasificacion, en_revision, accion, id_contrato])).toEqual([
      ["msg-001", "nuevo", [], "insertado", "CT-2026-015"],
      ["msg-002", "nuevo", [], "insertado", "CT-2026-016"],
      ["msg-003", "actualizacion", [], "actualizado", "CT-2026-011"],
      ["msg-004", "duplicado", [], "sin escritura", "CT-2026-012"],
      ["msg-005", "rechazado", [], "descartado: El adjunto cotizacion.txt no es un contrato (parece una cotización)", null],
      ["msg-006", "nuevo", ["valor", "fecha_fin"], "pendiente de confirmación", "CM-2026-03"],
    ])
  })

  test("avisos: remitente de msg-006 no registrado", () => {
    const aviso =
      "msg-006: el remitente jperez@periferia-ficticia.com no está en comerciales.json; se registró su correo en la columna comercial."
    expect(primera.avisos).toEqual([aviso])
    const inicio = primera.lineas.indexOf("--- Avisos ---")
    expect(primera.lineas[inicio + 1]).toBe(aviso)
  })

  test("segunda pasada: msg-006 confirmado e insertado", () => {
    expect(primera.confirmaciones).toEqual([
      {
        mensaje_id: "msg-006",
        confirmados: "valor = 0, fecha_fin = 2027-08-31",
        accion: "insertado",
        id_contrato: "CM-2026-03",
        ruta_archivo: "Contratos/2026/distribuidora-caribe/CM-2026-03.txt",
      },
    ])
  })

  test("las filas nuevas llevan la fecha de registro fijada y la verificación pasa", async () => {
    const nuevas = (await leerMaestro(ctx)).filter((fila) => ["CT-2026-015", "CT-2026-016", "CM-2026-03"].includes(fila.id_contrato))
    expect(nuevas.map((fila) => fila.fecha_registro)).toEqual(["2026-09-03", "2026-09-03", "2026-09-03"])
    expect(primera.verificacion.ok).toBe(true)
    expect(primera.verificacion.chequeos.every((chequeo) => chequeo.ok)).toBe(true)
    const inicio = primera.lineas.indexOf("--- Verificación ---")
    expect(primera.lineas.slice(inicio)).toEqual([
      "--- Verificación ---",
      "  [OK] 11 filas en el maestro de salida (se esperaban 11)",
      "  [OK] 0 mensajes pendientes en el buzón (se esperaban 0)",
      "  [OK] fixture maestro-contratos.csv sin cambios",
      "  [OK] filas nuevas con fecha_registro 2026-09-03",
      "Verificación OK",
    ])
  })

  test("dos ejecuciones seguidas producen el mismo resumen y el mismo alertas.md", async () => {
    const segunda = await ejecutarDemo(ctx)
    expect(segunda).toEqual(primera)
    expect(await readFile(rutaAlertas(ctx.directory), "utf8")).toBe(alertasPrimera)
  })

  test("demo.ts no depende de src/llm ni de variables de entorno", async () => {
    const codigo = await readFile(path.join(RAIZ, "demo.ts"), "utf8")
    expect(codigo).not.toContain("src/llm")
    expect(codigo).not.toContain("process.env")
  })
})
