// Aritmética de fechas sobre strings YYYY-MM-DD sin zona horaria (plazos en meses, diferencias en días).

const MS_POR_DIA = 86_400_000
const PATRON_FECHA = /^(\d{4})-(\d{2})-(\d{2})$/

type PartesFecha = { anio: number; mes: number; dia: number }

/** Días del mes (mes 1–12), considerando años bisiestos. */
function diasDelMes(anio: number, mes: number): number {
  const bisiesto = (anio % 4 === 0 && anio % 100 !== 0) || anio % 400 === 0
  const dias = [31, bisiesto ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return dias[mes - 1] ?? 0
}

/** Separa una fecha YYYY-MM-DD en números, o null si el formato no coincide. */
function separarFecha(fecha: string): PartesFecha | null {
  const coincidencia = PATRON_FECHA.exec(fecha)
  if (!coincidencia) return null
  const [, anio, mes, dia] = coincidencia
  return { anio: Number(anio), mes: Number(mes), dia: Number(dia) }
}

/** Separa una fecha válida o lanza un error legible (las herramientas lo convierten en { ok: false }). */
function exigirFecha(fecha: string): PartesFecha {
  const partes = separarFecha(fecha)
  if (!partes || !esFechaValida(fecha)) throw new Error(`Fecha inválida: "${fecha}" (se espera YYYY-MM-DD)`)
  return partes
}

/** Une partes numéricas en un string YYYY-MM-DD. */
function formatearFecha({ anio, mes, dia }: PartesFecha): string {
  return `${String(anio).padStart(4, "0")}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`
}

/** Convierte una fecha a número de día absoluto en UTC, sin pasar por la zona local. */
function aDiaAbsoluto(fecha: string): number {
  const { anio, mes, dia } = exigirFecha(fecha)
  return Date.UTC(anio, mes - 1, dia) / MS_POR_DIA
}

/** Indica si el string es una fecha real YYYY-MM-DD; así "fecha inválida" da error legible (HU-6). */
export function esFechaValida(fecha: string): boolean {
  const partes = separarFecha(fecha)
  if (!partes) return false
  const { anio, mes, dia } = partes
  return mes >= 1 && mes <= 12 && dia >= 1 && dia <= diasDelMes(anio, mes)
}

/**
 * Suma meses a una fecha; si el día no existe en el mes destino usa el último día del mes.
 * Deriva fecha_fin desde un plazo en meses (7.2, msg-006).
 */
export function sumarMeses(fecha: string, meses: number): string {
  const { anio, mes, dia } = exigirFecha(fecha)
  const indiceMes = anio * 12 + (mes - 1) + meses
  const anioDestino = Math.floor(indiceMes / 12)
  const mesDestino = (indiceMes % 12) + 1
  const diaDestino = Math.min(dia, diasDelMes(anioDestino, mesDestino))
  return formatearFecha({ anio: anioDestino, mes: mesDestino, dia: diaDestino })
}

/** Suma (o resta, si es negativo) días a una fecha; sirve para el límite de alertas (HU-5). */
export function sumarDias(fecha: string, dias: number): string {
  const resultado = new Date((aDiaAbsoluto(fecha) + dias) * MS_POR_DIA)
  return formatearFecha({
    anio: resultado.getUTCFullYear(),
    mes: resultado.getUTCMonth() + 1,
    dia: resultado.getUTCDate(),
  })
}

/** Días de `desde` a `hasta` (positivo si `hasta` es posterior); decide qué vence en ≤ 60 días (HU-5). */
export function diasEntre(desde: string, hasta: string): number {
  return aDiaAbsoluto(hasta) - aDiaAbsoluto(desde)
}

/**
 * Fecha para la columna fecha_registro (7.2): la del contexto si quien llama la fijó y es válida (demo determinista, PRD 8);
 * si no, la fecha real de hoy. Recibe un tipo estructural para no importar tipos.ts.
 */
export function fechaDeRegistro(ctx: { fechaActual?: string | undefined }): string {
  return ctx.fechaActual !== undefined && esFechaValida(ctx.fechaActual) ? ctx.fechaActual : fechaHoyISO()
}

/** Fecha de hoy en la zona local como YYYY-MM-DD; se usa para fecha_registro (7.2). */
export function fechaHoyISO(): string {
  const ahora = new Date()
  return formatearFecha({ anio: ahora.getFullYear(), mes: ahora.getMonth() + 1, dia: ahora.getDate() })
}
