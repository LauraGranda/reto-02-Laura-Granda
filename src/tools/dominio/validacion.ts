// Validación de un mensaje con archivos: una sola ruta para contratos_validar, contratos_registrar y contratos_descartar.
import { extraerContratoDelMensaje, leerCorreo } from "./buzon"
import { rechazarSinExtraccion, validarContrato } from "./clasificacion"
import { resolverComercial } from "./comerciales"
import { leerMaestro } from "./maestro"
import type { ContextoHerramienta, ContratoExtraido, Correcciones, Correo, FilaMaestro, ResultadoValidacion } from "./tipos"

/** Todo lo que se sabe de un mensaje tras validarlo; registrar lo usa para escribir sin volver a leer. */
export type MensajeValidado = {
  correo: Correo
  filas: FilaMaestro[]
  adjunto: string | null
  contrato: ContratoExtraido | null
  resultado: ResultadoValidacion
  correcciones: Correcciones
}

/**
 * Valida un mensaje (HU-3): lee maestro (RN6) y correo, re-extrae el adjunto (CA2), clasifica (RN1–RN5) y resuelve el comercial.
 * Con `recibido` null se valida lo extraído (descartar). Es la MISMA lógica para validar y registrar: el modelo no puede saltársela.
 */
export async function validarMensaje(
  ctx: ContextoHerramienta,
  mensajeId: string,
  recibido: ContratoExtraido | null,
): Promise<MensajeValidado> {
  const [filas, correo] = await Promise.all([leerMaestro(ctx), leerCorreo(ctx, mensajeId)])
  const [extraccion, comercial] = await Promise.all([extraerContratoDelMensaje(ctx, mensajeId, correo), resolverComercial(ctx, correo.de)])
  if (!extraccion.ok) {
    const resultado = { ...rechazarSinExtraccion(extraccion.error), comercial }
    return { correo, filas, adjunto: null, contrato: null, resultado, correcciones: {} }
  }
  const contrato = recibido ?? extraccion.data.contrato
  const { correcciones, ...validacion } = validarContrato({ recibido: contrato, extraido: extraccion.data.contrato, filas })
  return { correo, filas, adjunto: extraccion.data.adjunto, contrato, resultado: { ...validacion, comercial }, correcciones }
}
