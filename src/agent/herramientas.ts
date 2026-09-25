// Registro de herramientas para el ciclo del agente: nombre "contratos_<export>", JSON Schema para el modelo y ejecución validada (6.2).
import { z } from "zod"
import { esObjeto, type DefinicionHerramienta } from "../llm/adapter"
import * as herramientas from "../tools/contratos"
import { camposBajoUmbral } from "../tools/dominio/extraccion"
import type { Herramienta } from "../tools/dominio/herramienta"
import { esquemaContratoExtraido, esquemaResultadoValidacion, type ContextoHerramienta } from "../tools/dominio/tipos"

const LARGO_RESUMEN = 200

/** Herramienta lista para el ciclo: definición para el modelo, validación de argumentos y ejecución validada. */
export type EntradaRegistro = DefinicionHerramienta & {
  /** Error legible si los argumentos no cumplen el esquema zod; null si son válidos (6.2). */
  validar(args: unknown): string | null
  ejecutar(args: unknown, ctx: ContextoHerramienta): Promise<string>
}

/** Resultado de una herramienta ya parseado: { ok, data } o { ok: false, error }. */
type ResultadoLeido = { ok: true; data: Record<string, unknown> } | { ok: false; error: string }

/** Objeto plano o vacío: el JSON Schema de zod siempre es un objeto, pero se valida sin castear. */
function aObjeto(valor: unknown): Record<string, unknown> {
  return esObjeto(valor) ? valor : {}
}

/**
 * Convierte una herramienta en una entrada del registro (6.2): el backend valida los argumentos con su esquema zod
 * antes de ejecutar y, si no cumplen, devuelve el error al modelo sin ejecutar. Recibe la forma general
 * Herramienta<ZodRawShape>: cada herramienta concreta encaja porque `execute` es un método (parámetros bivariantes).
 */
function aEntrada(nombreExport: string, herramienta: Herramienta<z.ZodRawShape>): EntradaRegistro {
  const esquema = z.object(herramienta.args)
  /** Mensaje legible con cada problema de validación. */
  const describirError = (error: z.ZodError) =>
    `Argumentos inválidos: ${error.issues.map((p) => `${p.path.join(".") || "args"}: ${p.message}`).join("; ")}`
  return {
    nombre: `contratos_${nombreExport}`,
    descripcion: herramienta.description,
    // Esquema de ENTRADA: los campos con valor por defecto (valor/evidencia null) son opcionales para el modelo
    parametros: aObjeto(z.toJSONSchema(esquema, { io: "input" })),
    validar(args) {
      const resultado = esquema.safeParse(args)
      return resultado.success ? null : describirError(resultado.error)
    },
    async ejecutar(args, ctx) {
      const resultado = esquema.safeParse(args)
      if (resultado.success) return herramienta.execute(resultado.data, ctx)
      return JSON.stringify({ ok: false, error: describirError(resultado.error) })
    },
  }
}

/** Registro de todas las herramientas exportadas por src/tools/contratos.ts, en su orden de exportación. */
const REGISTRO: readonly EntradaRegistro[] = Object.entries(herramientas).map(([nombre, herramienta]) => aEntrada(nombre, herramienta))

/** Definiciones que el adaptador envía al modelo (nombre, descripción y JSON Schema de los argumentos). */
export function obtenerDefiniciones(): DefinicionHerramienta[] {
  return REGISTRO.map(({ nombre, descripcion, parametros }) => ({ nombre, descripcion, parametros }))
}

/** Busca una herramienta por el nombre que usa el modelo; undefined si no existe. */
export function buscarHerramienta(nombre: string): EntradaRegistro | undefined {
  return REGISTRO.find((entrada) => entrada.nombre === nombre)
}

/** Lee la respuesta string de una herramienta como { ok, data } o { ok: false, error } (6.2). */
export function leerResultado(respuesta: string): ResultadoLeido {
  try {
    const valor: unknown = JSON.parse(respuesta)
    if (esObjeto(valor) && valor.ok === true) return { ok: true, data: aObjeto(valor.data) }
    if (esObjeto(valor) && typeof valor.error === "string") return { ok: false, error: valor.error }
  } catch {
    // respuesta que no es JSON: se trata como error legible abajo
  }
  return { ok: false, error: "La herramienta devolvió una respuesta ilegible" }
}

/** Resumen de una respuesta exitosa según la herramienta, en lenguaje de la analista (sin JSON crudo). */
function resumirExito(nombre: string, data: Record<string, unknown>): string {
  if (nombre === "contratos_leer_buzon") {
    const mensajes = Array.isArray(data.mensajes) ? data.mensajes : []
    const sinContrato = mensajes.filter((m) => esObjeto(m) && m.tiene_contrato === false).length
    return `${String(data.total_pendientes ?? mensajes.length)} pendientes, ${sinContrato} sin contrato`
  }
  if (nombre === "contratos_extraer") {
    const contrato = esquemaContratoExtraido.safeParse(data.contrato)
    if (!contrato.success) return "contrato extraído"
    return `${contrato.data.id_contrato.valor ?? "sin número"} extraído; en revisión: ${camposBajoUmbral(contrato.data).join(", ") || "ninguno"}`
  }
  if (nombre === "contratos_validar") {
    const validacion = esquemaResultadoValidacion.safeParse(data)
    if (!validacion.success) return "validado"
    const { clasificacion, id_contrato_existente, requiere_revision } = validacion.data
    return `${clasificacion}${id_contrato_existente ? ` (${id_contrato_existente})` : ""}; revisión: ${requiere_revision.join(", ") || "ninguna"}`
  }
  if (nombre === "contratos_registrar") return `${String(data.accion ?? "registrado")} ${String(data.id_contrato ?? "")}`.trim()
  if (nombre === "contratos_descartar") return `descartado (${String(data.clasificacion ?? "")})`
  if (nombre === "contratos_alertas") return `reporte en ${String(data.ruta ?? "out/alertas.md")}`
  return "ok"
}

/** Resumen corto (≤ 200 caracteres) de una llamada para el historial visible del chat (CA4). */
export function resumirResultado(nombre: string, respuesta: string): string {
  const resultado = leerResultado(respuesta)
  const texto = resultado.ok ? resumirExito(nombre, resultado.data) : resultado.error
  return texto.length <= LARGO_RESUMEN ? texto : `${texto.slice(0, LARGO_RESUMEN - 1)}…`
}
