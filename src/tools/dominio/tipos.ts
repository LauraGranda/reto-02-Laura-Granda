// Esquemas zod y tipos derivados (z.infer) del dominio: correo, contrato extraído, fila del maestro.
import { z } from "zod"
import { esFechaValida } from "./fechas"
import { LARGO_MAXIMO_OBJETO } from "./reglas"

// ── Enumeraciones (7.2, 6.2) ──────────────────────────────────────────────

/** Países permitidos en la columna `pais` del maestro (7.2). */
export const PAISES = ["CO", "EC", "PE", "PA", "HN"] as const
export const esquemaPais = z.enum(PAISES)
export type Pais = z.infer<typeof esquemaPais>

/** Monedas permitidas en la columna `moneda` del maestro (7.2). */
export const MONEDAS = ["COP", "USD", "PEN", "PAB", "HNL"] as const
export const esquemaMoneda = z.enum(MONEDAS)
export type Moneda = z.infer<typeof esquemaMoneda>

/** Estados de la columna `estado_poliza` del maestro (7.2). */
export const ESTADOS_POLIZA = ["vigente", "pendiente", "vencida", "no_aplica"] as const
export const esquemaEstadoPoliza = z.enum(ESTADOS_POLIZA)
export type EstadoPoliza = z.infer<typeof esquemaEstadoPoliza>

/** Clasificaciones posibles de un mensaje según RN1–RN4 (HU-3). */
export const CLASIFICACIONES = ["nuevo", "actualizacion", "duplicado", "rechazado"] as const
export const esquemaClasificacion = z.enum(CLASIFICACIONES)
export type Clasificacion = z.infer<typeof esquemaClasificacion>

/** Tipo de documento adjunto; un otrosí fuerza la clasificación `actualizacion` (RN2). */
export const TIPOS_DOCUMENTO = ["contrato", "otrosi"] as const
export const esquemaTipoDocumento = z.enum(TIPOS_DOCUMENTO)
export type TipoDocumento = z.infer<typeof esquemaTipoDocumento>

/** Origen de la fila en la columna `fuente` del maestro (7.2). */
export const FUENTES = ["buzon", "manual", "migracion"] as const
export const esquemaFuente = z.enum(FUENTES)
export type Fuente = z.infer<typeof esquemaFuente>

// ── Primitivos ─────────────────────────────────────────────────────────────

/** Fecha real como string YYYY-MM-DD (7.2); "2026-02-30" se rechaza (HU-6). Texto para evitar zonas horarias. */
export const esquemaFecha = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha debe tener formato YYYY-MM-DD")
  .refine(esFechaValida, "Fecha inexistente")
export type Fecha = z.infer<typeof esquemaFecha>

// ── Contrato extraído (6.2 contratos_extraer, HU-2) ─────────────────────────

/**
 * Fábrica de un campo extraído con su confianza (HU-2): valor null si no está en el texto,
 * confianza en [0, 1] y un fragmento corto del texto como evidencia.
 */
export function esquemaCampoExtraido<T extends z.ZodType>(esquemaValor: T) {
  return z.object({
    valor: esquemaValor.nullable(),
    confianza: z.number().min(0).max(1),
    evidencia: z.string().max(120).nullable(),
  })
}
export type CampoExtraido<T> = z.infer<ReturnType<typeof esquemaCampoExtraido<z.ZodType<T>>>>

/**
 * Salida de `contratos_extraer` (HU-2, 7.2): cada columna del maestro con confianza por campo,
 * más banderas de valor por demanda y de ampliación de garantías (otrosíes).
 */
export const esquemaContratoExtraido = z.object({
  tipo_documento: esquemaTipoDocumento,
  id_contrato: esquemaCampoExtraido(z.string().min(1)),
  cliente: esquemaCampoExtraido(z.string().min(1)),
  nit_cliente: esquemaCampoExtraido(z.string().regex(/^\d+$/, "NIT sin puntos ni dígito de verificación")),
  pais: esquemaCampoExtraido(esquemaPais),
  objeto: esquemaCampoExtraido(z.string().min(1).max(LARGO_MAXIMO_OBJETO)),
  valor: esquemaCampoExtraido(z.number().nonnegative()),
  moneda: esquemaCampoExtraido(esquemaMoneda),
  fecha_inicio: esquemaCampoExtraido(esquemaFecha),
  fecha_fin: esquemaCampoExtraido(esquemaFecha),
  requiere_poliza: esquemaCampoExtraido(z.boolean()),
  tipo_poliza: esquemaCampoExtraido(z.string()),
  valor_indeterminado: z.boolean(),
  exige_ampliar_garantias: z.boolean(),
})
export type ContratoExtraido = z.infer<typeof esquemaContratoExtraido>

// ── Maestro (7.2) ──────────────────────────────────────────────────────────

/** Columnas del maestro en el mismo orden del CSV del fixture (7.2); se usa para leer y escribir el CSV. */
export const COLUMNAS_MAESTRO = [
  "id_contrato",
  "cliente",
  "nit_cliente",
  "pais",
  "objeto",
  "valor",
  "moneda",
  "fecha_inicio",
  "fecha_fin",
  "requiere_poliza",
  "tipo_poliza",
  "estado_poliza",
  "comercial",
  "ruta_sharepoint",
  "fecha_registro",
  "fuente",
] as const

/** Una fila del maestro de contratos (7.2), ya con tipos: valor numérico y requiere_poliza booleano. */
export const esquemaFilaMaestro = z.object({
  id_contrato: z.string().min(1),
  cliente: z.string().min(1),
  nit_cliente: z.string().min(1),
  pais: esquemaPais,
  objeto: z.string().max(LARGO_MAXIMO_OBJETO),
  valor: z.number().nonnegative(),
  moneda: esquemaMoneda,
  fecha_inicio: esquemaFecha,
  fecha_fin: esquemaFecha,
  requiere_poliza: z.boolean(),
  tipo_poliza: z.string(),
  estado_poliza: esquemaEstadoPoliza,
  comercial: z.string(),
  ruta_sharepoint: z.string(),
  fecha_registro: esquemaFecha,
  fuente: esquemaFuente,
})
export type FilaMaestro = z.infer<typeof esquemaFilaMaestro>

// ── Buzón (6.2 contratos_leer_buzon, HU-1) ─────────────────────────────────

/** Contenido de fixtures/reto-02/buzon/<id>/correo.json (7.1); se valida al leerlo. */
export const esquemaCorreo = z.object({
  id: z.string(),
  de: z.string(),
  para: z.string(),
  asunto: z.string(),
  fecha: z.string(),
  cuerpo: z.string(),
  adjuntos: z.array(z.string()),
})
export type Correo = z.infer<typeof esquemaCorreo>

/** Resumen de un mensaje del buzón que devuelve `contratos_leer_buzon` (HU-1, 7.1). */
export const esquemaMensajeBuzon = z.object({
  id: z.string().min(1),
  de: z.string(),
  asunto: z.string(),
  fecha: z.string(),
  adjuntos: z.array(z.string()),
  tiene_contrato: z.boolean(),
  clasificacion_previa: z.literal("rechazado").nullable(),
  motivo: z.string().nullable(),
})
export type MensajeBuzon = z.infer<typeof esquemaMensajeBuzon>

// ── Validación (6.2 contratos_validar, HU-3) ───────────────────────────────

/** Cambios campo a campo `{ campo: { antes, despues } }`; lo usan validar (RN2) y el historial (HU-4). */
export const esquemaDiferencias = z.record(z.string(), z.object({ antes: z.string(), despues: z.string() }))
export type Diferencias = z.infer<typeof esquemaDiferencias>

/**
 * Salida de `contratos_validar` (HU-3): clasificación RN1–RN4, campos en revisión (RN5), conflictos legibles
 * (con el maestro o con la re-extracción), diferencias contra el maestro y el comercial resuelto desde comerciales.json.
 */
export const esquemaResultadoValidacion = z.object({
  clasificacion: esquemaClasificacion,
  id_contrato_existente: z.string().nullable(),
  requiere_revision: z.array(z.string()),
  conflictos: z.array(z.string()),
  diferencias: esquemaDiferencias,
  comercial: z.object({
    email: z.string(),
    nombre: z.string().nullable(),
    registrado: z.boolean(),
  }),
  motivo: z.string().nullable(),
})
export type ResultadoValidacion = z.infer<typeof esquemaResultadoValidacion>

// ── Archivos de apoyo (7.1, HU-4, RN7) ─────────────────────────────────────

/** Un comercial de fixtures/reto-02/comerciales.json (7.1); se usa para resolver el remitente (HU-3). */
export const esquemaComercial = z.object({
  email: z.string(),
  nombre: z.string(),
  region: z.string(),
})
export type Comercial = z.infer<typeof esquemaComercial>

/** Estado de un mensaje en out/procesados.json (HU-1, HU-4); un mensaje presente ya no se lista en el buzón. */
export const esquemaRegistroProcesado = z.object({
  clasificacion: esquemaClasificacion,
  accion: z.string(),
  ts: z.string(),
})
export type RegistroProcesado = z.infer<typeof esquemaRegistroProcesado>

/** Contenido completo de out/procesados.json: `{ [mensaje_id]: RegistroProcesado }`. */
export const esquemaProcesados = z.record(z.string(), esquemaRegistroProcesado)
export type Procesados = z.infer<typeof esquemaProcesados>

/** Una línea de out/sharepoint/historial.jsonl (HU-4, RN2); confirmado_por queda cuando hubo confirmación humana. */
export const esquemaEntradaHistorial = z.object({
  ts: z.string(),
  id_contrato: z.string(),
  accion: z.string(),
  cambios: esquemaDiferencias,
  mensaje_id: z.string(),
  confirmado_por: z.string().optional(),
})
export type EntradaHistorial = z.infer<typeof esquemaEntradaHistorial>

/** Una línea de out/log.jsonl que deja cada herramienta (RN7, CA4). */
export const esquemaEntradaLog = z.object({
  ts: z.string(),
  herramienta: z.string(),
  mensaje_id: z.string().nullable(),
  ok: z.boolean(),
  resumen: z.string(),
})
export type EntradaLog = z.infer<typeof esquemaEntradaLog>

// ── Contrato de herramientas (6.2) ─────────────────────────────────────────

/** Respuesta de toda herramienta antes de serializarse a JSON (6.2): éxito con data o error legible. */
export type ResultadoHerramienta<T> = { ok: true; data: T } | { ok: false; error: string }

/** Contexto que recibe `execute(args, ctx)` (6.2): raíz del proyecto y sesión actual. */
export const esquemaContextoHerramienta = z.object({
  directory: z.string(),
  sessionId: z.string(),
})
export type ContextoHerramienta = z.infer<typeof esquemaContextoHerramienta>
