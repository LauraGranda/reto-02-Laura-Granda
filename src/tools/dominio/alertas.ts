// Alertas para gerencia (HU-5, O4): vencimientos, pólizas no vigentes y gap cubierto. Lógica pura: recibe filas e historial ya leídos.
import { diasEntre, sumarDias } from "./fechas"
import { DIAS_ALERTA_VENCIMIENTO, FECHA_CORTE_MAESTRO } from "./reglas"
import type { EntradaHistorial, FilaMaestro } from "./tipos"

// ── Tipos de salida ────────────────────────────────────────────────────────

type Base = { id_contrato: string; cliente: string }

/** Contrato que vence en ≤ 60 días (HU-5, sección 1). */
export type PorVencer = Base & Pick<FilaMaestro, "fecha_fin" | "valor" | "moneda" | "estado_poliza" | "comercial"> & { dias_restantes: number }

/** Contrato ya vencido a la fecha de referencia (sección informativa). */
export type Vencido = Base & Pick<FilaMaestro, "fecha_fin" | "valor" | "moneda" | "estado_poliza" | "comercial"> & { dias_vencido: number }

/** Contrato con póliza exigida que no está vigente (HU-5, sección 2). */
export type PolizaPendiente = Base & Pick<FilaMaestro, "tipo_poliza" | "estado_poliza" | "fecha_fin" | "comercial">

/** Contrato registrado desde el corte del maestro (HU-5, sección 3: gap cubierto). */
export type RegistradoDesdeCorte = Base & Pick<FilaMaestro, "fecha_registro" | "valor" | "moneda" | "estado_poliza" | "comercial">

/** Contrato actualizado (otrosí) desde el corte, según el historial (sección informativa). */
export type ActualizadoDesdeCorte = Base & { campos_cambiados: string[]; fecha_fin: string }

/** Todas las secciones del reporte. */
export type SeccionesAlertas = {
  vencen: PorVencer[]
  polizas_pendientes: PolizaPendiente[]
  registrados_desde_corte: RegistradoDesdeCorte[]
  ya_vencidos: Vencido[]
  actualizados_desde_corte: ActualizadoDesdeCorte[]
}

type Columna<T> = readonly [encabezado: string, celda: (item: T) => string]

const SIN_CONTRATOS = "Sin contratos en esta categoría."

// ── Utilidades ─────────────────────────────────────────────────────────────

/** Compara textos por código de carácter (no depende del idioma del sistema: igual en Windows y Linux). */
function compararTexto(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Valor con separador de miles "." y decimales "," hecho a mano (sin Intl) para que sea igual en Windows y Linux. */
export function formatearValor(valor: number, moneda: string): string {
  const [entero = "0", decimales = "00"] = Math.abs(valor).toFixed(2).split(".")
  const miles = entero.replace(/\B(?=(\d{3})+(?!\d))/g, ".")
  const cifra = decimales === "00" ? miles : `${miles},${decimales}`
  return `${moneda} ${valor < 0 ? "-" : ""}${cifra}`
}

// ── Secciones (HU-5) ───────────────────────────────────────────────────────

/**
 * HU-5 sección 1: contratos con fecha_fin entre hoy y hoy + 60 días, AMBOS extremos incluidos (vence hoy = 0 días).
 * Orden: fecha_fin ascendente y luego id_contrato.
 */
export function contratosPorVencer(filas: FilaMaestro[], hoy: string): PorVencer[] {
  return filas
    .map((fila) => ({ fila, dias: diasEntre(hoy, fila.fecha_fin) }))
    .filter(({ dias }) => dias >= 0 && dias <= DIAS_ALERTA_VENCIMIENTO)
    .sort((a, b) => a.dias - b.dias || compararTexto(a.fila.id_contrato, b.fila.id_contrato))
    .map(({ fila, dias }) => ({
      id_contrato: fila.id_contrato, cliente: fila.cliente, fecha_fin: fila.fecha_fin, dias_restantes: dias,
      valor: fila.valor, moneda: fila.moneda, estado_poliza: fila.estado_poliza, comercial: fila.comercial,
    }))
}

/** Sección informativa: contratos con fecha_fin anterior a hoy, con los días que llevan vencidos. */
export function contratosVencidos(filas: FilaMaestro[], hoy: string): Vencido[] {
  return filas
    .map((fila) => ({ fila, dias: diasEntre(fila.fecha_fin, hoy) }))
    .filter(({ dias }) => dias > 0)
    .sort((a, b) => b.dias - a.dias || compararTexto(a.fila.id_contrato, b.fila.id_contrato))
    .map(({ fila, dias }) => ({
      id_contrato: fila.id_contrato, cliente: fila.cliente, fecha_fin: fila.fecha_fin, dias_vencido: dias,
      valor: fila.valor, moneda: fila.moneda, estado_poliza: fila.estado_poliza, comercial: fila.comercial,
    }))
}

/** HU-5 sección 2: requiere_poliza = true y estado_poliza distinto de "vigente". Orden por id_contrato. */
export function polizasPendientes(filas: FilaMaestro[]): PolizaPendiente[] {
  return filas
    .filter((fila) => fila.requiere_poliza && fila.estado_poliza !== "vigente")
    .sort((a, b) => compararTexto(a.id_contrato, b.id_contrato))
    .map((fila) => ({
      id_contrato: fila.id_contrato, cliente: fila.cliente, tipo_poliza: fila.tipo_poliza,
      estado_poliza: fila.estado_poliza, fecha_fin: fila.fecha_fin, comercial: fila.comercial,
    }))
}

/** HU-5 sección 3 (gap cubierto): fecha_registro ≥ 2026-05-30. Orden: fecha_registro y luego id_contrato. */
export function registradosDesdeCorte(filas: FilaMaestro[]): RegistradoDesdeCorte[] {
  return filas
    .filter((fila) => fila.fecha_registro >= FECHA_CORTE_MAESTRO)
    .sort((a, b) => compararTexto(a.fecha_registro, b.fecha_registro) || compararTexto(a.id_contrato, b.id_contrato))
    .map((fila) => ({
      id_contrato: fila.id_contrato, cliente: fila.cliente, fecha_registro: fila.fecha_registro,
      valor: fila.valor, moneda: fila.moneda, estado_poliza: fila.estado_poliza, comercial: fila.comercial,
    }))
}

/**
 * Sección informativa: contratos con líneas "actualizado" en el historial desde el corte, sin repetir id.
 * Une los campos cambiados; cliente y fecha_fin salen del maestro (el historial no los guarda).
 */
export function actualizadosDesdeCorte(historial: EntradaHistorial[], filas: FilaMaestro[]): ActualizadoDesdeCorte[] {
  const campos = new Map<string, Set<string>>()
  for (const entrada of historial) {
    if (entrada.accion !== "actualizado" || entrada.ts.slice(0, 10) < FECHA_CORTE_MAESTRO) continue
    const acumulados = campos.get(entrada.id_contrato) ?? new Set<string>()
    for (const campo of Object.keys(entrada.cambios)) acumulados.add(campo)
    campos.set(entrada.id_contrato, acumulados)
  }
  return [...campos]
    .sort(([a], [b]) => compararTexto(a, b))
    .map(([id, cambiados]) => {
      const fila = filas.find((candidata) => candidata.id_contrato === id)
      return { id_contrato: id, cliente: fila?.cliente ?? "", campos_cambiados: [...cambiados], fecha_fin: fila?.fecha_fin ?? "" }
    })
}

/** Calcula todas las secciones del reporte para una fecha de referencia (HU-5). */
export function calcularSecciones(filas: FilaMaestro[], historial: EntradaHistorial[], hoy: string): SeccionesAlertas {
  return {
    vencen: contratosPorVencer(filas, hoy),
    polizas_pendientes: polizasPendientes(filas),
    registrados_desde_corte: registradosDesdeCorte(filas),
    ya_vencidos: contratosVencidos(filas, hoy),
    actualizados_desde_corte: actualizadosDesdeCorte(historial, filas),
  }
}

// ── Markdown ───────────────────────────────────────────────────────────────

/** Escapa "|" y saltos de línea para que una celda no rompa la tabla markdown. */
function escaparCelda(texto: string): string {
  return texto.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ")
}

/** Tabla markdown de una sección; vacía → "Sin contratos en esta categoría." */
function tablaMarkdown<T>(items: T[], columnas: Columna<T>[]): string {
  if (items.length === 0) return SIN_CONTRATOS
  const encabezado = `| ${columnas.map(([titulo]) => titulo).join(" | ")} |`
  const separador = `|${columnas.map(() => "---").join("|")}|`
  const filas = items.map((item) => `| ${columnas.map(([, celda]) => escaparCelda(celda(item))).join(" | ")} |`)
  return [encabezado, separador, ...filas].join("\n")
}

const COLUMNA_ID: Columna<Base> = ["id_contrato", (c) => c.id_contrato]
const COLUMNA_CLIENTE: Columna<Base> = ["cliente", (c) => c.cliente]

const COLUMNAS_POR_VENCER: Columna<PorVencer>[] = [
  COLUMNA_ID, COLUMNA_CLIENTE, ["fecha_fin", (c) => c.fecha_fin], ["días restantes", (c) => String(c.dias_restantes)],
  ["valor", (c) => formatearValor(c.valor, c.moneda)], ["estado_poliza", (c) => c.estado_poliza], ["comercial", (c) => c.comercial],
]

const COLUMNAS_POLIZAS: Columna<PolizaPendiente>[] = [
  COLUMNA_ID, COLUMNA_CLIENTE, ["tipo_poliza", (c) => c.tipo_poliza], ["estado_poliza", (c) => c.estado_poliza],
  ["fecha_fin", (c) => c.fecha_fin], ["comercial", (c) => c.comercial],
]

const COLUMNAS_REGISTRADOS: Columna<RegistradoDesdeCorte>[] = [
  COLUMNA_ID, COLUMNA_CLIENTE, ["fecha_registro", (c) => c.fecha_registro], ["valor", (c) => formatearValor(c.valor, c.moneda)],
  ["estado_poliza", (c) => c.estado_poliza], ["comercial", (c) => c.comercial],
]

const COLUMNAS_VENCIDOS: Columna<Vencido>[] = [
  COLUMNA_ID, COLUMNA_CLIENTE, ["fecha_fin", (c) => c.fecha_fin], ["días vencido", (c) => String(c.dias_vencido)],
  ["valor", (c) => formatearValor(c.valor, c.moneda)], ["estado_poliza", (c) => c.estado_poliza],
]

const COLUMNAS_ACTUALIZADOS: Columna<ActualizadoDesdeCorte>[] = [
  COLUMNA_ID, COLUMNA_CLIENTE, ["campos cambiados", (c) => c.campos_cambiados.join(", ")], ["fecha_fin", (c) => c.fecha_fin],
]

/** Título, cantidad y tabla de cada sección, en el orden del reporte: las 3 del PRD y luego las informativas. */
function armarSecciones(s: SeccionesAlertas, hoy: string): { titulo: string; cantidad: number; tabla: string }[] {
  const limite = sumarDias(hoy, DIAS_ALERTA_VENCIMIENTO)
  return [
    { titulo: `Vencen en los próximos ${DIAS_ALERTA_VENCIMIENTO} días (hasta ${limite})`, cantidad: s.vencen.length, tabla: tablaMarkdown(s.vencen, COLUMNAS_POR_VENCER) },
    { titulo: "Pólizas exigidas no vigentes", cantidad: s.polizas_pendientes.length, tabla: tablaMarkdown(s.polizas_pendientes, COLUMNAS_POLIZAS) },
    { titulo: `Registrados desde el corte (${FECHA_CORTE_MAESTRO})`, cantidad: s.registrados_desde_corte.length, tabla: tablaMarkdown(s.registrados_desde_corte, COLUMNAS_REGISTRADOS) },
    { titulo: "Ya vencidos (informativo)", cantidad: s.ya_vencidos.length, tabla: tablaMarkdown(s.ya_vencidos, COLUMNAS_VENCIDOS) },
    { titulo: `Actualizados desde el corte (${FECHA_CORTE_MAESTRO}) (informativo)`, cantidad: s.actualizados_desde_corte.length, tabla: tablaMarkdown(s.actualizados_desde_corte, COLUMNAS_ACTUALIZADOS) },
  ]
}

/**
 * Reporte markdown para gerencia (HU-5): título, fecha de referencia, resumen y una tabla por sección.
 * Sin hora de generación: la misma fecha y el mismo maestro producen el mismo archivo (determinismo, PRD 8).
 */
export function generarReporteMarkdown(secciones: SeccionesAlertas, hoy: string): string {
  const partes = armarSecciones(secciones, hoy)
  const resumen = ["| Sección | Contratos |", "|---|---|", ...partes.map(({ titulo, cantidad }) => `| ${titulo} | ${cantidad} |`)]
  const cuerpo = partes.flatMap(({ titulo, tabla }) => [`## ${titulo}`, "", tabla, ""])
  return ["# Alertas de contratos vigentes", "", `Fecha de referencia: ${hoy}`, "", "## Resumen", "", ...resumen, "", ...cuerpo].join("\n")
}
