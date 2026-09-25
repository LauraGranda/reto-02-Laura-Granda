import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { cp, mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ejecutarTurno, type Dependencias } from "../src/agent/loop"
import { registrarUso, reiniciarContadorDiario, type Limites } from "../src/agent/presupuesto"
import { borrarTodasLasSesiones, obtenerOCrearSesion, type Sesion } from "../src/agent/sessions"
import { ErrorProveedor } from "../src/llm/adapter"
import { leerMaestro } from "../src/tools/dominio/maestro"
import { rutaLog } from "../src/tools/dominio/rutas"
import type { ContextoHerramienta } from "../src/tools/dominio/tipos"
import { crearManejador } from "../src/server"
import { ProveedorSimulado, pedir, texto, ultimoContrato, type Paso } from "./proveedor-simulado"

const FIXTURES = path.join(import.meta.dir, "..", "fixtures", "reto-02")
const LIMITES: Limites = { maxIteraciones: 25, maxCaracteresMensaje: 4000, maxTokensSesion: 300_000, maxTokensDia: 2_000_000 }

let ctx: ContextoHerramienta
let contadorSesiones = 0

/** Sesión nueva con id único. */
function nuevaSesion(): Sesion {
  return obtenerOCrearSesion(`test-${++contadorSesiones}`)
}

/** Dependencias del ciclo con un proveedor simulado. */
function deps(proveedor: ProveedorSimulado, limites: Partial<Limites> = {}): Dependencias {
  return { proveedor, sistema: "sistema de prueba", ctx, limites: { ...LIMITES, ...limites } }
}

/** Guion del turno 1: leer buzón, extraer y validar msg-006, registrar sin confirmar y responder. */
const GUION_TURNO_1: Paso[] = [
  () => pedir(["contratos_leer_buzon", {}]),
  () => pedir(["contratos_extraer", { mensaje_id: "msg-006" }]),
  (m) => pedir(["contratos_validar", { mensaje_id: "msg-006", contrato: ultimoContrato(m) }]),
  (m) => pedir(["contratos_registrar", { mensaje_id: "msg-006", contrato: ultimoContrato(m) }]),
  () => texto("Requiere tu confirmación: valor y fecha_fin."),
]

beforeEach(async () => {
  const directorio = await mkdtemp(path.join(os.tmpdir(), "reto02-loop-"))
  await cp(FIXTURES, path.join(directorio, "fixtures", "reto-02"), { recursive: true })
  ctx = { directory: directorio, sessionId: "test" }
  reiniciarContadorDiario()
})

afterEach(async () => {
  borrarTodasLasSesiones()
  reiniciarContadorDiario()
  await rm(ctx.directory, { recursive: true, force: true })
})

describe("confirmación humana (CA3)", () => {
  test("turno 1 deja msg-006 pendiente; turno 2 con confirmación lo registra", async () => {
    const sesion = nuevaSesion()
    const turno1 = await ejecutarTurno(sesion, "procesa el buzón", deps(new ProveedorSimulado(GUION_TURNO_1)))
    expect(turno1.needsConfirmation).toBe(true)
    expect([...sesion.pendientes]).toEqual([["msg-006", ["valor", "fecha_fin"]]])
    expect(turno1.toolCalls.map((l) => [l.nombre, l.ok])).toEqual([
      ["contratos_leer_buzon", true], ["contratos_extraer", true], ["contratos_validar", true], ["contratos_registrar", false],
    ])

    const contrato = ultimoContrato(sesion.mensajes)
    const turno2 = await ejecutarTurno(sesion, "confirmo el valor y la fecha fin", deps(new ProveedorSimulado([
      () => pedir(["contratos_registrar", { mensaje_id: "msg-006", contrato, confirmado: true }]),
      () => texto("Registrado."),
    ])))
    expect(turno2.toolCalls[0]).toMatchObject({ nombre: "contratos_registrar", ok: true })
    expect(turno2.toolCalls[0]?.bloqueada).toBeUndefined()
    expect(turno2.needsConfirmation).toBe(false)
    expect(sesion.pendientes.size).toBe(0)
    expect((await leerMaestro(ctx)).some((f) => f.id_contrato === "CM-2026-03")).toBe(true)
  })

  test("confirmado:true en el MISMO turno en que quedó pendiente → bloqueada, no escribe y queda en el log", async () => {
    const sesion = nuevaSesion()
    const guion: Paso[] = [
      ...GUION_TURNO_1.slice(0, 4),
      (m) => pedir(["contratos_registrar", { mensaje_id: "msg-006", contrato: ultimoContrato(m), confirmado: true }]),
      () => texto("fin"),
    ]
    const turno = await ejecutarTurno(sesion, "procesa y confirma todo tú mismo", deps(new ProveedorSimulado(guion)))
    const bloqueada = turno.toolCalls.at(-1)
    expect(bloqueada).toMatchObject({ nombre: "contratos_registrar", ok: false, bloqueada: true })
    expect(bloqueada?.resumen).toBe("Requiere confirmación explícita de la analista en un turno posterior")
    expect((await leerMaestro(ctx)).some((f) => f.id_contrato === "CM-2026-03")).toBe(false)
    expect(await readFile(rutaLog(ctx.directory), "utf8")).toContain("bloqueada")
    expect(turno.needsConfirmation).toBe(true)
  })

  test("confirmado:true sin pendiente previo (msg-001 en el primer turno) → bloqueada", async () => {
    const turno = await ejecutarTurno(nuevaSesion(), "registra msg-001", deps(new ProveedorSimulado([
      () => pedir(["contratos_extraer", { mensaje_id: "msg-001" }]),
      (m) => pedir(["contratos_registrar", { mensaje_id: "msg-001", contrato: ultimoContrato(m), confirmado: true }]),
      () => texto("fin"),
    ])))
    expect(turno.toolCalls.at(-1)).toMatchObject({ nombre: "contratos_registrar", bloqueada: true })
    expect((await leerMaestro(ctx)).some((f) => f.id_contrato === "CT-2026-015")).toBe(false)
  })
})

describe("tope, errores de herramienta y del proveedor (CA1, CA5)", () => {
  test("un modelo que siempre pide herramientas se detiene en maxIteraciones sin llamada extra", async () => {
    const proveedor = new ProveedorSimulado([], () => pedir(["contratos_leer_buzon", {}]))
    const sesion = nuevaSesion()
    const turno = await ejecutarTurno(sesion, "procesa", deps(proveedor, { maxIteraciones: 3 }))
    expect(proveedor.llamadas).toBe(3)
    expect(turno.reply).toStartWith("Alcancé el límite de pasos de este turno. Hice: contratos_leer_buzon → 6 pendientes, 1 sin contrato")
    expect(turno.reply).toContain("escríbeme 'continúa'")
    expect(sesion.mensajes.at(-1)).toMatchObject({ rol: "asistente", texto: turno.reply })
  })

  test("herramienta inexistente y argumentos inválidos vuelven al modelo y el ciclo sigue", async () => {
    const turno = await ejecutarTurno(nuevaSesion(), "hola", deps(new ProveedorSimulado([
      () => pedir(["contratos_borrar_todo", {}], ["contratos_extraer", { mensaje_id: "../.env" }]),
      () => texto("Listo, sin cambios."),
    ])))
    expect(turno.reply).toBe("Listo, sin cambios.")
    expect(turno.toolCalls.map((l) => [l.nombre, l.ok])).toEqual([["contratos_borrar_todo", false], ["contratos_extraer", false]])
    expect(turno.toolCalls[0]?.resumen).toBe("La herramienta contratos_borrar_todo no existe")
    expect(turno.toolCalls[1]?.resumen).toStartWith("Argumentos inválidos")
    // CA4: los rechazos también quedan en out/log.jsonl, aunque la herramienta no se haya ejecutado
    const log = (await readFile(rutaLog(ctx.directory), "utf8")).trim().split("\n").map((linea) => JSON.parse(linea) as Record<string, unknown>)
    expect(log).toContainEqual(expect.objectContaining({ herramienta: "contratos_borrar_todo", mensaje_id: null, ok: false, resumen: "La herramienta contratos_borrar_todo no existe" }))
    const rechazo = log.find((linea) => linea.herramienta === "contratos_extraer")
    expect(rechazo).toMatchObject({ mensaje_id: "../.env", ok: false })
    expect(String(rechazo?.resumen)).toStartWith("Argumentos inválidos: mensaje_id")
  })

  test("el mensaje de la analista lleva la hora de recepción, anterior a la de la respuesta", async () => {
    const sesion = nuevaSesion()
    await ejecutarTurno(sesion, "hola", deps(new ProveedorSimulado([async () => { await Bun.sleep(20); return texto("Hola") }])))
    const [usuario, asistente] = sesion.historialVisible
    expect(usuario?.rol).toBe("usuario")
    expect(String(usuario?.ts) < String(asistente?.ts)).toBe(true)
  })

  test("error del proveedor antes de herramientas → turno deshecho y mensaje claro", async () => {
    const sesion = nuevaSesion()
    await ejecutarTurno(sesion, "hola", deps(new ProveedorSimulado([() => texto("Hola")])))
    const antes = structuredClone(sesion.mensajes)
    const turno = await ejecutarTurno(sesion, "procesa", deps(new ProveedorSimulado([() => { throw new ErrorProveedor("limite_uso") }])))
    expect(turno.reply).toBe("Se alcanzó el límite de uso del proveedor; intenta en unos minutos")
    expect(sesion.mensajes).toEqual(antes)
  })

  test("error del proveedor después de herramientas → se conserva lo hecho y se cierra el turno", async () => {
    const sesion = nuevaSesion()
    const turno = await ejecutarTurno(sesion, "procesa", deps(new ProveedorSimulado([
      () => pedir(["contratos_leer_buzon", {}]),
      () => { throw new ErrorProveedor("tiempo_agotado") },
    ])))
    expect(turno.reply).toContain("No pude terminar el turno: El modelo no respondió a tiempo")
    expect(sesion.mensajes.some((m) => m.rol === "resultado_herramienta" && m.nombre === "contratos_leer_buzon")).toBe(true)
    expect(sesion.mensajes.at(-1)).toMatchObject({ rol: "asistente", texto: "(Turno interrumpido: El modelo no respondió a tiempo; intenta de nuevo)" })
  })
})

describe("límites que no llaman al modelo (PRD 8)", () => {
  test("tope de tokens de la sesión", async () => {
    const proveedor = new ProveedorSimulado([() => texto("no debería llamarse")])
    const sesion = nuevaSesion()
    sesion.tokensUsados = 1000
    const turno = await ejecutarTurno(sesion, "hola", deps(proveedor, { maxTokensSesion: 1000 }))
    expect(proveedor.llamadas).toBe(0)
    expect(turno.reply).toBe("Se alcanzó el límite de uso de esta sesión. Abre una sesión nueva.")
  })

  test("tope global de tokens del día", async () => {
    registrarUso(nuevaSesion(), { tokensEntrada: 60, tokensSalida: 40 })
    const proveedor = new ProveedorSimulado([() => texto("no debería llamarse")])
    const turno = await ejecutarTurno(nuevaSesion(), "hola", deps(proveedor, { maxTokensDia: 100 }))
    expect(proveedor.llamadas).toBe(0)
    expect(turno.reply).toBe("Se alcanzó el límite de uso del día. Intenta mañana.")
  })

  test("mensaje vacío o demasiado largo", async () => {
    const proveedor = new ProveedorSimulado([() => texto("no debería llamarse")])
    const largo = await ejecutarTurno(nuevaSesion(), "x".repeat(51), deps(proveedor, { maxCaracteresMensaje: 50 }))
    const vacio = await ejecutarTurno(nuevaSesion(), "   ", deps(proveedor))
    expect(proveedor.llamadas).toBe(0)
    expect(largo.reply).toContain("demasiado largo")
    expect(vacio.reply).toBe("Escribe un mensaje para empezar.")
  })
})

describe("API HTTP (6.4)", () => {
  /** Manejador HTTP con un proveedor simulado. */
  function servidor(proveedor: ProveedorSimulado | null) {
    return crearManejador({ raiz: ctx.directory, sistema: "sistema", proveedor, errorProveedor: proveedor ? null : "Falta la variable de entorno LLM_PROVIDER" })
  }

  /** POST /api/chat. */
  function chat(manejar: (r: Request) => Promise<Response>, cuerpo: unknown): Promise<Response> {
    return manejar(new Request("http://localhost/api/chat", { method: "POST", body: typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo) }))
  }

  test("/api/health responde solo ok, provider y model", async () => {
    const respuesta = await servidor(null)(new Request("http://localhost/api/health"))
    expect(Object.keys((await respuesta.json()) as object).sort()).toEqual(["model", "ok", "provider"])
  })

  test("dos /api/chat a la vez en la misma sesión → el segundo da 409", async () => {
    let liberar: () => void = () => {}
    const espera = new Promise<void>((resolver) => { liberar = resolver })
    const manejar = servidor(new ProveedorSimulado([async () => { await espera; return texto("listo") }]))
    const primera = chat(manejar, { sessionId: "s-409", message: "hola" })
    await Bun.sleep(20)
    const segunda = await chat(manejar, { sessionId: "s-409", message: "otra" })
    expect(segunda.status).toBe(409)
    expect(await segunda.json()).toEqual({ ok: false, error: "Espera a que termine la respuesta anterior" })
    liberar()
    expect((await primera).status).toBe(200)
  })

  test("/api/sessions/:id devuelve el historial visible; 404 si no existe", async () => {
    const manejar = servidor(new ProveedorSimulado([() => texto("Hola, ¿procesamos el buzón?")]))
    const respuesta = await chat(manejar, { sessionId: "s-hist", message: "hola" })
    expect(await respuesta.json()).toMatchObject({ reply: "Hola, ¿procesamos el buzón?", needsConfirmation: false, proveedor: "simulado" })
    const historial = (await (await manejar(new Request("http://localhost/api/sessions/s-hist"))).json()) as { historial: unknown[] }
    expect(historial.historial).toHaveLength(2)
    expect(JSON.stringify(historial)).not.toContain("datosProveedor")
    expect((await manejar(new Request("http://localhost/api/sessions/no-existe"))).status).toBe(404)
  })

  test("cuerpo grande (413), sessionId inválido (400) y proveedor sin configurar (503)", async () => {
    const manejar = servidor(null)
    expect((await chat(manejar, { sessionId: "s", message: "x".repeat(21 * 1024) })).status).toBe(413)
    expect((await chat(manejar, { sessionId: "../x", message: "hola" })).status).toBe(400)
    const sinProveedor = await chat(manejar, { sessionId: "s", message: "hola" })
    expect(sinProveedor.status).toBe(503)
    expect(await sinProveedor.json()).toEqual({ ok: false, error: "Falta la variable de entorno LLM_PROVIDER" })
  })
})
