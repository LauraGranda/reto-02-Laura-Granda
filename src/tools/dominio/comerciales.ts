// Resolución del comercial remitente contra fixtures/reto-02/comerciales.json (HU-3).
import { leerComerciales } from "./maestro"
import type { ContextoHerramienta, ResultadoValidacion } from "./tipos"

/**
 * Busca el remitente en comerciales.json sin distinguir mayúsculas (HU-3). Un remitente desconocido
 * se reporta con nombre null y registrado false, pero no bloquea el registro (msg-006).
 */
export async function resolverComercial(ctx: ContextoHerramienta, email: string): Promise<ResultadoValidacion["comercial"]> {
  const buscado = email.trim().toLowerCase()
  const comercial = (await leerComerciales(ctx)).find((candidato) => candidato.email.trim().toLowerCase() === buscado)
  return { email, nombre: comercial?.nombre ?? null, registrado: comercial !== undefined }
}
