import { describe, expect, test } from "bun:test"
import { cp, mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as herramientasModulo from "../modulo/tools/contratos"
import * as herramientasApp from "../src/tools/contratos"

const RAIZ = path.join(import.meta.dir, "..")
const DESACTUALIZADO = "El módulo está desactualizado: ejecuta bun run modulo"

/** Separa el frontmatter YAML del cuerpo de un archivo del módulo. */
async function leerConFrontmatter(...relativa: string[]): Promise<{ frontmatter: unknown; cuerpo: string }> {
  const texto = await readFile(path.join(RAIZ, "modulo", ...relativa), "utf8")
  const partes = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(texto)
  if (!partes) throw new Error(DESACTUALIZADO)
  return { frontmatter: Bun.YAML.parse(partes[1] ?? ""), cuerpo: partes[2] ?? "" }
}

/** Falla con el mensaje claro si el cuerpo del módulo no es idéntico a su fuente. */
async function exigirIdentico(cuerpo: string, ...fuente: string[]): Promise<void> {
  if (cuerpo !== (await readFile(path.join(RAIZ, ...fuente), "utf8"))) throw new Error(DESACTUALIZADO)
}

describe("módulo reutilizable (PRD 9.4): mismas piezas que la aplicación", () => {
  test("agent.md: cuerpo idéntico a agent/prompt.md y frontmatter de agente principal sin permisos", async () => {
    const { frontmatter, cuerpo } = await leerConFrontmatter("agent.md")
    await exigirIdentico(cuerpo, "agent", "prompt.md")
    expect(frontmatter).toMatchObject({ mode: "primary", permission: { edit: "deny", bash: "deny" } })
    expect(frontmatter).toHaveProperty("description", expect.stringContaining("Periferia IT Group"))
  })

  test("SKILL.md: cuerpo idéntico a src/knowledge/registro-contratos.md, con name y description", async () => {
    const { frontmatter, cuerpo } = await leerConFrontmatter("skill", "registro-contratos", "SKILL.md")
    await exigirIdentico(cuerpo, "src", "knowledge", "registro-contratos.md")
    expect(frontmatter).toMatchObject({ name: "registro-contratos" })
    expect(frontmatter).toHaveProperty("description", expect.stringContaining("registro de contratos"))
  })

  test("tools/contratos.ts exporta exactamente las mismas herramientas (los mismos objetos, no copias)", () => {
    const nombres = Object.keys(herramientasApp).sort()
    expect(Object.keys(herramientasModulo).sort()).toEqual(nombres)
    for (const nombre of nombres) {
      expect(Reflect.get(herramientasModulo, nombre)).toBe(Reflect.get(herramientasApp, nombre))
    }
  })

  test("las herramientas del módulo funcionan sin levantar el servidor", async () => {
    const directorio = await mkdtemp(path.join(os.tmpdir(), "reto02-modulo-"))
    try {
      await cp(path.join(RAIZ, "fixtures", "reto-02"), path.join(directorio, "fixtures", "reto-02"), { recursive: true })
      const respuesta = JSON.parse(await herramientasModulo.leer_buzon.execute({}, { directory: directorio, sessionId: "modulo" })) as {
        ok: boolean
        data?: { total_pendientes: number }
      }
      expect(respuesta.ok).toBe(true)
      expect(respuesta.data?.total_pendientes).toBe(6)
    } finally {
      await rm(directorio, { recursive: true, force: true })
    }
  })
})
