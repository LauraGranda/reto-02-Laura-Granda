// Clasificación nuevo/actualizacion/duplicado/rechazado y campos en revisión (RN1–RN5). Lógica pura: no toca archivos.
import { diasEntre } from "./fechas"
import { CONFIANZA, UMBRAL_CONFIANZA, UMBRAL_SIMILITUD_OBJETO } from "./reglas"
import {
  esquemaContratoExtraido,
  type Clasificacion,
  type ContratoExtraido,
  type Correcciones,
  type Diferencias,
  type FilaMaestro,
  type ResultadoValidacion,
} from "./tipos"

// ── Tipos y constantes ─────────────────────────────────────────────────────

type CampoConConfianza = Exclude<keyof ContratoExtraido, "tipo_documento" | "valor_indeterminado" | "exige_ampliar_garantias">

/** Coincidencia con una fila del maestro y el criterio que la produjo (RN1, RN2). */
export type Coincidencia = { fila: FilaMaestro; criterio: "id" | "nit_objeto" }

/** Resultado de validar un contrato, sin el comercial (que se resuelve leyendo comerciales.json). */
export type ResultadoContrato = Omit<ResultadoValidacion, "comercial">

/** Resultado interno de aplicar RN1–RN4: clasificación, fila encontrada y hallazgos. */
type ResultadoClasificacion = {
  clasificacion: Clasificacion
  fila: FilaMaestro | null
  diferencias: Diferencias
  conflictos: string[]
  camposConflicto: string[]
  motivo: string | null
}

/** Hallazgos que suman conflictos y campos a revisión. */
type Hallazgos = { conflictos: string[]; campos: string[] }

/** Campos del contrato que llevan valor + confianza + evidencia, en el orden del esquema. */
const CAMPOS_CON_CONFIANZA = [
  "id_contrato", "cliente", "nit_cliente", "pais", "objeto", "valor", "moneda",
  "fecha_inicio", "fecha_fin", "requiere_poliza", "tipo_poliza",
] as const satisfies readonly CampoConConfianza[]

/** Banderas sin confianza que también se comparan con la re-extracción. */
const BANDERAS = ["tipo_documento", "valor_indeterminado", "exige_ampliar_garantias"] as const

/**
 * Campos que se comparan con el maestro para detectar diferencias (RN1, RN2). No se comparan objeto ni cliente:
 * el maestro guarda versiones resumidas y darían falsas diferencias (docs/supuestos.md).
 */
export const CAMPOS_COMPARABLES = [
  "valor", "moneda", "fecha_inicio", "fecha_fin", "requiere_poliza", "tipo_poliza",
] as const satisfies readonly CampoConConfianza[]

/** Campos que definen un duplicado según RN1. */
const CAMPOS_RN1 = ["valor", "fecha_inicio", "fecha_fin"] as const

/** Campos que se revisan en un contrato nuevo (RN5); tipo_poliza se agrega solo si requiere_poliza es true. */
const CAMPOS_REVISION_NUEVO: readonly CampoConConfianza[] = CAMPOS_CON_CONFIANZA.filter((campo) => campo !== "tipo_poliza")

/** Orden estable de requiere_revision: el del esquema, más estado_poliza (derivado) al final. */
const ORDEN_CAMPOS: readonly string[] = [...Object.keys(esquemaContratoExtraido.shape), "estado_poliza"]

/** Palabras que no aportan a la similitud de objetos (RN2). */
const PALABRAS_VACIAS = new Set(["de", "del", "la", "el", "los", "las", "y", "en", "para", "con", "por", "a"])

// ── Utilidades ─────────────────────────────────────────────────────────────

/** Palabras normalizadas (minúsculas, sin tildes ni puntuación) sin palabras vacías. */
function palabrasClave(texto: string): Set<string> {
  const limpio = texto.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ")
  return new Set(limpio.split(" ").filter((palabra) => palabra !== "" && !PALABRAS_VACIAS.has(palabra)))
}

/**
 * Coeficiente de Dice (2·|A∩B| / (|A|+|B|)) entre las palabras clave de dos objetos, en [0, 1].
 * Decide la actualización por "mismo nit_cliente + objeto con similitud ≥ 0.9" (RN2).
 */
export function similitudObjeto(a: string, b: string): number {
  const palabrasA = palabrasClave(a)
  const palabrasB = palabrasClave(b)
  const total = palabrasA.size + palabrasB.size
  if (total === 0) return 0
  const comunes = [...palabrasA].filter((palabra) => palabrasB.has(palabra)).length
  return (2 * comunes) / total
}

/** Valor como texto comparable: números sin decimales sobrantes, booleanos "true"/"false", null vacío (RN1, RN2). */
function aTexto(valor: string | number | boolean | null): string {
  if (valor === null) return ""
  if (typeof valor === "number") return String(Number(valor))
  if (typeof valor === "boolean") return valor ? "true" : "false"
  return valor.trim()
}

/** Indica si un nombre de campo lleva confianza en el ContratoExtraido. */
function esCampoConConfianza(campo: string): campo is CampoConConfianza {
  return (CAMPOS_CON_CONFIANZA as readonly string[]).includes(campo)
}

/** Deja los campos sin repetir y en el orden del esquema (salida estable de requiere_revision). */
function ordenarCampos(campos: string[]): string[] {
  const posicion = (campo: string) => (ORDEN_CAMPOS.includes(campo) ? ORDEN_CAMPOS.indexOf(campo) : ORDEN_CAMPOS.length)
  return [...new Set(campos)].sort((a, b) => posicion(a) - posicion(b))
}

// ── Re-extracción (HU-2, CA2) ──────────────────────────────────────────────

/**
 * Compara el contrato recibido del modelo con una nueva extracción del adjunto (HU-2, CA2). Cada valor distinto
 * se reporta con ambos valores y va a revisión; las confianzas y evidencias SIEMPRE son las de la extracción.
 */
export function compararConExtraccion(
  recibido: ContratoExtraido,
  extraido: ContratoExtraido,
): Hallazgos & { evaluado: ContratoExtraido; correcciones: Correcciones } {
  const hallazgos: Hallazgos = { conflictos: [], campos: [] }
  const correcciones: Correcciones = {}
  const registrarSiDifiere = (campo: string, valorRecibido: string, valorExtraido: string) => {
    if (valorRecibido === valorExtraido) return
    hallazgos.conflictos.push(`${campo}: recibido ${valorRecibido || "(vacío)"} ≠ extraído ${valorExtraido || "(vacío)"}`)
    hallazgos.campos.push(campo)
    correcciones[campo] = { extraido: valorExtraido, final: valorRecibido }
  }
  for (const campo of CAMPOS_CON_CONFIANZA) registrarSiDifiere(campo, aTexto(recibido[campo].valor), aTexto(extraido[campo].valor))
  for (const bandera of BANDERAS) registrarSiDifiere(bandera, aTexto(recibido[bandera]), aTexto(extraido[bandera]))
  const conConfianzaExtraida = Object.fromEntries(
    CAMPOS_CON_CONFIANZA.map((campo) => [campo, { ...recibido[campo], confianza: extraido[campo].confianza, evidencia: extraido[campo].evidencia }]),
  )
  const evaluado = esquemaContratoExtraido.parse({ ...recibido, ...conConfianzaExtraida })
  return { ...hallazgos, evaluado, correcciones }
}

// ── Comparación con el maestro (RN1, RN2) ──────────────────────────────────

/**
 * Diferencias { campo: { antes, despues } } de los CAMPOS_COMPARABLES con valor extraído no null y distinto al maestro (RN2).
 * Si el contrato exige ampliar garantías y el maestro no está en "pendiente", estado_poliza → "pendiente" (msg-003).
 */
export function calcularDiferencias(contrato: ContratoExtraido, fila: FilaMaestro): Diferencias {
  const diferencias: Diferencias = {}
  for (const campo of CAMPOS_COMPARABLES) {
    const valor = contrato[campo].valor
    if (valor === null) continue
    const antes = aTexto(fila[campo])
    const despues = aTexto(valor)
    if (antes !== despues) diferencias[campo] = { antes, despues }
  }
  if (contrato.exige_ampliar_garantias && fila.estado_poliza !== "pendiente") {
    diferencias.estado_poliza = { antes: fila.estado_poliza, despues: "pendiente" }
  }
  return diferencias
}

/** Fila del maestro que corresponde al contrato: por id_contrato, o por mismo NIT y objeto similar ≥ 0.9 (RN1, RN2). */
export function buscarCoincidencia(contrato: ContratoExtraido, filas: FilaMaestro[]): Coincidencia | null {
  const id = contrato.id_contrato.valor
  const porId = id ? filas.find((fila) => fila.id_contrato === id) : undefined
  if (porId) return { fila: porId, criterio: "id" }
  const nit = contrato.nit_cliente.valor
  const objeto = contrato.objeto.valor
  if (!nit || !objeto) return null
  const porNit = filas.find((fila) => fila.nit_cliente === nit && similitudObjeto(fila.objeto, objeto) >= UMBRAL_SIMILITUD_OBJETO)
  return porNit ? { fila: porNit, criterio: "nit_objeto" } : null
}

// ── Clasificación (RN1–RN4) ────────────────────────────────────────────────

/** Arma un ResultadoClasificacion con valores por defecto vacíos. */
function resultado(clasificacion: Clasificacion, fila: FilaMaestro | null, extra: Partial<ResultadoClasificacion> = {}): ResultadoClasificacion {
  return { clasificacion, fila, diferencias: {}, conflictos: [], camposConflicto: [], motivo: null, ...extra }
}

/** RN4: sin partes identificables (ni cliente ni NIT) o contrato sin objeto → motivo de rechazo; si no, null. */
function motivoRechazo(contrato: ContratoExtraido): string | null {
  if (!contrato.cliente.valor && !contrato.nit_cliente.valor) return "El documento no identifica a la contraparte (sin cliente ni NIT)"
  if (contrato.tipo_documento === "contrato" && !contrato.objeto.valor) return "El contrato no tiene un objeto identificable"
  return null
}

/**
 * Otrosí (RN2): siempre modifica un contrato existente. Sin el id en el maestro → actualizacion con conflicto;
 * ya aplicado (sin diferencias) → duplicado, para que reprocesarlo sea idempotente.
 */
function clasificarOtrosi(contrato: ContratoExtraido, filas: FilaMaestro[]): ResultadoClasificacion {
  const id = contrato.id_contrato.valor
  const fila = id ? (filas.find((candidata) => candidata.id_contrato === id) ?? null) : null
  if (!fila) {
    const conflicto = `El otrosí modifica ${id ?? "un contrato sin número"}, que no existe en el maestro`
    return resultado("actualizacion", null, { conflictos: [conflicto], camposConflicto: ["id_contrato"] })
  }
  const diferencias = calcularDiferencias(contrato, fila)
  if (Object.keys(diferencias).length === 0) return resultado("duplicado", fila, { motivo: "El otrosí ya está aplicado en el maestro" })
  return resultado("actualizacion", fila, { diferencias })
}

/** RN1: mismo id y mismos valor, fecha_inicio y fecha_fin que la fila del maestro. */
function esDuplicado(contrato: ContratoExtraido, fila: FilaMaestro): boolean {
  return CAMPOS_RN1.every((campo) => aTexto(contrato[campo].valor) === aTexto(fila[campo]))
}

/** RN2 por coincidencia: por id con diferencias, o por NIT + objeto (con conflicto si el número difiere). */
function clasificarActualizacion(contrato: ContratoExtraido, { fila, criterio }: Coincidencia): ResultadoClasificacion {
  const diferencias = calcularDiferencias(contrato, fila)
  const hallazgos: Hallazgos = { conflictos: [], campos: [] }
  if (criterio === "nit_objeto" && contrato.id_contrato.valor !== fila.id_contrato) {
    hallazgos.conflictos.push(`Coincide con ${fila.id_contrato} por NIT y objeto pero el número es distinto`)
    hallazgos.campos.push("id_contrato")
  }
  const sinComparar = CAMPOS_RN1.filter((campo) => contrato[campo].valor === null)
  if (sinComparar.length > 0) {
    hallazgos.conflictos.push(`No se pudo comparar con ${fila.id_contrato}: falta ${sinComparar.join(", ")} en el contrato`)
    hallazgos.campos.push(...sinComparar)
  }
  return resultado("actualizacion", fila, { diferencias, conflictos: hallazgos.conflictos, camposConflicto: hallazgos.campos })
}

/**
 * Clasifica el contrato frente al maestro en este orden: RN4 rechazado → otrosí → RN1 duplicado → RN2 actualización → RN3 nuevo.
 * RN1 va antes que RN2 para que un reenvío idéntico nunca sea actualización (msg-004).
 */
export function clasificarContrato(contrato: ContratoExtraido, filas: FilaMaestro[]): ResultadoClasificacion {
  const rechazo = motivoRechazo(contrato)
  if (rechazo) return resultado("rechazado", null, { motivo: rechazo })
  if (contrato.tipo_documento === "otrosi") return clasificarOtrosi(contrato, filas)
  const coincidencia = buscarCoincidencia(contrato, filas)
  if (!coincidencia) return resultado("nuevo", null)
  if (coincidencia.criterio === "id" && esDuplicado(contrato, coincidencia.fila)) {
    return resultado("duplicado", coincidencia.fila, { motivo: `Ya existe ${coincidencia.fila.id_contrato} con el mismo valor y fechas` })
  }
  return clasificarActualizacion(contrato, coincidencia)
}

// ── Consistencia y revisión (RN5) ──────────────────────────────────────────

/**
 * Chequeos de consistencia que van a conflictos y a revisión (HU-3): fecha_fin anterior a fecha_inicio
 * (con valores efectivos: extraído o, si falta, el del maestro) y mismo id con NIT distinto al del maestro.
 */
export function revisarConsistencia(contrato: ContratoExtraido, fila: FilaMaestro | null): Hallazgos {
  const hallazgos: Hallazgos = { conflictos: [], campos: [] }
  const inicio = contrato.fecha_inicio.valor ?? fila?.fecha_inicio ?? null
  const fin = contrato.fecha_fin.valor ?? fila?.fecha_fin ?? null
  if (inicio && fin && diasEntre(inicio, fin) < 0) {
    hallazgos.conflictos.push(`fecha_fin ${fin} es anterior a fecha_inicio ${inicio}`)
    hallazgos.campos.push("fecha_fin")
  }
  const nit = contrato.nit_cliente.valor
  if (fila && nit && fila.id_contrato === contrato.id_contrato.valor && fila.nit_cliente !== nit) {
    hallazgos.conflictos.push(`${fila.id_contrato} existe en el maestro con NIT ${fila.nit_cliente}, pero el contrato trae ${nit}`)
    hallazgos.campos.push("nit_cliente")
  }
  return hallazgos
}

/** Confianza de un campo de diferencias; estado_poliza es derivado de la cláusula explícita "deberán ampliarse" (EXPLICITO). */
function confianzaDe(contrato: ContratoExtraido, campo: string): number {
  if (esCampoConConfianza(campo)) return contrato[campo].confianza
  return campo === "estado_poliza" && contrato.exige_ampliar_garantias ? CONFIANZA.EXPLICITO : CONFIANZA.AUSENTE
}

/**
 * RN5: campos con confianza < UMBRAL_CONFIANZA. Nuevo → todos los del registro (tipo_poliza solo si requiere póliza);
 * actualización → solo los que cambian; duplicado y rechazado → ninguno (no se escribe nada).
 */
export function calcularRequiereRevision(contrato: ContratoExtraido, clasificacion: Clasificacion, diferencias: Diferencias): string[] {
  if (clasificacion === "nuevo") {
    const campos = contrato.requiere_poliza.valor === true ? [...CAMPOS_REVISION_NUEVO, "tipo_poliza" as const] : CAMPOS_REVISION_NUEVO
    return ordenarCampos(campos.filter((campo) => contrato[campo].confianza < UMBRAL_CONFIANZA))
  }
  if (clasificacion === "actualizacion") {
    return ordenarCampos(Object.keys(diferencias).filter((campo) => confianzaDe(contrato, campo) < UMBRAL_CONFIANZA))
  }
  return []
}

// ── Orquestación ───────────────────────────────────────────────────────────

/**
 * Valida un contrato recibido (HU-3): lo compara con la re-extracción (CA2), lo clasifica (RN1–RN4), revisa consistencia
 * y arma requiere_revision (RN5) sin repetidos y en orden estable. Rechazado → sin campos a revisar.
 * Devuelve además las correcciones { extraido, final } para el historial de registrar (HU-4).
 */
export function validarContrato(entrada: {
  recibido: ContratoExtraido
  extraido: ContratoExtraido
  filas: FilaMaestro[]
}): ResultadoContrato & { correcciones: Correcciones } {
  const comparacion = compararConExtraccion(entrada.recibido, entrada.extraido)
  const contrato = comparacion.evaluado
  const clasificacion = clasificarContrato(contrato, entrada.filas)
  const consistencia = revisarConsistencia(contrato, clasificacion.fila)
  const revision = [
    ...calcularRequiereRevision(contrato, clasificacion.clasificacion, clasificacion.diferencias),
    ...comparacion.campos,
    ...clasificacion.camposConflicto,
    ...consistencia.campos,
  ]
  return {
    clasificacion: clasificacion.clasificacion,
    id_contrato_existente: clasificacion.fila?.id_contrato ?? null,
    requiere_revision: clasificacion.clasificacion === "rechazado" ? [] : ordenarCampos(revision),
    conflictos: [...comparacion.conflictos, ...clasificacion.conflictos, ...consistencia.conflictos],
    diferencias: clasificacion.diferencias,
    motivo: clasificacion.motivo,
    correcciones: comparacion.correcciones,
  }
}

/** Resultado para un mensaje cuyo adjunto no se pudo extraer como contrato (RN4): rechazado con ese motivo. */
export function rechazarSinExtraccion(motivo: string): ResultadoContrato {
  return { clasificacion: "rechazado", id_contrato_existente: null, requiere_revision: [], conflictos: [], diferencias: {}, motivo }
}
