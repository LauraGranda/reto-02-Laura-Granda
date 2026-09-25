// Resolución de rutas relativas a ctx.directory para fixtures/ (lectura) y out/ (escritura).
import path from "node:path"

/** Carpeta raíz de los fixtures del reto (7.1); solo lectura (RN6). */
function carpetaFixtures(directorio: string): string {
  return path.join(directorio, "fixtures", "reto-02")
}

/** Carpeta del buzón simulado con un subdirectorio por mensaje (7.1, HU-1). */
export function carpetaBuzon(directorio: string): string {
  return path.join(carpetaFixtures(directorio), "buzon")
}

/** Carpeta de un mensaje con su correo.json y adjuntos (7.1). */
export function carpetaMensaje(directorio: string, mensajeId: string): string {
  return path.join(carpetaBuzon(directorio), mensajeId)
}

/** Maestro congelado del fixture; nunca se escribe (RN6). */
export function rutaMaestroFixture(directorio: string): string {
  return path.join(carpetaFixtures(directorio), "maestro-contratos.csv")
}

/** Lista de comerciales para resolver el remitente (7.1, HU-3). */
export function rutaComerciales(directorio: string): string {
  return path.join(carpetaFixtures(directorio), "comerciales.json")
}

/** Carpeta de salida donde va todo lo generado (RN6, CLAUDE.md). */
export function carpetaSalida(directorio: string): string {
  return path.join(directorio, "out")
}

/** SharePoint simulado como carpeta local (2.3, HU-4). */
export function carpetaSharepoint(directorio: string): string {
  return path.join(carpetaSalida(directorio), "sharepoint")
}

/** Copia de trabajo del maestro (HU-4, RN6). */
export function rutaMaestroSalida(directorio: string): string {
  return path.join(carpetaSharepoint(directorio), "maestro-contratos.csv")
}

/** Raíz del archivo de contratos: Contratos/<año>/<cliente-slug>/ (HU-4). */
export function carpetaContratosSharepoint(directorio: string): string {
  return path.join(carpetaSharepoint(directorio), "Contratos")
}

/** Historial de altas y cambios del maestro, en out/sharepoint/ como indica HU-4. */
export function rutaHistorial(directorio: string): string {
  return path.join(carpetaSharepoint(directorio), "historial.jsonl")
}

/** Mensajes ya procesados; los presentes no se vuelven a listar (HU-1, HU-4). */
export function rutaProcesados(directorio: string): string {
  return path.join(carpetaSalida(directorio), "procesados.json")
}

/** Log de llamadas a herramientas (RN7, CA4). */
export function rutaLog(directorio: string): string {
  return path.join(carpetaSalida(directorio), "log.jsonl")
}

/** Reporte de alertas de vencimiento y pólizas (HU-5). */
export function rutaAlertas(directorio: string): string {
  return path.join(carpetaSalida(directorio), "alertas.md")
}
