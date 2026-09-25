// Constantes de reglas de negocio: umbral de confianza, días de alerta, fecha de corte, catálogos.

/** Confianza mínima para registrar sin revisión humana; por debajo va a requiere_revision (RN5, O3). */
export const UMBRAL_CONFIANZA = 0.8

/** Similitud mínima de objeto (con mismo nit_cliente) para tratar un contrato como actualización (RN2). */
export const UMBRAL_SIMILITUD_OBJETO = 0.9

/** Días hacia adelante desde `hoy` para alertar vencimientos (HU-5, O4). */
export const DIAS_ALERTA_VENCIMIENTO = 60

/** Fecha en que se congeló el maestro; lo registrado después es "gap cubierto" (PRD 1, HU-5). */
export const FECHA_CORTE_MAESTRO = "2026-05-30"

/** Largo máximo de la columna `objeto` del maestro (esquema 7.2). */
export const LARGO_MAXIMO_OBJETO = 200

/** NIT de Periferia (contratista); nunca debe tomarse como nit_cliente (resultados esperados msg-001). */
export const NIT_PERIFERIA = "900123456"

/**
 * Niveles de confianza por campo extraído (HU-2, RN5):
 * - EXPLICITO: el valor aparece literal en el texto (ej. "Valor: $265.000.000").
 * - INFERIDO_PROXY: se toma de una fuente cercana y confiable (ej. firma sin día → fecha del correo). Justo en el umbral.
 * - DERIVADO: se calcula a partir de otro dato (ej. fecha_fin = inicio + 12 meses). Pide revisión.
 * - AMBIGUO: el texto admite varias lecturas (ej. valor "por demanda", póliza condicional). Pide revisión.
 * - AUSENTE: no está en el texto; el valor es null, nunca inventado.
 */
export const CONFIANZA = {
  EXPLICITO: 0.95,
  INFERIDO_PROXY: 0.8,
  DERIVADO: 0.6,
  AMBIGUO: 0.5,
  AUSENTE: 0,
} as const
