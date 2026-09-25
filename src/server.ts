// Servidor HTTP (Bun.serve): rutas de la API, sirve web/index.html y delega el ciclo a src/agent/loop.ts.
import path from "node:path"

type Manejador = (peticion: Request) => Response | Promise<Response>

const PUERTO = Number(process.env.PORT) || 3000
const HOSTNAME = "0.0.0.0"
const RUTA_INDEX = path.join(import.meta.dir, "..", "web", "index.html")
const SIN_CONFIGURAR = "sin_configurar"

/** Sirve el front de chat (web/index.html). */
function servirFront(): Response {
  return new Response(Bun.file(RUTA_INDEX))
}

/** Informa proveedor y modelo configurados (API 6.4) sin exponer claves. */
function responderSalud(): Response {
  return Response.json({
    ok: true,
    provider: process.env.LLM_PROVIDER || SIN_CONFIGURAR,
    model: process.env.LLM_MODEL || SIN_CONFIGURAR,
  })
}

/** Respuesta estándar para rutas no registradas. */
function responderNoEncontrado(): Response {
  return Response.json({ ok: false, error: "Ruta no encontrada" }, { status: 404 })
}

/** Tabla de rutas "MÉTODO /ruta" → manejador; aquí se agregan las rutas nuevas. */
const RUTAS: Record<string, Manejador> = {
  "GET /": servirFront,
  "GET /api/health": responderSalud,
}

/** Enrutador: busca el manejador por método y ruta, o responde 404. */
function enrutar(peticion: Request): Response | Promise<Response> {
  const { pathname } = new URL(peticion.url)
  const manejador = RUTAS[`${peticion.method} ${pathname}`] ?? responderNoEncontrado
  return manejador(peticion)
}

Bun.serve({ port: PUERTO, hostname: HOSTNAME, fetch: enrutar })

console.log(`Servidor escuchando en http://localhost:${PUERTO}`)
