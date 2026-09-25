// Lectura/escritura del maestro CSV en out/sharepoint/, archivo del contrato e historial.jsonl (HU-4, RN6).
import { appendFile, copyFile, mkdir } from "node:fs/promises"
import path from "node:path"
import Papa from "papaparse"
import { z } from "zod"
import { escribirArchivoAtomico, existeArchivo, leerTextoUtf8 } from "./archivos"
import {
  carpetaSharepoint,
  rutaComerciales,
  rutaHistorial,
  rutaMaestroFixture,
  rutaMaestroSalida,
  rutaProcesados,
} from "./rutas"
import {
  COLUMNAS_MAESTRO,
  esquemaComercial,
  esquemaFilaMaestro,
  esquemaProcesados,
  type Comercial,
  type ContextoHerramienta,
  type EntradaHistorial,
  type FilaMaestro,
  type Procesados,
  type RegistroProcesado,
} from "./tipos"

type RegistroCsv = Record<string, string>

/** Sufijos societarios que no aportan al slug, del más largo al más corto para que no se corten a medias. */
const PATRON_SUFIJO_SOCIETARIO = /\s+(s\.?\s*de\s*r\.?\s*l\.?|s\.?\s*a\.?\s*s\.?|s\.?\s*a\.?\s*c\.?|s\.?\s*a\.?|ltda\.?)$/

/** Convierte un registro de texto del CSV en FilaMaestro validada; el número de fila va en el error. */
function convertirFilaCsv(registro: RegistroCsv, numeroFila: number): FilaMaestro {
  const resultado = esquemaFilaMaestro.safeParse({
    ...registro,
    valor: registro.valor === "" ? Number.NaN : Number(registro.valor),
    requiere_poliza: registro.requiere_poliza === "true",
  })
  if (!resultado.success) {
    const problema = resultado.error.issues[0]
    throw new Error(`Maestro inválido en la fila ${numeroFila}: ${problema?.path.join(".")} ${problema?.message}`)
  }
  return resultado.data
}

/** Copia el maestro del fixture a out/sharepoint/ si aún no existe; el fixture nunca se modifica (RN6). */
export async function asegurarCopiaMaestro(ctx: ContextoHerramienta): Promise<void> {
  const destino = rutaMaestroSalida(ctx.directory)
  if (await existeArchivo(destino)) return
  await mkdir(carpetaSharepoint(ctx.directory), { recursive: true })
  await copyFile(rutaMaestroFixture(ctx.directory), destino)
}

/** Lee y valida la copia de trabajo del maestro (7.2); la crea desde el fixture si falta (RN6). */
export async function leerMaestro(ctx: ContextoHerramienta): Promise<FilaMaestro[]> {
  await asegurarCopiaMaestro(ctx)
  const texto = await leerTextoUtf8(rutaMaestroSalida(ctx.directory))
  const { data, errors } = Papa.parse<RegistroCsv>(texto, { header: true, skipEmptyLines: true })
  if (errors.length > 0) throw new Error(`Maestro CSV mal formado: ${errors[0]?.message}`)
  return data.map((registro, indice) => convertirFilaCsv(registro, indice + 2))
}

/** Escribe el maestro con las columnas de 7.2 en el orden exacto del fixture y saltos \n, de forma atómica (HU-4, O2). */
export async function escribirMaestro(ctx: ContextoHerramienta, filas: FilaMaestro[]): Promise<void> {
  const csv = Papa.unparse(filas, { columns: [...COLUMNAS_MAESTRO], newline: "\n" })
  await escribirArchivoAtomico(rutaMaestroSalida(ctx.directory), csv + "\n")
}

/** Lee out/procesados.json; vacío si aún no existe. Los mensajes presentes no se relistan (HU-1). */
export async function leerProcesados(ctx: ContextoHerramienta): Promise<Procesados> {
  const ruta = rutaProcesados(ctx.directory)
  if (!(await existeArchivo(ruta))) return {}
  return esquemaProcesados.parse(JSON.parse(await leerTextoUtf8(ruta)))
}

/** Marca un mensaje como procesado con su clasificación y acción (HU-4). */
export async function marcarProcesado(
  ctx: ContextoHerramienta,
  mensajeId: string,
  estado: Omit<RegistroProcesado, "ts">,
): Promise<void> {
  const procesados = await leerProcesados(ctx)
  procesados[mensajeId] = { ...estado, ts: new Date().toISOString() }
  await escribirArchivoAtomico(rutaProcesados(ctx.directory), JSON.stringify(procesados, null, 2) + "\n")
}

/** Agrega una línea a out/sharepoint/historial.jsonl con ts actual (HU-4, RN2). */
export async function agregarHistorial(ctx: ContextoHerramienta, entrada: Omit<EntradaHistorial, "ts">): Promise<void> {
  const linea: EntradaHistorial = { ts: new Date().toISOString(), ...entrada }
  const ruta = rutaHistorial(ctx.directory)
  await mkdir(path.dirname(ruta), { recursive: true })
  await appendFile(ruta, JSON.stringify(linea) + "\n", "utf8")
}

/** Lee y valida fixtures/reto-02/comerciales.json para resolver el remitente (7.1, HU-3). */
export async function leerComerciales(ctx: ContextoHerramienta): Promise<Comercial[]> {
  const texto = await leerTextoUtf8(rutaComerciales(ctx.directory))
  return z.array(esquemaComercial).parse(JSON.parse(texto))
}

/**
 * Convierte la razón social en el nombre de carpeta Contratos/<año>/<cliente-slug>/ (HU-4):
 * minúsculas, sin tildes ni sufijo societario (S.A.S., S.A.C., S.A., Ltda., S. de R.L.), palabras unidas con guion.
 */
export function crearSlugCliente(nombre: string): string {
  return nombre
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim()
    .replace(PATRON_SUFIJO_SOCIETARIO, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .join("-")
}
