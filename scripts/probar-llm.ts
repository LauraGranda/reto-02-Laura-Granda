// Prueba MANUAL de conexión con el proveedor configurado en .env (no es un test automático: usa red y la clave).
// Uso en PowerShell: bun run probar-llm
import { ErrorProveedor, type DefinicionHerramienta, type MensajeConversacion, type RespuestaModelo } from "../src/llm/adapter"
import { crearProveedor } from "../src/llm/fabrica"

const SISTEMA = "Eres un asistente de prueba. Cuando te pregunten la hora, usa la herramienta obtener_hora y responde en una frase."
const PREGUNTA = "¿Qué hora es en el sistema? Usa la herramienta."
const HORA_SIMULADA = "2026-09-03T10:00:00"

const HERRAMIENTA_HORA: DefinicionHerramienta = {
  nombre: "obtener_hora",
  descripcion: "Devuelve la fecha y hora actual del sistema.",
  parametros: { type: "object", properties: {} },
}

/** Precio por millón de tokens desde una variable opcional; null si no está o no es un número. */
function leerPrecio(nombre: string): number | null {
  const valor = Number(process.env[nombre])
  return process.env[nombre] && Number.isFinite(valor) ? valor : null
}

/** Imprime los tokens de una llamada y, si hay precios configurados, su costo estimado en USD. */
function imprimirUso(etiqueta: string, respuesta: RespuestaModelo): void {
  const { tokensEntrada, tokensSalida } = respuesta.uso
  const [entrada, salida] = [leerPrecio("PRECIO_ENTRADA_MTOK"), leerPrecio("PRECIO_SALIDA_MTOK")]
  const costo = entrada !== null && salida !== null ? ` · costo estimado USD ${((tokensEntrada * entrada + tokensSalida * salida) / 1_000_000).toFixed(6)}` : ""
  console.log(`${etiqueta}: ${tokensEntrada} tokens de entrada, ${tokensSalida} de salida${costo}`)
}

/** Flujo de dos llamadas: el modelo pide obtener_hora, recibe el resultado y responde. */
async function probar(): Promise<void> {
  const proveedor = crearProveedor()
  console.log(`Proveedor: ${proveedor.nombre} · Modelo: ${proveedor.modelo}`)
  const mensajes: MensajeConversacion[] = [{ rol: "usuario", texto: PREGUNTA }]
  const primera = await proveedor.enviar(SISTEMA, mensajes, [HERRAMIENTA_HORA])
  imprimirUso("Llamada 1", primera)
  const llamada = primera.llamadas[0]
  if (!llamada) return console.log(`El modelo no pidió la herramienta. Respondió: ${primera.texto}`)
  console.log(`El modelo pidió: ${llamada.nombre}(${JSON.stringify(llamada.argumentos)})`)
  mensajes.push({ rol: "asistente", texto: primera.texto, llamadas: primera.llamadas, datosProveedor: primera.datosProveedor })
  mensajes.push({ rol: "resultado_herramienta", idLlamada: llamada.id, nombre: llamada.nombre, contenido: JSON.stringify({ ok: true, data: { hora: HORA_SIMULADA } }) })
  const segunda = await proveedor.enviar(SISTEMA, mensajes, [HERRAMIENTA_HORA])
  imprimirUso("Llamada 2", segunda)
  console.log(`Respuesta final: ${segunda.texto}`)
}

try {
  await probar()
} catch (error) {
  console.error(error instanceof ErrorProveedor ? `Error (${error.tipo}): ${error.message}` : "Error inesperado al probar el proveedor")
  process.exitCode = 1
}
