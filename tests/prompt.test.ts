import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import * as herramientas from "../src/tools/contratos"

const RAIZ = path.join(import.meta.dir, "..")
const RUTA_PROMPT = path.join(RAIZ, "agent", "prompt.md")
const RUTA_CONOCIMIENTO = path.join(RAIZ, "src", "knowledge", "registro-contratos.md")

/** Palabras reales: tokens con al menos una letra o número (los "|" y "---" de las tablas no cuentan). */
function contarPalabras(texto: string): number {
  return texto.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length
}

describe("prompt (comportamiento) y conocimiento (proceso) — PRD 6.5", () => {
  test("ambos archivos existen, no están vacíos y respetan su máximo de palabras", async () => {
    const prompt = await readFile(RUTA_PROMPT, "utf8")
    const conocimiento = await readFile(RUTA_CONOCIMIENTO, "utf8")
    expect(contarPalabras(prompt)).toBeGreaterThan(0)
    expect(contarPalabras(prompt)).toBeLessThanOrEqual(750)
    expect(contarPalabras(conocimiento)).toBeGreaterThan(0)
    expect(contarPalabras(conocimiento)).toBeLessThanOrEqual(900)
  })

  test("el prompt nombra exactamente las herramientas exportadas como contratos_<export>", async () => {
    const prompt = await readFile(RUTA_PROMPT, "utf8")
    const esperadas = Object.keys(herramientas).map((nombre) => `contratos_${nombre}`).sort()
    const mencionadas = [...new Set(prompt.match(/contratos_\w+/g) ?? [])].sort()
    expect(mencionadas).toEqual(esperadas)
  })

  test("el prompt pide responder en español y tiene la sección Guardrails", async () => {
    const prompt = await readFile(RUTA_PROMPT, "utf8")
    expect(prompt).toContain("Always reply in neutral Latin American Spanish")
    expect(prompt).toMatch(/^# Guardrails/m)
  })

  test("el prompt pide reportar el motivo de cada mensaje rechazado o descartado (HU-1, RN4)", async () => {
    const prompt = await readFile(RUTA_PROMPT, "utf8")
    const formato = prompt.split("# Response format")[1]?.split("\n# ")[0] ?? ""
    expect(formato).toContain("Always add one line per rejected or discarded message with its reason, taken from the tool result")
  })

  test("ninguno de los dos archivos trae resultados del buzón (ids de los fixtures ni msg-00)", async () => {
    for (const ruta of [RUTA_PROMPT, RUTA_CONOCIMIENTO]) {
      const texto = await readFile(ruta, "utf8")
      expect({ ruta, coincidencias: texto.match(/CT-2026-|CT-2025-|CM-2026-|msg-00/g) ?? [] }).toEqual({ ruta, coincidencias: [] })
    }
  })
})
