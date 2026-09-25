// Lectura y escritura de archivos común a buzón, maestro y registro: UTF-8, saltos \n y escritura atómica.
import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"

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

/**
 * Escribe un archivo de forma atómica: primero un temporal en la misma carpeta y luego lo renombra sobre el destino.
 * Si algo falla a mitad, el archivo anterior queda intacto y no corrupto (O2).
 */
export async function escribirArchivoAtomico(ruta: string, contenido: string): Promise<void> {
  await mkdir(path.dirname(ruta), { recursive: true })
  const temporal = `${ruta}.tmp-${randomUUID()}`
  try {
    await writeFile(temporal, contenido, "utf8")
    await rename(temporal, ruta)
  } catch (error) {
    await rm(temporal, { force: true })
    throw error
  }
}

/** Nombre de archivo o carpeta simple, sin separadores ni "..": evita salir de la carpeta esperada (seguridad). */
export function esNombreSimple(nombre: string): boolean {
  return nombre !== "" && !nombre.includes("..") && !/[\\/]/.test(nombre) && path.basename(nombre) === nombre
}
