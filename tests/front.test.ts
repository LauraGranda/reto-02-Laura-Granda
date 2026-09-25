import { describe, expect, test } from "bun:test"
import path from "node:path"
import { crearManejador } from "../src/server"

const RAIZ = path.join(import.meta.dir, "..")
const manejar = crearManejador({ raiz: RAIZ, sistema: "sistema", proveedor: null, errorProveedor: "sin configurar" })

/** GET a una ruta del servidor. */
function obtener(ruta: string): Promise<Response> {
  return manejar(new Request(`http://localhost${ruta}`))
}

describe("front servido por lista blanca (6.1)", () => {
  test("GET / devuelve el HTML del chat", async () => {
    const respuesta = await obtener("/")
    expect(respuesta.status).toBe(200)
    expect(respuesta.headers.get("content-type")).toContain("text/html")
    const html = await respuesta.text()
    expect(html).toContain("<title>Registro de Contratos Vigentes</title>")
    expect(html).toContain('import { renderizarMarkdown } from "./markdown.js"')
  })

  test("GET /markdown.js devuelve JavaScript", async () => {
    const respuesta = await obtener("/markdown.js")
    expect(respuesta.status).toBe(200)
    expect(respuesta.headers.get("content-type")).toContain("text/javascript")
    expect(await respuesta.text()).toContain("export function renderizarMarkdown")
  })

  test("GET /logo.jpg devuelve el logo y el encabezado lo usa", async () => {
    const respuesta = await obtener("/logo.jpg")
    expect(respuesta.status).toBe(200)
    expect(respuesta.headers.get("content-type")).toBe("image/jpeg")
    expect((await respuesta.arrayBuffer()).byteLength).toBeGreaterThan(0)
    expect(await (await obtener("/")).text()).toContain('<img src="/logo.jpg" alt="Periferia IT Group"')
    expect((await obtener("/images.jpg")).status).toBe(404)
  })

  test("los archivos del front no se guardan en caché y [hidden] siempre oculta", async () => {
    const pagina = await obtener("/")
    expect(pagina.headers.get("cache-control")).toBe("no-store")
    expect((await obtener("/markdown.js")).headers.get("cache-control")).toBe("no-store")
    expect(await pagina.text()).toContain("[hidden] { display: none !important; }")
  })

  test("cualquier otra ruta de archivo → 404 (nada fuera de la lista blanca)", async () => {
    for (const ruta of ["/../.env", "/.env", "/index.html", "/web/index.html", "/src/server.ts", "/%2e%2e/.env", "/fixtures/reto-02/comerciales.json"]) {
      const respuesta = await obtener(ruta)
      expect({ ruta, status: respuesta.status }).toEqual({ ruta, status: 404 })
      expect(await respuesta.json()).toEqual({ ok: false, error: "Ruta no encontrada" })
    }
  })
})
