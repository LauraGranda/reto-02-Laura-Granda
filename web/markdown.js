// Markdown → HTML seguro para las respuestas del agente en el chat (PRD 6.1). Módulo ES sin dependencias.

/** Entidades HTML que se escapan antes de cualquier conversión. */
const ENTIDADES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }

/**
 * Escapa &, <, >, " y ' para que ningún texto del modelo o de un documento se interprete como HTML.
 * @param {string} texto
 * @returns {string}
 */
function escaparHtml(texto) {
  return texto.replace(/[&<>"']/g, (caracter) => ENTIDADES[/** @type {keyof typeof ENTIDADES} */ (caracter)])
}

/**
 * Formato en línea sobre texto YA escapado: `código` (sin procesar su interior) y **negrita**.
 * @param {string} texto
 * @returns {string}
 */
function formatoEnLinea(texto) {
  return texto
    .split(/(`[^`]*`)/)
    .map((parte, indice) => (indice % 2 === 1 ? `<code>${parte.slice(1, -1)}</code>` : parte.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")))
    .join("")
}

/** @param {string} linea @returns {boolean} Fila de tabla: empieza y termina con "|". */
function esFilaTabla(linea) {
  return /^\s*\|.*\|\s*$/.test(linea)
}

/** @param {string} linea @returns {boolean} Separador de encabezado de tabla: |---|:---:|… */
function esSeparadorTabla(linea) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(linea)
}

/**
 * Celdas de una fila; respeta "\|" como barra dentro de la celda (el reporte de alertas la usa).
 * @param {string} linea
 * @returns {string[]}
 */
function celdas(linea) {
  return linea.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map((celda) => formatoEnLinea(celda.trim().replace(/\\\|/g, "|")))
}

/**
 * Tabla con encabezado, envuelta en un contenedor con scroll horizontal (tablas anchas en celular).
 * @param {string[]} lineas encabezado, separador y filas
 * @returns {string}
 */
function renderizarTabla(lineas) {
  const encabezado = celdas(lineas[0] ?? "").map((c) => `<th>${c}</th>`).join("")
  const filas = lineas.slice(2).map((linea) => `<tr>${celdas(linea).map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")
  return `<div class="tabla"><table><thead><tr>${encabezado}</tr></thead><tbody>${filas}</tbody></table></div>`
}

/**
 * Lista consecutiva (con "-" o numerada) desde la línea `inicio`.
 * @param {string[]} lineas
 * @param {number} inicio
 * @param {RegExp} patron marcador de ítem
 * @param {"ul" | "ol"} etiqueta
 * @returns {{ html: string, siguiente: number }}
 */
function renderizarLista(lineas, inicio, patron, etiqueta) {
  let fin = inicio
  while (fin < lineas.length && patron.test(lineas[fin] ?? "")) fin++
  const items = lineas.slice(inicio, fin).map((linea) => `<li>${formatoEnLinea(linea.replace(patron, ""))}</li>`).join("")
  return { html: `<${etiqueta}>${items}</${etiqueta}>`, siguiente: fin }
}

/**
 * Bloque especial que empieza en la línea `i` (tabla, título, línea horizontal o lista), o null si es texto normal.
 * @param {string[]} lineas
 * @param {number} i
 * @returns {{ html: string, siguiente: number } | null}
 */
function bloqueEspecial(lineas, i) {
  const linea = lineas[i] ?? ""
  if (esFilaTabla(linea) && esSeparadorTabla(lineas[i + 1] ?? "")) {
    let fin = i + 2
    while (fin < lineas.length && esFilaTabla(lineas[fin] ?? "")) fin++
    return { html: renderizarTabla(lineas.slice(i, fin)), siguiente: fin }
  }
  const titulo = /^(#{1,3})\s+(.*)$/.exec(linea)
  if (titulo) {
    const nivel = (titulo[1] ?? "#").length + 2 // # → h3: no compite con el título de la página
    return { html: `<h${nivel}>${formatoEnLinea(titulo[2] ?? "")}</h${nivel}>`, siguiente: i + 1 }
  }
  if (/^\s*(-{3,}|\*{3,})\s*$/.test(linea)) return { html: "<hr>", siguiente: i + 1 }
  if (/^\s*[-*]\s+/.test(linea)) return renderizarLista(lineas, i, /^\s*[-*]\s+/, "ul")
  if (/^\s*\d+\.\s+/.test(linea)) return renderizarLista(lineas, i, /^\s*\d+\.\s+/, "ol")
  return null
}

/**
 * Convierte el Markdown de una respuesta del agente en HTML seguro para insertar con innerHTML.
 * El ORDEN es lo que evita XSS: PRIMERO se escapa todo el HTML del texto y DESPUÉS se convierte un subconjunto
 * de Markdown (títulos, negrita, código en línea, listas, ---, párrafos y tablas). Así, cualquier etiqueta que venga
 * del modelo o de un documento queda como texto. No se admiten enlaces, imágenes ni HTML crudo.
 * @param {string} texto
 * @returns {string}
 */
export function renderizarMarkdown(texto) {
  const lineas = escaparHtml(String(texto ?? "")).replace(/\r\n/g, "\n").split("\n")
  /** @type {string[]} */
  const bloques = []
  /** @type {string[]} */
  let parrafo = []
  const cerrarParrafo = () => {
    if (parrafo.length > 0) bloques.push(`<p>${parrafo.map(formatoEnLinea).join("<br>")}</p>`)
    parrafo = []
  }
  for (let i = 0; i < lineas.length; ) {
    const linea = lineas[i] ?? ""
    const especial = linea.trim() === "" ? null : bloqueEspecial(lineas, i)
    if (linea.trim() === "" || especial) cerrarParrafo()
    if (especial) {
      bloques.push(especial.html)
      i = especial.siguiente
      continue
    }
    if (linea.trim() !== "") parrafo.push(linea)
    i++
  }
  cerrarParrafo()
  return bloques.join("\n")
}
