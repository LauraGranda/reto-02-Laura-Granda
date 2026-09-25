// Extracción determinista (regex/heurísticas) de campos del contrato con confianza por campo (HU-2).
import { esFechaValida, sumarMeses } from "./fechas"
import { CONFIANZA, LARGO_MAXIMO_OBJETO, MONEDA_POR_PAIS, NIT_PERIFERIA, UMBRAL_CONFIANZA } from "./reglas"
import {
  esquemaContratoExtraido,
  MONEDAS,
  type CampoExtraido,
  type ContratoExtraido,
  type Moneda,
  type Pais,
  type ResultadoHerramienta,
} from "./tipos"

// ── Tipos internos ─────────────────────────────────────────────────────────

/** Rango [inicio, fin) de índices; vale igual para el texto original y el normalizado (mismo largo). */
type Segmento = { inicio: number; fin: number }

/** Cláusula completa (del encabezado al siguiente) y su cuerpo sin "ORDINAL. TÍTULO.". */
type Clausula = { titulo: string; segmento: Segmento; cuerpo: Segmento }

/** Contrato dividido en zonas para buscar cada dato solo donde corresponde. */
type DocumentoAnalizado = {
  original: string
  normalizado: string
  esOtrosi: boolean
  encabezado: Segmento
  preambulo: Segmento
  contratante: Segmento
  clausulas: Clausula[]
  cierre: Segmento
}

/** Coincidencia de una regex: grupos del texto normalizado, los mismos grupos del original y evidencia. */
type Hallazgo = { grupos: string[]; originales: string[]; evidencia: string }

type TipoIdentificador = "NIT" | "RUC" | "RTN"
/** Identificador del contratante; formatoPanama indica un RUC escrito como \d+-\d+-\d+. */
type Identificador = { campo: CampoExtraido<string>; tipo: TipoIdentificador | null; formatoPanama: boolean }

// ── Constantes ─────────────────────────────────────────────────────────────

const LARGO_EVIDENCIA = 120

/** Ordinales que abren una cláusula al inicio de línea ("PRIMERA. OBJETO. …"), ya sin tildes. */
const ORDINALES = "PRIMERA|SEGUNDA|TERCERA|CUARTA|QUINTA|SEXTA|SEPTIMA|OCTAVA|NOVENA|DECIMA"
const PATRON_ENCABEZADO_CLAUSULA = new RegExp(String.raw`^(?:${ORDINALES})\.\s+`)
const PATRON_INICIO_CLAUSULA = new RegExp(String.raw`^(?:${ORDINALES})\.\s+`, "gm")

/**
 * Inicio del cierre del documento, que termina la última cláusula: frase de firma ("Para constancia se firma…",
 * "Se firma en…", "En señal de…") o una línea a dos columnas separadas por 3+ espacios (bloque de firmas).
 */
const PATRON_CIERRE = /^[ \t]*(?:PARA CONSTANCIA|EN CONSTANCIA|EN SENAL|SE FIRMA)\b|^[ \t]*\S[^\n]*?\S[ \t]{3,}\S/m

/**
 * Fecha escrita "<palabras> (<día>) de <mes> de <año>". Grupos: día, mes, año.
 * Acepta también la forma de firma "(30) días del mes de julio de 2026".
 */
const FECHA = String.raw`\((\d{1,2})\)\s+(?:DIAS\s+DEL\s+MES\s+)?DE\s+([A-Z]+)\s+DE\s+(\d{4})`

const MESES: Record<string, number> = {
  ENERO: 1, FEBRERO: 2, MARZO: 3, ABRIL: 4, MAYO: 5, JUNIO: 6, JULIO: 7, AGOSTO: 8,
  SEPTIEMBRE: 9, SETIEMBRE: 9, OCTUBRE: 10, NOVIEMBRE: 11, DICIEMBRE: 12,
}

/** Nombre de país en el domicilio del contratante → código del maestro (7.2). */
const PAIS_POR_NOMBRE: Record<string, Pais> = {
  ECUADOR: "EC", PERU: "PE", PANAMA: "PA", HONDURAS: "HN", COLOMBIA: "CO",
}

/** Tipos de póliza conocidos → vocabulario snake_case del maestro (regla D). */
const TIPOS_POLIZA_CONOCIDOS: ReadonlyArray<[RegExp, string]> = [
  [/^CUMPLIMIENTO\b/, "cumplimiento"],
  [/^RESPONSABILIDAD CIVIL\b/, "responsabilidad_civil"],
  [/^CALIDAD\b/, "calidad"],
  [/^SALARIOS\b/, "salarios_prestaciones"],
]

const CONECTORES_MINUSCULA = new Set(["de", "del", "los", "las", "y"])

// ── Preparación del texto ──────────────────────────────────────────────────

/**
 * Versión para buscar: sin tildes y en mayúsculas, carácter por carácter, con el MISMO largo del original.
 * Así el índice de una coincidencia sirve para recortar la evidencia del texto original.
 */
function normalizarParaBuscar(texto: string): string {
  return Array.from(texto, (caracter) => {
    const simple = caracter.normalize("NFD").replace(/\p{M}/gu, "").toUpperCase()
    return simple.length === caracter.length ? simple : caracter
  }).join("")
}

/** Retrocede `fin` sobre espacios y saltos finales para que el segmento no termine en blanco. */
function recortarEspaciosFinales(texto: string, inicio: number, fin: number): Segmento {
  let final = fin
  while (final > inicio && /\s/.test(texto.charAt(final - 1))) final--
  return { inicio, fin: final }
}

/** Primera línea no vacía del documento (título con el número del contrato). */
function ubicarEncabezado(normalizado: string): Segmento {
  const linea = /\S[^\n]*/.exec(normalizado)
  if (!linea) return { inicio: 0, fin: 0 }
  return recortarEspaciosFinales(normalizado, linea.index, linea.index + linea[0].length)
}

/** Posición donde empieza el cierre (firma o bloque de firmas), buscando desde la línea siguiente a `desde`. */
function ubicarCierre(normalizado: string, desde: number): number {
  const finLinea = normalizado.indexOf("\n", desde)
  if (finLinea === -1) return normalizado.length
  const cierre = PATRON_CIERRE.exec(normalizado.slice(finLinea + 1))
  return cierre ? finLinea + 1 + cierre.index : normalizado.length
}

/**
 * Título y cuerpo de una cláusula: "PRIMERA. OBJETO. …" → título "OBJETO". En un otrosí
 * ("Modificar la cláusula TERCERA (PLAZO)…") el título es el del paréntesis. Sin título en mayúsculas → "".
 */
function armarClausula(original: string, normalizado: string, segmento: Segmento): Clausula {
  const texto = normalizado.slice(segmento.inicio, segmento.fin)
  const inicioTexto = segmento.inicio + (PATRON_ENCABEZADO_CLAUSULA.exec(texto)?.[0].length ?? 0)
  // "MODIFICAR LA CLAUSULA TERCERA (PLAZO)" → PLAZO; el cuerpo es todo el texto tras el ordinal
  const modificada = /^MODIFICAR LA CLAUSULA \S+ \(([^)]+)\)/.exec(normalizado.slice(inicioTexto, segmento.fin))
  if (modificada) return { titulo: modificada[1]?.trim() ?? "", segmento, cuerpo: { inicio: inicioTexto, fin: segmento.fin } }
  // Título en mayúsculas del ORIGINAL hasta el primer punto ("GARANTÍAS.", "VALOR Y FORMA DE PAGO."); "Las demás…" no califica
  const titulo = /^([\p{Lu} ]+)\.\s*/u.exec(original.slice(inicioTexto, segmento.fin))
  if (!titulo) return { titulo: "", segmento, cuerpo: { inicio: inicioTexto, fin: segmento.fin } }
  const nombre = normalizarParaBuscar(titulo[1] ?? "").trim()
  return { titulo: nombre, segmento, cuerpo: { inicio: inicioTexto + titulo[0].length, fin: segmento.fin } }
}

/**
 * Tramo del preámbulo que describe al contratante: termina en "EL CONTRATANTE" y, si Periferia
 * (EL CONTRATISTA) se nombra antes, empieza después de esa mención para no tomar sus datos.
 */
function ubicarContratante(normalizado: string, preambulo: Segmento): Segmento {
  const marca = normalizado.indexOf("EL CONTRATANTE", preambulo.inicio)
  const fin = marca !== -1 && marca < preambulo.fin ? marca : preambulo.fin
  const contratista = normalizado.lastIndexOf("EL CONTRATISTA", fin)
  const inicio = contratista >= preambulo.inicio ? contratista + "EL CONTRATISTA".length : preambulo.inicio
  return { inicio, fin }
}

/**
 * Divide el documento: encabezado, preámbulo, cláusulas y cierre. Cada cláusula va de su encabezado
 * "<ORDINAL>. " al siguiente (aunque tenga varios párrafos); la última termina donde empieza el cierre.
 */
function analizarDocumento(original: string): DocumentoAnalizado {
  const normalizado = normalizarParaBuscar(original)
  const encabezado = ubicarEncabezado(normalizado)
  const inicios = Array.from(normalizado.matchAll(PATRON_INICIO_CLAUSULA), (m) => m.index ?? 0)
    .filter((inicio) => inicio >= encabezado.fin)
  const ultimoInicio = inicios.at(-1)
  const finClausulas = ultimoInicio === undefined ? normalizado.length : ubicarCierre(normalizado, ultimoInicio)
  const clausulas = inicios.map((inicio, indice) =>
    armarClausula(original, normalizado, recortarEspaciosFinales(normalizado, inicio, inicios[indice + 1] ?? finClausulas)),
  )
  const preambulo = { inicio: encabezado.fin, fin: inicios[0] ?? normalizado.length }
  return {
    original,
    normalizado,
    esOtrosi: normalizado.slice(encabezado.inicio, encabezado.fin).startsWith("OTROSI"),
    encabezado,
    preambulo,
    contratante: ubicarContratante(normalizado, preambulo),
    clausulas,
    cierre: { inicio: finClausulas, fin: normalizado.length },
  }
}

/** Primera cláusula cuyo título empieza por `prefijo` ("VALOR" encuentra "VALOR Y FORMA DE PAGO"). */
function buscarClausula(doc: DocumentoAnalizado, prefijo: string): Clausula | null {
  return doc.clausulas.find((clausula) => clausula.titulo.startsWith(prefijo)) ?? null
}

// ── Búsqueda y armado de campos ────────────────────────────────────────────

/** Recorta evidencia del texto ORIGINAL, con espacios colapsados y ≤ 120 caracteres. */
function recortarEvidencia(doc: DocumentoAnalizado, inicio: number, fin: number): string {
  return doc.original.slice(inicio, fin).replace(/\s+/g, " ").trim().slice(0, LARGO_EVIDENCIA)
}

/** Todas las coincidencias de `patron` dentro de un segmento, con grupos normalizados y originales. */
function buscarTodos(doc: DocumentoAnalizado, segmento: Segmento, patron: RegExp): Hallazgo[] {
  // "d" da los índices de cada grupo para recortar el mismo tramo del original
  const regex = new RegExp(patron.source, `dg${patron.flags.includes("m") ? "m" : ""}`)
  const parte = doc.normalizado.slice(segmento.inicio, segmento.fin)
  return Array.from(parte.matchAll(regex), (m) => {
    const base = segmento.inicio + (m.index ?? 0)
    const indices = m.indices ?? []
    return {
      grupos: m.slice(1).map((grupo) => grupo ?? ""),
      originales: indices.slice(1).map((par) =>
        par ? doc.original.slice(segmento.inicio + par[0], segmento.inicio + par[1]) : "",
      ),
      evidencia: recortarEvidencia(doc, base, base + m[0].length),
    }
  })
}

/** Primera coincidencia de `patron` en el segmento, o null. */
function buscarPrimero(doc: DocumentoAnalizado, segmento: Segmento, patron: RegExp): Hallazgo | null {
  return buscarTodos(doc, segmento, patron)[0] ?? null
}

/** Arma un CampoExtraido (el tipo del valor es el mismo que define el esquema, sin undefined). */
function campo<T>(valor: CampoExtraido<T>["valor"], confianza: number, evidencia: string | null): CampoExtraido<T> {
  return { valor, confianza, evidencia }
}

/** Campo ausente en el texto: null con confianza 0, nunca inventado (HU-2). */
function ausente<T>(evidencia: string | null = null): CampoExtraido<T> {
  return campo<T>(null, CONFIANZA.AUSENTE, evidencia)
}

/** Convierte "(<día>) de <mes> de <año>" en YYYY-MM-DD, o null si el mes no existe o la fecha es imposible (regla B). */
function convertirFechaTexto(dia: string, mes: string, anio: string): string | null {
  const numeroMes = MESES[mes]
  if (!numeroMes) return null
  const fecha = `${anio}-${String(numeroMes).padStart(2, "0")}-${dia.padStart(2, "0")}`
  return esFechaValida(fecha) ? fecha : null
}

/** Campo de fecha desde tres grupos (día, mes, año); una fecha imposible queda null/0 con su evidencia (HU-6). */
function campoFecha(grupos: string[], confianza: number, evidencia: string): CampoExtraido<string> {
  const [dia = "", mes = "", anio = ""] = grupos
  const fecha = convertirFechaTexto(dia, mes, anio)
  return fecha ? campo(fecha, confianza, evidencia) : ausente(evidencia)
}

// ── Campos ─────────────────────────────────────────────────────────────────

/** Número del contrato en el encabezado ("No. CT-2026-015", "No. CM-2026-03"). Sin número → null/0 (supuesto C). */
function extraerIdContrato(doc: DocumentoAnalizado): CampoExtraido<string> {
  // "No." + prefijo de 2–3 letras + año + secuencia; en el otrosí "No. 1" no calza y se toma el del contrato
  const hallazgo = buscarPrimero(doc, doc.encabezado, /\bNO\.\s*([A-Z]{2,3}-\d{4}-\d{1,4})\b/)
  if (!hallazgo) return ausente()
  return campo(hallazgo.grupos[0] ?? null, CONFIANZA.EXPLICITO, recortarEvidencia(doc, doc.encabezado.inicio, doc.encabezado.fin))
}

/**
 * Identificador tributario de la parte que va ANTES de "EL CONTRATANTE", sin puntos ni lo que sigue al primer guion
 * (dígito de verificación, o sufijos del RUC panameño). Nunca devuelve el NIT de Periferia (resultados esperados msg-001).
 */
function extraerNitCliente(doc: DocumentoAnalizado): Identificador {
  // (NIT|RUC|RTN) + número con puntos opcionales + tramos "-<dígitos>" opcionales:
  // "890.900.111-4" → sufijo "-4" (dígito de verificación); "155612345-2-2019" → sufijo "-2-2019" (RUC de Panamá)
  const patron = /\b(NIT|RUC|RTN)\s*(?:NO\.\s*)?(\d[\d.]*\d)((?:-\d+)*)/
  const hallazgo = buscarTodos(doc, doc.contratante, patron).at(-1)
  if (!hallazgo) return { campo: ausente(), tipo: null, formatoPanama: false }
  const numero = (hallazgo.grupos[1] ?? "").replace(/\./g, "")
  if (numero === NIT_PERIFERIA) return { campo: ausente(hallazgo.evidencia), tipo: null, formatoPanama: false }
  const tipo = hallazgo.grupos[0] as TipoIdentificador
  // Formato completo \d+-\d+-\d+ = número + dos sufijos
  const formatoPanama = tipo === "RUC" && /^-\d+-\d+$/.test(hallazgo.grupos[2] ?? "")
  return { campo: campo(numero, CONFIANZA.EXPLICITO, hallazgo.evidencia), tipo, formatoPanama }
}

/** Razón social en formato título: conectores en minúscula y sufijos con punto (S.A.S.) en mayúscula. */
function formatearTitulo(nombre: string): string {
  return nombre
    .trim()
    .split(/\s+/)
    .map((palabra, indice) => {
      const minuscula = palabra.toLowerCase()
      if (indice > 0 && CONECTORES_MINUSCULA.has(minuscula)) return minuscula
      if (palabra.includes(".")) return palabra.toUpperCase()
      return minuscula.charAt(0).toUpperCase() + minuscula.slice(1)
    })
    .join(" ")
}

/**
 * Cliente desde el bloque de firmas (conserva las mayúsculas reales); si no hay firmas,
 * razón social del preámbulo en formato título con confianza INFERIDO_PROXY (supuesto de docs/supuestos.md).
 */
function extraerCliente(doc: DocumentoAnalizado): CampoExtraido<string> {
  // Línea de firmas: "<cliente>   Periferia IT Group S.A.S." (2+ espacios entre columnas)
  const firma = buscarPrimero(doc, doc.cierre, /^[ \t]*(\S.*?)[ \t]{2,}PERIFERIA IT GROUP S\.A\.S\.[ \t]*$/m)
  const nombreFirma = firma?.originales[0]?.trim()
  if (nombreFirma) return campo(nombreFirma, CONFIANZA.EXPLICITO, nombreFirma.slice(0, LARGO_EVIDENCIA))
  // Razón social al inicio del tramo del contratante: "Entre (los suscritos,) <RAZÓN SOCIAL>,"
  // o, si Periferia va primero, ", y <RAZÓN SOCIAL>," justo después de "EL CONTRATISTA"
  const encabezado = buscarPrimero(doc, doc.contratante, /(?:\bENTRE\s+(?:LOS SUSCRITOS,\s*)?|^[^A-Z0-9]*Y\s+)([^,]+),/)
  if (!encabezado?.originales[0]) return ausente()
  return campo(formatearTitulo(encabezado.originales[0]), CONFIANZA.INFERIDO_PROXY, encabezado.evidencia)
}

/**
 * País por tipo y formato del identificador (regla E): RUC \d+-\d+-\d+ → PA, RUC 13 con 001 → EC,
 * RUC 11 → PE, RTN 14 → HN, NIT → CO.
 */
function inferirPaisPorIdentificador({ tipo, campo: { valor: numero }, formatoPanama }: Identificador): Pais | null {
  if (!tipo || !numero) return null
  if (tipo === "RUC" && formatoPanama) return "PA"
  if (tipo === "RUC" && numero.length === 13 && numero.endsWith("001")) return "EC"
  if (tipo === "RUC" && numero.length === 11) return "PE"
  if (tipo === "RTN" && numero.length === 14) return "HN"
  return tipo === "NIT" ? "CO" : null
}

/** País del contratante: explícito si su domicilio lo nombra; si no, inferido por el identificador (7.2, regla E). */
function extraerPais(doc: DocumentoAnalizado, identificador: Identificador): CampoExtraido<Pais> {
  // Nombre de país dentro del tramo del contratante (antes de "EL CONTRATANTE")
  const explicito = buscarPrimero(doc, doc.contratante, /\b(ECUADOR|PERU|PANAMA|HONDURAS|COLOMBIA)\b/)
  const paisTexto = explicito ? PAIS_POR_NOMBRE[explicito.grupos[0] ?? ""] : undefined
  if (explicito && paisTexto) return campo(paisTexto, CONFIANZA.EXPLICITO, explicito.evidencia)
  const inferido = inferirPaisPorIdentificador(identificador)
  if (!inferido) return ausente()
  // La evidencia es el identificador tal como aparece en el texto ("NIT 890.900.111-4")
  return campo(inferido, CONFIANZA.INFERIDO_PROXY, identificador.campo.evidencia)
}

/** Objeto del contrato desde el cuerpo de la cláusula OBJETO, cortado en ≤ 200 caracteres por palabra completa (7.2). Otrosí → null. */
function extraerObjeto(doc: DocumentoAnalizado): CampoExtraido<string> {
  const clausula = buscarClausula(doc, "OBJETO")
  if (doc.esOtrosi || !clausula) return ausente()
  const { inicio, fin } = clausula.cuerpo
  const texto = doc.original.slice(inicio, fin).replace(/\s+/g, " ").trim()
  if (!texto) return ausente()
  const recortado = texto.length <= LARGO_MAXIMO_OBJETO
    ? texto
    : texto.slice(0, texto.lastIndexOf(" ", LARGO_MAXIMO_OBJETO)).trim()
  return campo(recortado, CONFIANZA.EXPLICITO, recortarEvidencia(doc, inicio, fin))
}

/** Monto sin separadores: si el último separador va seguido de exactamente 2 dígitos es decimal; los demás son de miles. */
function convertirMonto(texto: string): number | null {
  const decimal = /[.,](\d{2})$/.exec(texto)
  const entero = (decimal ? texto.slice(0, decimal.index) : texto).replace(/[.,]/g, "")
  const monto = Number(decimal ? `${entero}.${decimal[1]}` : entero)
  return Number.isFinite(monto) ? monto : null
}

/** Indica si un código de 3 letras es una moneda aceptada en el maestro (7.2). */
function esMoneda(codigo: string): codigo is Moneda {
  return (MONEDAS as readonly string[]).includes(codigo)
}

type ValorYMoneda = { valor: CampoExtraido<number>; moneda: CampoExtraido<Moneda>; valor_indeterminado: boolean }

/**
 * Moneda mencionada en otra cláusula cuando VALOR no la trae (msg-006: "cien millones de pesos (COP $100.000.000)"
 * en GARANTÍAS). Es un dato real del contrato → INFERIDO_PROXY. Si hay dos monedas distintas no se elige ninguna.
 */
function buscarMonedaEnClausulas(doc: DocumentoAnalizado): CampoExtraido<Moneda> | null {
  // Hasta 3 palabras previas (solo para la evidencia) + código de moneda aceptado + monto opcional
  const patron = new RegExp(String.raw`(?:\b[A-Z]+\s+){0,3}\(?\b(${MONEDAS.join("|")})\b(?:\s*\$?\s*\d[\d.,]*)?\)?`)
  const hallazgos = doc.clausulas.flatMap(({ segmento }) => buscarTodos(doc, segmento, patron))
  const codigos = new Set(hallazgos.map((hallazgo) => hallazgo.grupos[0]))
  const primero = hallazgos[0]
  if (!primero || codigos.size !== 1 || !esMoneda(primero.grupos[0] ?? "")) return null
  return campo(primero.grupos[0] as Moneda, CONFIANZA.INFERIDO_PROXY, primero.evidencia)
}

/** Último recurso: moneda de curso legal del país, con confianza DERIVADO (0.6) para que pase a revisión (RN5). */
function asumirMonedaPorPais(pais: Pais | null): CampoExtraido<Moneda> {
  if (!pais) return ausente()
  return campo(MONEDA_POR_PAIS[pais], CONFIANZA.DERIVADO, null)
}

/**
 * Valor y moneda desde la cláusula VALOR (en otrosí, la que modifica "(VALOR)"). Contrato por demanda →
 * valor 0 AMBIGUO y moneda por país (7.2, msg-006). Moneda desconocida → null/0 (HU-6).
 */
function extraerValorYMoneda(doc: DocumentoAnalizado, pais: Pais | null): ValorYMoneda {
  const clausula = buscarClausula(doc, "VALOR")
  if (!clausula) return { valor: ausente(), moneda: ausente(), valor_indeterminado: false }
  const indeterminado = buscarPrimero(doc, clausula.segmento, /NO TIENE UN VALOR DETERMINADO/)
  if (indeterminado) {
    const moneda = buscarMonedaEnClausulas(doc) ?? asumirMonedaPorPais(pais)
    return { valor: campo(0, CONFIANZA.AMBIGUO, indeterminado.evidencia), moneda, valor_indeterminado: true }
  }
  // Paréntesis con código de moneda y monto: "(COP $265.000.000)", "(USD 120,000.00)"
  const hallazgo = buscarPrimero(doc, clausula.segmento, /\(\s*([A-Z]{3})\s*\$?\s*(\d[\d.,]*)\s*\)/)
  if (!hallazgo) return { valor: ausente(), moneda: ausente(), valor_indeterminado: false }
  const monto = convertirMonto(hallazgo.grupos[1] ?? "")
  const codigo = hallazgo.grupos[0] ?? ""
  return {
    valor: monto === null ? ausente(hallazgo.evidencia) : campo(monto, CONFIANZA.EXPLICITO, hallazgo.evidencia),
    moneda: esMoneda(codigo) ? campo(codigo, CONFIANZA.EXPLICITO, hallazgo.evidencia) : ausente(hallazgo.evidencia),
    valor_indeterminado: false,
  }
}

type Fechas = { fecha_inicio: CampoExtraido<string>; fecha_fin: CampoExtraido<string> }

/** Otrosí: "se extiende hasta el <fecha>" → fecha_fin EXPLICITO; fecha_inicio no se toca (msg-003). */
function extraerFechasOtrosi(doc: DocumentoAnalizado, plazo: Segmento): Fechas {
  const hallazgo = buscarPrimero(doc, plazo, new RegExp(String.raw`SE EXTIENDE HASTA[^(]*${FECHA}`))
  const fin = hallazgo ? campoFecha(hallazgo.grupos, CONFIANZA.EXPLICITO, hallazgo.evidencia) : ausente<string>()
  return { fecha_inicio: ausente(), fecha_fin: fin }
}

/**
 * Plazo en meses desde la firma (msg-006): con día de firma, inicio EXPLICITO; sin día, inicio = fecha del correo
 * (INFERIDO_PROXY, supuesto documentado). fecha_fin = inicio + N meses (DERIVADO), con el plazo como evidencia.
 */
function extraerFechasPorMeses(doc: DocumentoAnalizado, plazo: Hallazgo, fechaCorreo: string): Fechas {
  const conDia = buscarPrimero(doc, doc.cierre, new RegExp(String.raw`SE FIRMA[^\n]*?${FECHA}`))
  const sinDia = buscarPrimero(doc, doc.cierre, /SE FIRMA[^\n]*?(EN EL MES DE ([A-Z]+) DE (\d{4}))/)
  let inicio: CampoExtraido<string> = ausente()
  if (conDia) inicio = campoFecha(conDia.grupos, CONFIANZA.EXPLICITO, conDia.evidencia)
  else if (sinDia && esFechaValida(fechaCorreo)) {
    const evidencia = `firma sin día ('${sinDia.originales[0]}'); se usa la fecha de recepción del correo ${fechaCorreo}`
    inicio = campo(fechaCorreo, CONFIANZA.INFERIDO_PROXY, evidencia.slice(0, LARGO_EVIDENCIA))
  }
  if (inicio.valor === null) return { fecha_inicio: inicio, fecha_fin: ausente() }
  const fin = sumarMeses(inicio.valor, Number(plazo.grupos[0]))
  return { fecha_inicio: inicio, fecha_fin: campo(fin, CONFIANZA.DERIVADO, plazo.evidencia) }
}

/** fecha_inicio y fecha_fin desde la cláusula PLAZO (7.2): "desde … hasta …", plazo en meses u otrosí. */
function extraerFechas(doc: DocumentoAnalizado, correo: { fecha: string }): Fechas {
  const plazo = buscarClausula(doc, "PLAZO")?.segmento
  if (!plazo) return { fecha_inicio: ausente(), fecha_fin: ausente() }
  if (doc.esOtrosi) return extraerFechasOtrosi(doc, plazo)
  // "desde <fecha> hasta <fecha>": grupos 1–3 inicio, 4–6 fin
  const desdeHasta = buscarPrimero(doc, plazo, new RegExp(String.raw`DESDE[^(]*${FECHA}[^(]*?HASTA[^(]*${FECHA}`))
  if (desdeHasta) {
    return {
      fecha_inicio: campoFecha(desdeHasta.grupos.slice(0, 3), CONFIANZA.EXPLICITO, desdeHasta.evidencia),
      fecha_fin: campoFecha(desdeHasta.grupos.slice(3, 6), CONFIANZA.EXPLICITO, desdeHasta.evidencia),
    }
  }
  // "doce (12) meses contados a partir de la fecha de su firma" (la palabra previa entra solo en la evidencia)
  const porMeses = buscarPrimero(doc, plazo, /(?:\b[A-Z]+\s+)?\((\d{1,3})\)\s+MESES CONTADOS A PARTIR DE LA FECHA DE SU FIRMA/)
  if (!porMeses) return { fecha_inicio: ausente(), fecha_fin: ausente() }
  return extraerFechasPorMeses(doc, porMeses, correo.fecha.slice(0, 10))
}

/** Nombre de un tipo de póliza en el vocabulario del maestro; uno desconocido pasa a snake_case sin tildes (regla D). */
function nombrarTipoPoliza(parte: string): string {
  const conocido = TIPOS_POLIZA_CONOCIDOS.find(([patron]) => patron.test(parte))
  if (conocido) return conocido[1]
  return parte.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
}

/** "CALIDAD Y DE SALARIOS Y PRESTACIONES SOCIALES" → "calidad;salarios_prestaciones" (sin duplicados, sin espacios). */
function convertirTiposPoliza(frase: string): string {
  const partes = frase
    .replace(/SALARIOS Y PRESTACIONES SOCIALES/g, "SALARIOS_PRESTACIONES") // su "Y" no separa tipos
    .split(/\s*,\s*|\s+Y\s+(?:DE\s+)?/)
    .map((parte) => parte.replace(/^DE\s+/, "").trim())
    .filter((parte) => parte !== "")
  return [...new Set(partes.map(nombrarTipoPoliza))].join(";")
}

type Poliza = { requiere_poliza: CampoExtraido<boolean>; tipo_poliza: CampoExtraido<string> }

/**
 * requiere_poliza y tipo_poliza desde la cláusula GARANTÍAS (7.2). Sin cláusula → false EXPLICITO.
 * Póliza condicional (msg-006) → true con INFERIDO_PROXY. En otrosí quedan null (no los modifica).
 */
function extraerPoliza(doc: DocumentoAnalizado): Poliza {
  if (doc.esOtrosi) return { requiere_poliza: ausente(), tipo_poliza: ausente() }
  const clausula = buscarClausula(doc, "GARANTIA")
  // Sin cláusula de garantías no hay texto que citar: evidencia null
  if (!clausula) return { requiere_poliza: campo(false, CONFIANZA.EXPLICITO, null), tipo_poliza: campo("", CONFIANZA.EXPLICITO, null) }
  const { segmento } = clausula
  const evidenciaClausula = recortarEvidencia(doc, segmento.inicio, segmento.fin)
  // "póliza(s) de <tipos>" hasta " por …", coma, punto o punto y coma
  const hallazgo = buscarPrimero(doc, segmento, /POLIZAS? DE ([^.,;]+?)(?:\s+POR\b|[.,;]|$)/)
  // Hay cláusula de garantías pero no menciona póliza (ej. garantía bancaria): no se inventa, queda null/0 (HU-2)
  if (!hallazgo) return { requiere_poliza: ausente(evidenciaClausula), tipo_poliza: ausente(evidenciaClausula) }
  // Condición que hace la póliza no siempre exigible ("para cada orden cuyo valor supere …")
  const condicional = buscarPrimero(doc, segmento, /CUYO VALOR SUPERE|EN CASO DE|SIEMPRE QUE/) !== null
  const confianza = condicional ? CONFIANZA.INFERIDO_PROXY : CONFIANZA.EXPLICITO
  const evidencia = condicional ? evidenciaClausula : hallazgo.evidencia
  return {
    requiere_poliza: campo(true, confianza, evidencia),
    tipo_poliza: campo(convertirTiposPoliza(hallazgo.grupos[0] ?? ""), confianza, evidencia),
  }
}

/** Otrosí que exige ampliar garantías ("deberán ampliarse"); lo usa validar para dejar la póliza en pendiente (msg-003). */
function detectarAmpliacionGarantias(doc: DocumentoAnalizado): boolean {
  if (!doc.esOtrosi) return false
  return doc.clausulas.some(({ segmento }) => {
    const texto = doc.normalizado.slice(segmento.inicio, segmento.fin)
    return texto.includes("GARANTIA") && texto.includes("DEBERAN AMPLIARSE")
  })
}

// ── Función principal ──────────────────────────────────────────────────────

/**
 * Por qué un texto no es un contrato (RN4, regla A), como fragmento para "El adjunto <…>": "está vacío",
 * "no es un contrato (parece una cotización)"… o null si su primera línea empieza por CONTRATO u OTROSÍ.
 * Única fuente de esta regla: la usan la extracción y la lectura del buzón (HU-1).
 */
export function motivoNoEsContrato(texto: string): string | null {
  const normalizado = normalizarParaBuscar(texto.normalize("NFC"))
  if (normalizado.trim() === "") return "está vacío"
  const { inicio, fin } = ubicarEncabezado(normalizado)
  const primeraLinea = normalizado.slice(inicio, fin)
  if (/^(CONTRATO|OTROSI)\b/.test(primeraLinea)) return null
  if (primeraLinea.startsWith("COTIZACION")) return "no es un contrato (parece una cotización)"
  return "no es un contrato ni un otrosí"
}

/** Junta todos los campos en un ContratoExtraido. */
function construirContrato(doc: DocumentoAnalizado, correo: { fecha: string }): ContratoExtraido {
  const identificador = extraerNitCliente(doc)
  const pais = extraerPais(doc, identificador)
  const { valor, moneda, valor_indeterminado } = extraerValorYMoneda(doc, pais.valor)
  const { fecha_inicio, fecha_fin } = extraerFechas(doc, correo)
  const { requiere_poliza, tipo_poliza } = extraerPoliza(doc)
  return {
    tipo_documento: doc.esOtrosi ? "otrosi" : "contrato",
    id_contrato: extraerIdContrato(doc),
    cliente: extraerCliente(doc),
    nit_cliente: identificador.campo,
    pais,
    objeto: extraerObjeto(doc),
    valor,
    moneda,
    fecha_inicio,
    fecha_fin,
    requiere_poliza,
    tipo_poliza,
    valor_indeterminado,
    exige_ampliar_garantias: detectarAmpliacionGarantias(doc),
  }
}

/** Nombres de los campos con confianza menor a UMBRAL_CONFIANZA, en el orden del contrato (RN5). */
export function camposBajoUmbral(contrato: ContratoExtraido): string[] {
  return Object.entries(contrato)
    .filter(([, campo]) => typeof campo === "object" && campo.confianza < UMBRAL_CONFIANZA)
    .map(([nombre]) => nombre)
}

/**
 * Extrae los datos del contrato con confianza por campo, solo con regex (HU-2). Nunca lanza:
 * adjunto vacío, no-contrato (RN4) o cualquier fallo se devuelve como { ok: false, error } legible (HU-6).
 */
export function extraerContrato(texto: string, correo: { fecha: string }): ResultadoHerramienta<ContratoExtraido> {
  try {
    const original = texto.normalize("NFC").replace(/\r\n/g, "\n")
    const rechazo = motivoNoEsContrato(original)
    if (rechazo) return { ok: false, error: `El adjunto ${rechazo}` }
    const doc = analizarDocumento(original)
    const resultado = esquemaContratoExtraido.safeParse(construirContrato(doc, correo))
    if (resultado.success) return { ok: true, data: resultado.data }
    const problema = resultado.error.issues[0]
    return { ok: false, error: `Extracción inválida en ${problema?.path.join(".")}: ${problema?.message}` }
  } catch (error) {
    return { ok: false, error: `No se pudo extraer el contrato: ${error instanceof Error ? error.message : String(error)}` }
  }
}
