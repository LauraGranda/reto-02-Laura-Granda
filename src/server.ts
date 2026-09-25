// Servidor HTTP (Bun.serve): rutas de la API, sirve web/index.html y delega el ciclo a src/agent/loop.ts. Sin reglas de negocio.
import path from "node:path"
import { z } from "zod"
import { ejecutarTurno } from "./agent/loop"
import { borrarTodasLasSesiones, esquemaSessionId, obtenerOCrearSesion, obtenerSesion } from "./agent/sessions"
import { construirSistema } from "./agent/sistema"
import { ErrorProveedor, type ProveedorLLM } from "./llm/adapter"
import { crearProveedor, describirProveedor } from "./llm/fabrica"
import { reiniciarSalida } from "./tools/dominio/registro"

/** Lo que el servidor necesita; se inyecta para probar la API sin red ni claves. */
export type DependenciasServidor = {
  raiz: string
  sistema: string
  proveedor: ProveedorLLM | null
  errorProveedor: string | null
}

type Manejador = (peticion: Request, parametro: string) => Promise<Response>

const MAX_BYTES_CUERPO = 20 * 1024
const PATRON_SESION = /^\/api\/sessions\/([^/]+)$/
const esquemaChat = z.object({ sessionId: esquemaSessionId, message: z.string() })

/** Respuesta de error en JSON legible (6.4); nunca incluye stack traces. */
function errorJson(status: number, error: string): Response {
  return Response.json({ ok: false, error }, { status })
}

/** Lee y valida el cuerpo de /api/chat: ≤ 20 KB, JSON válido y { sessionId, message } (PRD 8, robustez). */
async function leerCuerpoChat(peticion: Request): Promise<z.infer<typeof esquemaChat> | Response> {
  const texto = await peticion.text()
  if (Buffer.byteLength(texto, "utf8") > MAX_BYTES_CUERPO) return errorJson(413, "El mensaje es demasiado grande (máximo 20 KB)")
  let cuerpo: unknown
  try {
    cuerpo = JSON.parse(texto)
  } catch {
    return errorJson(400, "El cuerpo debe ser JSON válido")
  }
  const resultado = esquemaChat.safeParse(cuerpo)
  if (resultado.success) return resultado.data
  return errorJson(400, `Solicitud inválida: ${resultado.error.issues.map((p) => `${p.path.join(".")} ${p.message}`).join("; ")}`)
}

/** Crea el manejador HTTP con sus dependencias (6.4): solo enruta y traduce; el ciclo vive en src/agent/loop.ts. */
export function crearManejador(deps: DependenciasServidor): (peticion: Request) => Promise<Response> {
  /** POST /api/chat → { reply, toolCalls, needsConfirmation, proveedor }; un turno a la vez por sesión (409). */
  const responderChat: Manejador = async (peticion) => {
    const cuerpo = await leerCuerpoChat(peticion)
    if (cuerpo instanceof Response) return cuerpo
    if (!deps.proveedor) return errorJson(503, deps.errorProveedor ?? "El proveedor de IA no está configurado")
    const sesion = obtenerOCrearSesion(cuerpo.sessionId)
    if (sesion.turnoEnCurso) return errorJson(409, "Espera a que termine la respuesta anterior")
    sesion.turnoEnCurso = true
    try {
      const ctx = { directory: deps.raiz, sessionId: sesion.id }
      return Response.json(await ejecutarTurno(sesion, cuerpo.message, { proveedor: deps.proveedor, sistema: deps.sistema, ctx }))
    } finally {
      sesion.turnoEnCurso = false
    }
  }

  /** GET /api/sessions/:id → historial visible (sin datosProveedor ni prompt de sistema); 404 si no existe. */
  const responderSesion: Manejador = async (_peticion, id) => {
    const sesion = esquemaSessionId.safeParse(id).success ? obtenerSesion(id) : undefined
    if (!sesion) return errorJson(404, "La sesión no existe")
    return Response.json({ ok: true, sessionId: sesion.id, historial: sesion.historialVisible })
  }

  /** POST /api/reset → borra out/ (bajo el candado de escritura) y todas las sesiones; no toca el contador diario. */
  const responderReset: Manejador = async () => {
    await reiniciarSalida({ directory: deps.raiz, sessionId: "reset" })
    borrarTodasLasSesiones()
    return Response.json({ ok: true })
  }

  const rutas: Record<string, Manejador> = {
    "GET /": async () => new Response(Bun.file(path.join(deps.raiz, "web", "index.html"))),
    "GET /api/health": async () => Response.json({ ok: true, ...describirProveedor() }),
    "POST /api/chat": responderChat,
    "POST /api/reset": responderReset,
  }

  return async (peticion) => {
    try {
      const { pathname } = new URL(peticion.url)
      const sesion = peticion.method === "GET" ? PATRON_SESION.exec(pathname) : null
      if (sesion) return await responderSesion(peticion, decodeURIComponent(sesion[1] ?? ""))
      const manejador = rutas[`${peticion.method} ${pathname}`]
      return manejador ? await manejador(peticion, "") : errorJson(404, "Ruta no encontrada")
    } catch {
      return errorJson(500, "Error interno del servidor")
    }
  }
}

/** Crea el proveedor configurado o guarda el mensaje claro de la fábrica para responderlo en /api/chat (CA5). */
function prepararProveedor(): Pick<DependenciasServidor, "proveedor" | "errorProveedor"> {
  try {
    return { proveedor: crearProveedor(), errorProveedor: null }
  } catch (error) {
    const mensaje = error instanceof ErrorProveedor ? error.message : "No se pudo crear el proveedor de IA"
    console.warn(`Proveedor de IA no disponible: ${mensaje}`)
    return { proveedor: null, errorProveedor: mensaje }
  }
}

if (import.meta.main) {
  const raiz = path.join(import.meta.dir, "..")
  let sistema: string
  try {
    sistema = construirSistema(raiz)
  } catch (error) {
    console.error(error instanceof Error ? error.message : "No se pudo construir el prompt de sistema")
    process.exit(1)
  }
  const puerto = Number(process.env.PORT) || 3000
  // idleTimeout alto: un turno puede encadenar varias llamadas al modelo (el máximo de Bun es 255 s)
  Bun.serve({ port: puerto, hostname: "0.0.0.0", idleTimeout: 255, fetch: crearManejador({ raiz, sistema, ...prepararProveedor() }) })
  console.log(`Servidor escuchando en http://localhost:${puerto}`)
}
