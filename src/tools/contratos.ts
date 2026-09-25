// Herramientas del agente (cada export → contratos_<export>); solo definiciones, la lógica vive en src/tools/dominio/.
import { evaluarAdjuntos, leerCorreo, listarMensajesPendientes } from "./dominio/buzon"
import { camposBajoUmbral, extraerContrato } from "./dominio/extraccion"
import { ejecutarConSeguridad, esquemaMensajeId, validarArgumentos, type Herramienta } from "./dominio/herramienta"

const ARGS_EXTRAER = { mensaje_id: esquemaMensajeId }

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
    const idRecibido = typeof args.mensaje_id === "string" ? args.mensaje_id : null
    return ejecutarConSeguridad("contratos_extraer", idRecibido, ctx, async () => {
      const { mensaje_id } = validarArgumentos(ARGS_EXTRAER, args)
      const correo = await leerCorreo(ctx, mensaje_id)
      const evaluacion = await evaluarAdjuntos(ctx, mensaje_id, correo)
      if (evaluacion.adjunto === null) throw new Error(evaluacion.motivo)
      const resultado = extraerContrato(evaluacion.adjunto.texto, { fecha: correo.fecha.slice(0, 10) })
      if (!resultado.ok) throw new Error(resultado.error)
      const bajos = camposBajoUmbral(resultado.data)
      return {
        data: { mensaje_id, adjunto: evaluacion.adjunto.nombre, contrato: resultado.data },
        resumen: `${resultado.data.id_contrato.valor ?? "sin id"}; campos < 0.8: ${bajos.join(", ") || "ninguno"}`,
      }
    })
  },
}
