import { describe, expect, spyOn, test } from "bun:test"
import { APIConnectionTimeoutError, AuthenticationError, RateLimitError } from "@anthropic-ai/sdk"
import { ApiError, ThinkingLevel, type Part } from "@google/genai"
import { z } from "zod"
import { ErrorProveedor, type MensajeConversacion, type TipoErrorProveedor } from "../src/llm/adapter"
import { aMensajesAnthropic, desdeRespuestaAnthropic, mapearErrorAnthropic } from "../src/llm/anthropic"
import { crearProveedor, describirProveedor, leerOpciones } from "../src/llm/fabrica"
import { aContenidosGemini, aHerramientasGemini, configuracionGemini, desdeRespuestaGemini, limpiarEsquema, mapearErrorGemini, ProveedorGemini } from "../src/llm/gemini"
import { validar } from "../src/tools/contratos"

const CLAVE_FALSA = "sk-FALSA-123"

/** Parts originales de Gemini 3 con razonamiento firmado y una llamada a función. */
const PARTS_GEMINI: Part[] = [
  { text: "Pensando…", thought: true, thoughtSignature: "firma-1" },
  { functionCall: { id: "llamada-1", name: "contratos_leer_buzon", args: {} }, thoughtSignature: "firma-2" },
]

/** Dos resultados de herramienta seguidos. */
const RESULTADOS: MensajeConversacion[] = [
  { rol: "resultado_herramienta", idLlamada: "a-1", nombre: "contratos_extraer", contenido: '{"ok":true,"data":{"x":1}}' },
  { rol: "resultado_herramienta", idLlamada: "a-2", nombre: "contratos_extraer", contenido: "texto plano" },
]

/** Busca recursivamente una clave en un valor JSON. */
function contieneClave(valor: unknown, clave: string): boolean {
  if (Array.isArray(valor)) return valor.some((v) => contieneClave(v, clave))
  if (typeof valor !== "object" || valor === null) return false
  return Object.entries(valor).some(([k, v]) => k === clave || contieneClave(v, clave))
}

describe("Gemini", () => {
  test("las parts propias (con thoughtSignature) se reenvían idénticas", () => {
    const historial: MensajeConversacion[] = [
      { rol: "usuario", texto: "procesa el buzón" },
      { rol: "asistente", texto: "", llamadas: [], datosProveedor: { proveedor: "gemini", datos: PARTS_GEMINI } },
    ]
    expect(aContenidosGemini(historial)[1]).toEqual({ role: "model", parts: PARTS_GEMINI })
  })

  test("desdeRespuestaGemini: functionCall → LlamadaHerramienta, id estable si falta, tokens de razonamiento en la salida", () => {
    const respuesta = desdeRespuestaGemini({
      candidates: [{ content: { role: "model", parts: [...PARTS_GEMINI, { functionCall: { name: "contratos_extraer", args: { mensaje_id: "msg-001" } } }, { text: "Listo" }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30 },
    })
    expect(respuesta.texto).toBe("Listo")
    expect(respuesta.llamadas).toEqual([
      { id: "llamada-1", nombre: "contratos_leer_buzon", argumentos: {} },
      { id: "sin-id-2-contratos_extraer", nombre: "contratos_extraer", argumentos: { mensaje_id: "msg-001" } },
    ])
    expect(respuesta.uso).toEqual({ tokensEntrada: 100, tokensSalida: 50 })
    expect(respuesta.datosProveedor).toEqual({ proveedor: "gemini", datos: expect.arrayContaining(PARTS_GEMINI) })
  })

  test("limpiarEsquema quita $schema y additionalProperties anidados del esquema real de una herramienta", () => {
    const esquema = z.toJSONSchema(z.object(validar.args))
    expect(contieneClave(esquema, "additionalProperties")).toBe(true)
    const limpio = limpiarEsquema(esquema)
    expect(contieneClave(limpio, "additionalProperties")).toBe(false)
    expect(contieneClave(limpio, "$schema")).toBe(false)
    const [herramienta] = aHerramientasGemini([{ nombre: "contratos_validar", descripcion: "d", parametros: { type: "object", additionalProperties: false } }])
    expect(herramienta?.functionDeclarations?.[0]).toEqual({ name: "contratos_validar", description: "d", parametersJsonSchema: { type: "object" } })
  })

  test("resultados consecutivos van en un solo turno; los ids generados no se reenvían", () => {
    const contenidos = aContenidosGemini([...RESULTADOS, { rol: "resultado_herramienta", idLlamada: "sin-id-0-x", nombre: "x", contenido: "{}" }])
    expect(contenidos).toHaveLength(1)
    expect(contenidos[0]?.parts?.map((p) => p.functionResponse)).toEqual([
      { id: "a-1", name: "contratos_extraer", response: { ok: true, data: { x: 1 } } },
      { id: "a-2", name: "contratos_extraer", response: { resultado: "texto plano" } },
      { name: "x", response: {} },
    ])
  })

  test("un historial de otro proveedor se construye con functionCall y firma de relleno", () => {
    const [contenido] = aContenidosGemini([
      { rol: "asistente", texto: "", llamadas: [{ id: "toolu_1", nombre: "contratos_leer_buzon", argumentos: {} }], datosProveedor: { proveedor: "anthropic", datos: [] } },
    ])
    expect(contenido?.parts).toEqual([
      { functionCall: { id: "toolu_1", name: "contratos_leer_buzon", args: {} }, thoughtSignature: "skip_thought_signature_validator" },
    ])
  })
})

describe("Anthropic", () => {
  test("dos resultados consecutivos quedan en un solo mensaje de usuario", () => {
    const mensajes = aMensajesAnthropic(RESULTADOS)
    expect(mensajes).toEqual([
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "a-1", content: '{"ok":true,"data":{"x":1}}' },
          { type: "tool_result", tool_use_id: "a-2", content: "texto plano" },
        ],
      },
    ])
  })

  test("tool_use → LlamadaHerramienta y los bloques propios (thinking) se conservan", () => {
    const respuesta = desdeRespuestaAnthropic({
      content: [
        { type: "thinking", thinking: "razono", signature: "firma" },
        { type: "text", text: "Voy a leer el buzón.", citations: null },
        { type: "tool_use", id: "toolu_1", name: "contratos_leer_buzon", input: {}, caller: { type: "direct" } },
      ],
      usage: { input_tokens: 80, output_tokens: 40 },
    })
    expect(respuesta.llamadas).toEqual([{ id: "toolu_1", nombre: "contratos_leer_buzon", argumentos: {} }])
    expect(respuesta.uso).toEqual({ tokensEntrada: 80, tokensSalida: 40 })
    const [asistente] = aMensajesAnthropic([{ rol: "asistente", texto: respuesta.texto, llamadas: respuesta.llamadas, datosProveedor: respuesta.datosProveedor }])
    expect(asistente?.content).toEqual([
      { type: "thinking", thinking: "razono", signature: "firma" },
      { type: "text", text: "Voy a leer el buzón." },
      { type: "tool_use", id: "toolu_1", name: "contratos_leer_buzon", input: {} },
    ])
  })

  test("un historial con datosProveedor de Gemini se traduce desde texto y llamadas", () => {
    const historial: MensajeConversacion[] = [
      { rol: "usuario", texto: "hola" },
      { rol: "asistente", texto: "", llamadas: [{ id: "sin-id-0-contratos_leer_buzon", nombre: "contratos_leer_buzon", argumentos: {} }], datosProveedor: { proveedor: "gemini", datos: PARTS_GEMINI } },
      { rol: "resultado_herramienta", idLlamada: "sin-id-0-contratos_leer_buzon", nombre: "contratos_leer_buzon", contenido: "{}" },
    ]
    expect(aMensajesAnthropic(historial)).toEqual([
      { role: "user", content: "hola" },
      { role: "assistant", content: [{ type: "tool_use", id: "sin-id-0-contratos_leer_buzon", name: "contratos_leer_buzon", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "sin-id-0-contratos_leer_buzon", content: "{}" }] },
    ])
  })
})

describe("cambio de proveedor entre turnos (datosProveedor con dueño)", () => {
  test("historial creado con Gemini enviado a Anthropic, y creado con Anthropic enviado a Gemini", () => {
    const respuestaGemini = desdeRespuestaGemini({
      candidates: [{ content: { role: "model", parts: PARTS_GEMINI } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    })
    const respuestaClaude = desdeRespuestaAnthropic({
      content: [
        { type: "thinking", thinking: "razono", signature: "firma" },
        { type: "tool_use", id: "toolu_9", name: "contratos_alertas", input: { hoy: "2026-09-03" }, caller: { type: "direct" } },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    const historial: MensajeConversacion[] = [
      { rol: "usuario", texto: "procesa el buzón" },
      { rol: "asistente", texto: respuestaGemini.texto, llamadas: respuestaGemini.llamadas, datosProveedor: respuestaGemini.datosProveedor },
      { rol: "resultado_herramienta", idLlamada: "llamada-1", nombre: "contratos_leer_buzon", contenido: '{"ok":true,"data":{}}' },
      { rol: "asistente", texto: respuestaClaude.texto, llamadas: respuestaClaude.llamadas, datosProveedor: respuestaClaude.datosProveedor },
      { rol: "resultado_herramienta", idLlamada: "toolu_9", nombre: "contratos_alertas", contenido: '{"ok":true,"data":{}}' },
    ]
    const paraClaude = aMensajesAnthropic(historial)
    const paraGemini = aContenidosGemini(historial)
    // Claude: el turno de Gemini se reconstruye desde las llamadas (sin parts ni firmas de Gemini); el suyo conserva thinking
    expect(paraClaude[1]?.content).toEqual([{ type: "tool_use", id: "llamada-1", name: "contratos_leer_buzon", input: {} }])
    expect(paraClaude[3]?.content).toEqual([
      { type: "thinking", thinking: "razono", signature: "firma" },
      { type: "tool_use", id: "toolu_9", name: "contratos_alertas", input: { hoy: "2026-09-03" } },
    ])
    // Gemini: su turno vuelve con las parts originales; el de Claude, desde las llamadas con firma de relleno
    expect(paraGemini[1]).toEqual({ role: "model", parts: PARTS_GEMINI })
    expect(paraGemini[3]?.parts).toEqual([
      { functionCall: { id: "toolu_9", name: "contratos_alertas", args: { hoy: "2026-09-03" } }, thoughtSignature: "skip_thought_signature_validator" },
    ])
  })
})

describe("nivel de pensamiento de Gemini", () => {
  const opciones = { timeoutMs: 1000, maxTokensRespuesta: 2048, esfuerzo: "bajo" as const }

  test("modelo gemini-3.x → thinkingLevel; otro modelo → se omite", () => {
    expect(configuracionGemini({ ...opciones, modelo: "gemini-3.8-flash" }, "s", []).thinkingConfig).toEqual({ thinkingLevel: ThinkingLevel.LOW })
    expect(configuracionGemini({ ...opciones, modelo: "gemini-2.5-flash" }, "s", [])).not.toHaveProperty("thinkingConfig")
  })

  test("con un modelo sin nivel de pensamiento se advierte una sola vez, al crear el proveedor", () => {
    const aviso = spyOn(console, "warn").mockImplementation(() => {})
    try {
      new ProveedorGemini({ ...opciones, modelo: "gemini-2.5-flash", apiKey: CLAVE_FALSA })
      new ProveedorGemini({ ...opciones, modelo: "gemini-3.8-flash", apiKey: CLAVE_FALSA })
      expect(aviso).toHaveBeenCalledTimes(1)
      expect(String(aviso.mock.calls[0]?.[0])).toContain("gemini-2.5-flash")
      expect(String(aviso.mock.calls[0]?.[0])).not.toContain(CLAVE_FALSA)
    } finally {
      aviso.mockRestore()
    }
  })
})

describe("fábrica", () => {
  const base = { LLM_PROVIDER: "gemini", LLM_MODEL: "gemini-3.8-flash", GEMINI_API_KEY: CLAVE_FALSA }

  /** Ejecuta crearProveedor y devuelve el ErrorProveedor que lanza. */
  function errorDe(env: Record<string, string | undefined>): ErrorProveedor {
    try {
      crearProveedor(env)
    } catch (error) {
      if (error instanceof ErrorProveedor) return error
    }
    throw new Error("se esperaba un ErrorProveedor")
  }

  test("LLM_PROVIDER inválido, clave faltante o esfuerzo inválido → error que nombra la variable", () => {
    expect(errorDe({ ...base, LLM_PROVIDER: "openai" }).message).toContain("LLM_PROVIDER")
    expect(errorDe({ ...base, GEMINI_API_KEY: "" }).message).toBe("Falta la variable de entorno GEMINI_API_KEY")
    expect(errorDe({ ...base, LLM_PROVIDER: "anthropic" }).message).toBe("Falta la variable de entorno ANTHROPIC_API_KEY")
    expect(errorDe({ ...base, LLM_MODEL: " " }).message).toBe("Falta la variable de entorno LLM_MODEL")
    expect(errorDe({ ...base, LLM_ESFUERZO: "maximo" }).message).toContain("LLM_ESFUERZO")
    expect(errorDe({ ...base, LLM_TIMEOUT_MS: "-5" }).message).toContain("LLM_TIMEOUT_MS")
    expect(errorDe({ ...base, LLM_PROVIDER: "openai" }).tipo).toBe("configuracion")
  })

  test("opciones por defecto y proveedor creado sin red", () => {
    expect(leerOpciones(base).opciones).toMatchObject({ timeoutMs: 60000, maxTokensRespuesta: 2048, esfuerzo: "bajo" })
    const proveedor = crearProveedor({ ...base, LLM_ESFUERZO: "alto" })
    expect([proveedor.nombre, proveedor.modelo]).toEqual(["gemini", "gemini-3.8-flash"])
  })

  test("describirProveedor no lee claves y marca sin_configurar", () => {
    expect(describirProveedor({})).toEqual({ provider: "sin_configurar", model: "sin_configurar" })
    expect(describirProveedor({ LLM_PROVIDER: "openai", LLM_MODEL: "x" })).toEqual({ provider: "sin_configurar", model: "x" })
    expect(describirProveedor(base)).toEqual({ provider: "gemini", model: "gemini-3.8-flash" })
    expect(JSON.stringify(describirProveedor(base))).not.toContain(CLAVE_FALSA)
  })
})

describe("errores del SDK → ErrorProveedor, sin exponer la clave", () => {
  const headers = new Headers({ "x-api-key": CLAVE_FALSA })
  const cuerpo = { error: { message: `invalid x-api-key ${CLAVE_FALSA}` } }

  test("Gemini: 401, 429 y timeout", () => {
    const casos: [unknown, TipoErrorProveedor][] = [
      [new ApiError({ message: `API key not valid: ${CLAVE_FALSA}`, status: 401 }), "autenticacion"],
      [new ApiError({ message: `quota ${CLAVE_FALSA}`, status: 429 }), "limite_uso"],
      [new DOMException(`timeout ${CLAVE_FALSA}`, "TimeoutError"), "tiempo_agotado"],
      [new ApiError({ message: "bad", status: 400 }), "solicitud_invalida"],
      [new Error(`red caída ${CLAVE_FALSA}`), "otro"],
    ]
    for (const [error, tipo] of casos) {
      const mapeado = mapearErrorGemini(error)
      expect(mapeado.tipo).toBe(tipo)
      expect(mapeado.message).not.toContain(CLAVE_FALSA)
    }
  })

  test("Anthropic: 401, 429 y timeout", () => {
    const casos: [unknown, TipoErrorProveedor][] = [
      [new AuthenticationError(401, cuerpo, `invalid ${CLAVE_FALSA}`, headers), "autenticacion"],
      [new RateLimitError(429, cuerpo, `rate ${CLAVE_FALSA}`, headers), "limite_uso"],
      [new APIConnectionTimeoutError({ message: `timeout ${CLAVE_FALSA}` }), "tiempo_agotado"],
    ]
    for (const [error, tipo] of casos) {
      const mapeado = mapearErrorAnthropic(error)
      expect(mapeado.tipo).toBe(tipo)
      expect(mapeado.message).not.toContain(CLAVE_FALSA)
      expect(JSON.stringify(mapeado)).not.toContain(CLAVE_FALSA)
    }
  })

  test("los errores de configuración tampoco muestran valores", () => {
    const env = { LLM_PROVIDER: "gemini", LLM_MODEL: "m", GEMINI_API_KEY: CLAVE_FALSA, LLM_ESFUERZO: CLAVE_FALSA }
    expect(() => crearProveedor(env)).toThrow(ErrorProveedor)
    try {
      crearProveedor(env)
    } catch (error) {
      expect(String(error)).not.toContain(CLAVE_FALSA)
    }
  })
})
