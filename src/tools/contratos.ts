// Herramientas del agente (cada export → contratos_<export>); solo definiciones, la lógica vive en src/tools/dominio/.
import { extraerContratoDelMensaje, leerCorreo, listarMensajesPendientes } from "./dominio/buzon"
import { rechazarSinExtraccion, validarContrato } from "./dominio/clasificacion"
import { resolverComercial } from "./dominio/comerciales"
import { camposBajoUmbral } from "./dominio/extraccion"
import { ejecutarConSeguridad, esquemaMensajeId, validarArgumentos, type Herramienta } from "./dominio/herramienta"
import { leerMaestro } from "./dominio/maestro"
import { esquemaContratoExtraido, type ResultadoValidacion } from "./dominio/tipos"

const ARGS_EXTRAER = { mensaje_id: esquemaMensajeId }

const ARGS_VALIDAR = {
  mensaje_id: esquemaMensajeId,
  contrato: esquemaContratoExtraido.describe(
    "Contrato tal como lo devolvió contratos_extraer (o con valores corregidos); se compara con una nueva extracción del adjunto",
  ),
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
      const [filas, correo] = await Promise.all([leerMaestro(ctx), leerCorreo(ctx, mensaje_id)])
      const extraccion = await extraerContratoDelMensaje(ctx, mensaje_id, correo)
      const resultado = extraccion.ok
        ? validarContrato({ recibido: contrato, extraido: extraccion.data.contrato, filas })
        : rechazarSinExtraccion(extraccion.error)
      const data: ResultadoValidacion = { ...resultado, comercial: await resolverComercial(ctx, correo.de) }
      return { data, resumen: `${data.clasificacion}; revisión: ${data.requiere_revision.join(", ") || "ninguna"}` }
    })
  },
}
