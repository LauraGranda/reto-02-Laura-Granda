// Herramientas del agente (cada export → contratos_<export>); solo definiciones, la lógica vive en src/tools/dominio/.
import { z } from "zod"
import { calcularSecciones, generarReporteMarkdown } from "./dominio/alertas"
import { escribirArchivoAtomico } from "./dominio/archivos"
import { extraerContratoDelMensaje, leerCorreo, listarMensajesPendientes } from "./dominio/buzon"
import { camposBajoUmbral } from "./dominio/extraccion"
import { ejecutarConSeguridad, esquemaMensajeId, validarArgumentos, type Herramienta } from "./dominio/herramienta"
import { leerHistorial, leerMaestro } from "./dominio/maestro"
import { descartarMensaje, registrarMensaje } from "./dominio/registro"
import { rutaAlertas } from "./dominio/rutas"
import { esquemaContratoExtraido, esquemaFecha } from "./dominio/tipos"
import { validarMensaje } from "./dominio/validacion"

const ARGS_EXTRAER = { mensaje_id: esquemaMensajeId }

const ARGS_VALIDAR = {
  mensaje_id: esquemaMensajeId,
  contrato: esquemaContratoExtraido.describe(
    "Contrato tal como lo devolvió contratos_extraer (o con valores corregidos); se compara con una nueva extracción del adjunto",
  ),
}

const ARGS_REGISTRAR = {
  mensaje_id: esquemaMensajeId,
  contrato: esquemaContratoExtraido.describe(
    "Contrato a registrar, el mismo que se validó; con confirmado=true sus valores se toman como la corrección humana",
  ),
  confirmado: z
    .boolean()
    .optional()
    .describe("true solo si el usuario confirmó explícitamente los campos en revisión en su último mensaje"),
}

const ARGS_ALERTAS = { hoy: esquemaFecha.describe("Fecha de referencia en formato YYYY-MM-DD") }

const ARGS_DESCARTAR = {
  mensaje_id: esquemaMensajeId,
  motivo: z.string().min(1).describe("Motivo legible por el que el mensaje no se registra (ej. es una cotización, ya existe)"),
}

/** mensaje_id recibido, solo si es texto, para dejarlo en el log aunque sea inválido (RN7). */
function idParaLog(valor: unknown): string | null {
  return typeof valor === "string" ? valor : null
}

/** contratos_leer_buzon (HU-1): mensajes pendientes y si cada uno trae contrato; los que no, prerrechazados (RN4). */
export const leer_buzon: Herramienta<{}> = {
  description:
    "Lista los mensajes del buzón de contratos que aún no se han procesado e indica si cada uno trae un contrato.",
  args: {},
  async execute(_args, ctx) {
    return ejecutarConSeguridad("contratos_leer_buzon", null, ctx, async () => {
      const mensajes = await listarMensajesPendientes(ctx)
      const sinContrato = mensajes.filter((mensaje) => !mensaje.tiene_contrato).length
      return {
        data: { mensajes, total_pendientes: mensajes.length },
        resumen: `${mensajes.length} pendientes, ${sinContrato} sin contrato`,
      }
    })
  },
}

/** contratos_extraer (HU-2): datos del contrato adjunto con confianza y evidencia por campo; no toca el maestro. */
export const extraer: Herramienta<typeof ARGS_EXTRAER> = {
  description: "Extrae los datos del contrato adjunto a un mensaje del buzón, con confianza y evidencia por campo.",
  args: ARGS_EXTRAER,
  async execute(args, ctx) {
    return ejecutarConSeguridad("contratos_extraer", idParaLog(args.mensaje_id), ctx, async () => {
      const { mensaje_id } = validarArgumentos(ARGS_EXTRAER, args)
      const correo = await leerCorreo(ctx, mensaje_id)
      const extraccion = await extraerContratoDelMensaje(ctx, mensaje_id, correo)
      if (!extraccion.ok) throw new Error(extraccion.error)
      const { adjunto, contrato } = extraccion.data
      const bajos = camposBajoUmbral(contrato)
      return {
        data: { mensaje_id, adjunto, contrato },
        resumen: `${contrato.id_contrato.valor ?? "sin id"}; campos < 0.8: ${bajos.join(", ") || "ninguno"}`,
      }
    })
  },
}

/**
 * contratos_validar (HU-3): re-extrae el adjunto (CA2), clasifica contra el maestro (RN1–RN4), marca revisión (RN5)
 * y resuelve el comercial. Solo escribe la copia inicial del maestro (RN6) y el log (RN7).
 */
export const validar: Herramienta<typeof ARGS_VALIDAR> = {
  description:
    "Compara un contrato extraído contra el maestro y lo clasifica como nuevo, actualización, duplicado o rechazado, indicando qué campos requieren revisión humana.",
  args: ARGS_VALIDAR,
  async execute(args, ctx) {
    return ejecutarConSeguridad("contratos_validar", idParaLog(args.mensaje_id), ctx, async () => {
      const { mensaje_id, contrato } = validarArgumentos(ARGS_VALIDAR, args)
      const { resultado } = await validarMensaje(ctx, mensaje_id, contrato)
      return { data: resultado, resumen: `${resultado.clasificacion}; revisión: ${resultado.requiere_revision.join(", ") || "ninguna"}` }
    })
  },
}

/**
 * contratos_registrar (HU-4): repite la validación completa (CA2), exige confirmado=true si hay campos en revisión (RN5),
 * escribe maestro, archivo e historial según la clasificación y marca el mensaje como procesado.
 */
export const registrar: Herramienta<typeof ARGS_REGISTRAR> = {
  description:
    "Registra en el maestro un contrato ya validado y archiva el documento; si hay campos en revisión, solo escribe con confirmado=true.",
  args: ARGS_REGISTRAR,
  async execute(args, ctx) {
    return ejecutarConSeguridad("contratos_registrar", idParaLog(args.mensaje_id), ctx, async () => {
      const { mensaje_id, contrato, confirmado } = validarArgumentos(ARGS_REGISTRAR, args)
      const data = await registrarMensaje(ctx, mensaje_id, contrato, confirmado === true)
      return { data, resumen: `${data.id_contrato || "sin id"} ${data.accion}${confirmado ? " (confirmado)" : ""}` }
    })
  },
}

/** contratos_descartar (RN4, RN1): cierra un mensaje rechazado o duplicado sin tocar el maestro. */
export const descartar: Herramienta<typeof ARGS_DESCARTAR> = {
  description: "Marca como procesado un mensaje que no se registra (rechazado o duplicado) sin modificar el maestro.",
  args: ARGS_DESCARTAR,
  async execute(args, ctx) {
    return ejecutarConSeguridad("contratos_descartar", idParaLog(args.mensaje_id), ctx, async () => {
      const { mensaje_id, motivo } = validarArgumentos(ARGS_DESCARTAR, args)
      const data = await descartarMensaje(ctx, mensaje_id, motivo)
      return { data, resumen: `${data.clasificacion} descartado: ${motivo}` }
    })
  },
}

/**
 * contratos_alertas (HU-5, O4): reporte para gerencia en out/alertas.md con contratos por vencer (≤ 60 días), pólizas
 * no vigentes y registrados desde el corte, más dos secciones informativas. `hoy` es argumento para que sea determinista.
 */
export const alertas: Herramienta<typeof ARGS_ALERTAS> = {
  description:
    "Genera el reporte de alertas para gerencia con contratos por vencer, pólizas no vigentes y contratos registrados desde el corte.",
  args: ARGS_ALERTAS,
  async execute(args, ctx) {
    return ejecutarConSeguridad("contratos_alertas", null, ctx, async () => {
      const { hoy } = validarArgumentos(ARGS_ALERTAS, args)
      const [filas, historial] = await Promise.all([leerMaestro(ctx), leerHistorial(ctx)])
      const secciones = calcularSecciones(filas, historial, hoy)
      await escribirArchivoAtomico(rutaAlertas(ctx.directory), generarReporteMarkdown(secciones, hoy))
      const { vencen, polizas_pendientes, registrados_desde_corte } = secciones
      return {
        data: { ruta: "out/alertas.md", ...secciones },
        resumen: `hoy ${hoy}: ${vencen.length} vencen, ${polizas_pendientes.length} pólizas, ${registrados_desde_corte.length} registrados`,
      }
    })
  },
}
