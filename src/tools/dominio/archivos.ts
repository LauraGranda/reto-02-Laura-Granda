// Lectura de archivos de texto común a buzón y maestro: UTF-8, sin BOM y con saltos \n.
import { readFile, stat } from "node:fs/promises"

/** Lee un archivo de texto en UTF-8 sin BOM y con saltos de línea \n (compatibilidad Windows/Linux, CLAUDE.md). */
export async function leerTextoUtf8(ruta: string): Promise<string> {
  const texto = await readFile(ruta, "utf8")
  return texto.replace(/^﻿/, "").replace(/\r\n/g, "\n")
}

/** Indica si existe un archivo (no carpeta) en la ruta dada; se usa para decidir antes de leer (RN6, HU-1). */
export async function existeArchivo(ruta: string): Promise<boolean> {
  try {
    return (await stat(ruta)).isFile()
  } catch {
    return false
  }
}
