import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { extraerContrato } from "../src/tools/dominio/extraccion"
import type { ContratoExtraido } from "../src/tools/dominio/tipos"

const CARPETA_BUZON = path.join(import.meta.dir, "..", "fixtures", "reto-02", "buzon")

type CampoConConfianza = Exclude<keyof ContratoExtraido, "tipo_documento" | "valor_indeterminado" | "exige_ampliar_garantias">
type Esperado = {
  tipo_documento: ContratoExtraido["tipo_documento"]
  valor_indeterminado: boolean
  exige_ampliar_garantias: boolean
  campos: Record<CampoConConfianza, [string | number | boolean | null, number]>
}

/** Lee el texto de un adjunto del buzón. */
function leerAdjunto(mensajeId: string, adjunto: string): string {
  return readFileSync(path.join(CARPETA_BUZON, mensajeId, adjunto), "utf8")
}

/** Extrae un mensaje del buzón usando la fecha de su correo.json. */
function extraerMensaje(mensajeId: string, adjunto: string) {
  const correo = JSON.parse(leerAdjunto(mensajeId, "correo.json")) as { fecha: string }
  return extraerContrato(leerAdjunto(mensajeId, adjunto), correo)
}

/** Extrae un texto y exige ok: true. */
function exigirContrato(texto: string, fecha = "2026-01-10"): ContratoExtraido {
  const resultado = extraerContrato(texto, { fecha })
  if (!resultado.ok) throw new Error(resultado.error)
  return resultado.data
}

/** Verifica valor y confianza de TODOS los campos y las banderas. */
function esperarContrato(contrato: ContratoExtraido, esperado: Esperado): void {
  expect(contrato.tipo_documento).toBe(esperado.tipo_documento)
  expect(contrato.valor_indeterminado).toBe(esperado.valor_indeterminado)
  expect(contrato.exige_ampliar_garantias).toBe(esperado.exige_ampliar_garantias)
  for (const [nombre, [valor, confianza]] of Object.entries(esperado.campos)) {
    const campo = contrato[nombre as CampoConConfianza]
    expect({ campo: nombre, valor: campo.valor, confianza: campo.confianza }).toEqual({ campo: nombre, valor, confianza })
  }
}

/**
 * Toda evidencia es null o un fragmento del texto original (con espacios colapsados) de ≤ 120 caracteres.
 * `excepciones` lista los campos con evidencia explicativa pedida expresamente (regla F).
 */
function esperarEvidenciasDelOriginal(contrato: ContratoExtraido, texto: string, excepciones: string[] = []): void {
  const original = texto.replace(/\s+/g, " ")
  for (const [nombre, campo] of Object.entries(contrato)) {
    if (typeof campo !== "object" || campo.evidencia === null || excepciones.includes(nombre)) continue
    expect(campo.evidencia.length).toBeLessThanOrEqual(120)
    expect({ campo: nombre, enOriginal: original.includes(campo.evidencia) }).toEqual({ campo: nombre, enOriginal: true })
  }
}

const PREAMBULO_PRUEBA =
  "Entre los suscritos, EMPRESA PRUEBA S.A.S., identificada con NIT 811.111.111-1, con domicilio en Cali, quien en adelante se denominará EL CONTRATANTE, y PERIFERIA IT GROUP S.A.S., identificada con NIT 900.123.456-7, quien en adelante se denominará EL CONTRATISTA:"

/** Contrato sintético: encabezado, preámbulo y las cláusulas dadas (por defecto OBJETO, VALOR y PLAZO). */
function contratoSintetico(partes: { preambulo?: string; clausulas?: string[]; plazo?: string; garantias?: string }): string {
  const clausulas = partes.clausulas ?? [
    "PRIMERA. OBJETO. Servicios de prueba.",
    "SEGUNDA. VALOR. El valor es de UN MILLÓN DE PESOS (COP $1.000.000).",
    `TERCERA. PLAZO. ${partes.plazo ?? "Desde el primero (1) de enero de 2026 hasta el treinta y uno (31) de diciembre de 2026."}`,
    ...(partes.garantias ? [`CUARTA. GARANTÍAS. ${partes.garantias}`] : []),
  ]
  return ["CONTRATO DE PRESTACIÓN DE SERVICIOS No. CT-2099-001", partes.preambulo ?? PREAMBULO_PRUEBA, ...clausulas].join("\n\n")
}

describe("contratos del buzón: valor y confianza de cada campo", () => {
  test("msg-001: contrato nuevo con póliza de cumplimiento", () => {
    const texto = leerAdjunto("msg-001", "contrato.txt")
    const contrato = exigirContrato(texto, "2026-07-31")
    esperarContrato(contrato, {
      tipo_documento: "contrato",
      valor_indeterminado: false,
      exige_ampliar_garantias: false,
      campos: {
        id_contrato: ["CT-2026-015", 0.95],
        cliente: ["Industrias Delta S.A.S.", 0.95],
        nit_cliente: ["890900111", 0.95],
        pais: ["CO", 0.8],
        objeto: [
          "EL CONTRATISTA se obliga a ejecutar la implementación, parametrización y soporte de la plataforma CRM del CONTRATANTE, incluyendo migración de datos y capacitación a usuarios finales.",
          0.95,
        ],
        valor: [265000000, 0.95],
        moneda: ["COP", 0.95],
        fecha_inicio: ["2026-08-01", 0.95],
        fecha_fin: ["2027-07-31", 0.95],
        requiere_poliza: [true, 0.95],
        tipo_poliza: ["cumplimiento", 0.95],
      },
    })
    expect(contrato.pais.evidencia).toBe("NIT 890.900.111-4")
    esperarEvidenciasDelOriginal(contrato, texto)
  })

  test("msg-002: contrato nuevo en USD sin póliza", () => {
    const texto = leerAdjunto("msg-002", "contrato.txt")
    const contrato = exigirContrato(texto, "2026-08-13")
    esperarContrato(contrato, {
      tipo_documento: "contrato",
      valor_indeterminado: false,
      exige_ampliar_garantias: false,
      campos: {
        id_contrato: ["CT-2026-016", 0.95],
        cliente: ["Corporación Andina de Servicios S.A.", 0.95],
        nit_cliente: ["1790012345001", 0.95],
        pais: ["EC", 0.95],
        objeto: [
          "EL CONTRATISTA prestará servicios de fábrica de software bajo modalidad de célula dedicada, con un equipo de seis (6) profesionales, para la evolución de las aplicaciones corporativas del CONTRATANTE.",
          0.95,
        ],
        valor: [120000, 0.95],
        moneda: ["USD", 0.95],
        fecha_inicio: ["2026-08-15", 0.95],
        fecha_fin: ["2027-08-14", 0.95],
        requiere_poliza: [false, 0.95],
        tipo_poliza: ["", 0.95],
      },
    })
    expect(contrato.requiere_poliza.evidencia).toBeNull()
    esperarEvidenciasDelOriginal(contrato, texto)
  })

  test("msg-003: otrosí que extiende plazo y valor", () => {
    const texto = leerAdjunto("msg-003", "otrosi.txt")
    const contrato = exigirContrato(texto, "2026-08-21")
    esperarContrato(contrato, {
      tipo_documento: "otrosi",
      valor_indeterminado: false,
      exige_ampliar_garantias: true,
      campos: {
        id_contrato: ["CT-2026-011", 0.95],
        cliente: ["Minera Los Andes S.A.C.", 0.95],
        nit_cliente: ["20512345678", 0.95],
        pais: ["PE", 0.95],
        objeto: [null, 0],
        valor: [520000, 0.95],
        moneda: ["PEN", 0.95],
        fecha_inicio: [null, 0],
        fecha_fin: ["2027-11-01", 0.95],
        requiere_poliza: [null, 0],
        tipo_poliza: [null, 0],
      },
    })
    esperarEvidenciasDelOriginal(contrato, texto)
  })

  test("msg-004: reenvío de contrato existente", () => {
    const texto = leerAdjunto("msg-004", "contrato.txt")
    const contrato = exigirContrato(texto, "2026-08-25")
    esperarContrato(contrato, {
      tipo_documento: "contrato",
      valor_indeterminado: false,
      exige_ampliar_garantias: false,
      campos: {
        id_contrato: ["CT-2026-012", 0.95],
        cliente: ["Clínica San Rafael S.A.", 0.95],
        nit_cliente: ["890903456", 0.95],
        pais: ["CO", 0.8],
        objeto: [
          "EL CONTRATISTA prestará el servicio de mesa de servicio de tecnología en niveles 1 y 2 para los usuarios del CONTRATANTE, en horario 7x24.",
          0.95,
        ],
        valor: [210000000, 0.95],
        moneda: ["COP", 0.95],
        fecha_inicio: ["2026-05-15", 0.95],
        fecha_fin: ["2026-11-14", 0.95],
        requiere_poliza: [false, 0.95],
        tipo_poliza: ["", 0.95],
      },
    })
    esperarEvidenciasDelOriginal(contrato, texto)
  })

  test("msg-006: contrato marco por demanda con plazo en meses y póliza condicional", () => {
    const texto = leerAdjunto("msg-006", "contrato.txt")
    const resultado = extraerMensaje("msg-006", "contrato.txt")
    if (!resultado.ok) throw new Error(resultado.error)
    const contrato = resultado.data
    esperarContrato(contrato, {
      tipo_documento: "contrato",
      valor_indeterminado: true,
      exige_ampliar_garantias: false,
      campos: {
        id_contrato: ["CM-2026-03", 0.95],
        cliente: ["Distribuidora Caribe S.A.S.", 0.95],
        nit_cliente: ["800222333", 0.95],
        pais: ["CO", 0.8],
        objeto: [
          "Establecer las condiciones generales bajo las cuales EL CONTRATISTA prestará servicios de desarrollo de software, soporte y consultoría tecnológica, que se concretarán mediante órdenes de servicio",
          0.95,
        ],
        valor: [0, 0.5],
        moneda: ["COP", 0.8],
        fecha_inicio: ["2026-08-31", 0.8],
        fecha_fin: ["2027-08-31", 0.6],
        requiere_poliza: [true, 0.8],
        tipo_poliza: ["cumplimiento", 0.8],
      },
    })
    expect(contrato.valor.valor).not.toBe(100000000)
    expect(contrato.fecha_inicio.evidencia).toBe(
      "firma sin día ('en el mes de agosto de 2026'); se usa la fecha de recepción del correo 2026-08-31",
    )
    expect(contrato.fecha_fin.evidencia).toBe("doce (12) meses contados a partir de la fecha de su firma")
    expect(contrato.moneda.evidencia).toBe("millones de pesos (COP $100.000.000)")
    esperarEvidenciasDelOriginal(contrato, texto, ["fecha_inicio"])
  })
})

describe("errores", () => {
  test("adjunto vacío o solo espacios → ok:false", () => {
    expect(extraerContrato("", { fecha: "2026-09-01" })).toEqual({ ok: false, error: "El adjunto está vacío" })
    expect(extraerContrato("  \r\n\t ", { fecha: "2026-09-01" })).toEqual({ ok: false, error: "El adjunto está vacío" })
  })

  test("msg-005: cotización → ok:false (RN4)", () => {
    expect(extraerMensaje("msg-005", "cotizacion.txt")).toEqual({
      ok: false,
      error: "El adjunto no es un contrato (parece una cotización)",
    })
  })
})

describe("casos sintéticos", () => {
  test("fecha imposible queda null con confianza 0 y evidencia", () => {
    const contrato = exigirContrato(
      contratoSintetico({ plazo: "Desde el treinta y uno (31) de febrero de 2026 hasta el treinta (30) de junio de 2026." }),
    )
    expect([contrato.fecha_inicio.valor, contrato.fecha_inicio.confianza]).toEqual([null, 0])
    expect(contrato.fecha_inicio.evidencia).toContain("treinta y uno (31) de febrero de 2026")
    expect([contrato.fecha_fin.valor, contrato.fecha_fin.confianza]).toEqual(["2026-06-30", 0.95])
  })

  test("varios tipos de póliza en vocabulario del maestro", () => {
    const contrato = exigirContrato(
      contratoSintetico({ garantias: "EL CONTRATISTA constituirá póliza de calidad y de salarios y prestaciones sociales por el diez por ciento." }),
    )
    expect([contrato.tipo_poliza.valor, contrato.tipo_poliza.confianza]).toEqual(["calidad;salarios_prestaciones", 0.95])
  })

  test("garantías sin póliza identificable → requiere_poliza null/0, no se inventa", () => {
    const contrato = exigirContrato(contratoSintetico({ garantias: "EL CONTRATISTA entregará una garantía bancaria a primer requerimiento." }))
    expect([contrato.requiere_poliza.valor, contrato.requiere_poliza.confianza]).toEqual([null, 0])
    expect([contrato.tipo_poliza.valor, contrato.tipo_poliza.confianza]).toEqual([null, 0])
    expect(contrato.requiere_poliza.evidencia).toContain("garantía bancaria")
  })

  test("cláusula de varios párrafos: la póliza del segundo párrafo se encuentra", () => {
    const texto = contratoSintetico({
      garantias: "EL CONTRATISTA constituirá las siguientes garantías:\n\nUna póliza de responsabilidad civil por el diez por ciento.",
    })
    const contrato = exigirContrato(`${texto}\n\nPara constancia se firma en Cali, a los dos (2) días del mes de enero de 2026.`)
    expect([contrato.requiere_poliza.valor, contrato.tipo_poliza.valor]).toEqual([true, "responsabilidad_civil"])
  })

  test("títulos compuestos: 'VALOR Y FORMA DE PAGO', 'PLAZO DE EJECUCIÓN', 'OBJETO DEL CONTRATO'", () => {
    const contrato = exigirContrato(
      contratoSintetico({
        clausulas: [
          "PRIMERA. OBJETO DEL CONTRATO. Soporte de prueba.",
          "SEGUNDA. VALOR Y FORMA DE PAGO. El valor es (COP $5.000.000) pagaderos mes vencido.",
          "TERCERA. PLAZO DE EJECUCIÓN. Desde el primero (1) de marzo de 2026 hasta el treinta y uno (31) de marzo de 2026.",
        ],
      }),
    )
    expect(contrato.objeto.valor).toBe("Soporte de prueba.")
    expect([contrato.valor.valor, contrato.moneda.valor]).toEqual([5000000, "COP"])
    expect([contrato.fecha_inicio.valor, contrato.fecha_fin.valor]).toEqual(["2026-03-01", "2026-03-31"])
  })

  test("Periferia nombrada primero: país, NIT y cliente salen del contratante", () => {
    const contrato = exigirContrato(
      contratoSintetico({
        preambulo:
          "Entre PERIFERIA IT GROUP S.A.S., identificada con NIT 900.123.456-7, con domicilio en Medellín, Colombia, quien en adelante se denominará EL CONTRATISTA, y COMERCIAL DEL PACÍFICO S.A., identificada con RUC 0990012345001, con domicilio en Guayaquil, Ecuador, quien en adelante se denominará EL CONTRATANTE:",
      }),
    )
    expect([contrato.pais.valor, contrato.pais.confianza]).toEqual(["EC", 0.95])
    expect(contrato.nit_cliente.valor).toBe("0990012345001")
    expect([contrato.cliente.valor, contrato.cliente.confianza]).toEqual(["Comercial del Pacífico S.A.", 0.8])
  })

  test("valor indeterminado sin moneda en ninguna cláusula → moneda por país con 0.6 (va a revisión)", () => {
    const preambulo =
      "Entre AGROEXPORT PRUEBA S. DE R.L., identificada con RTN 08019995123456, con domicilio en San Pedro Sula, quien en adelante se denominará EL CONTRATANTE, y PERIFERIA IT GROUP S.A.S., NIT 900.123.456-7, EL CONTRATISTA:"
    const contrato = exigirContrato(
      contratoSintetico({
        preambulo,
        clausulas: ["PRIMERA. OBJETO. Soporte bajo demanda.", "SEGUNDA. VALOR. El presente contrato no tiene un valor determinado."],
      }),
    )
    expect([contrato.valor.valor, contrato.valor.confianza, contrato.valor_indeterminado]).toEqual([0, 0.5, true])
    expect([contrato.moneda.valor, contrato.moneda.confianza, contrato.moneda.evidencia]).toEqual(["HNL", 0.6, null])
  })

  test("valor indeterminado con dos monedas distintas en otras cláusulas → no elige ninguna, usa el país (0.6)", () => {
    const contrato = exigirContrato(
      contratoSintetico({
        clausulas: [
          "PRIMERA. OBJETO. Soporte bajo demanda.",
          "SEGUNDA. VALOR. El presente contrato no tiene un valor determinado.",
          "TERCERA. GARANTÍAS. Póliza de cumplimiento para órdenes que superen (USD 50,000.00) o (COP $200.000.000).",
        ],
      }),
    )
    expect([contrato.moneda.valor, contrato.moneda.confianza]).toEqual(["COP", 0.6])
  })

  test("RTN de 14 dígitos sin país en el domicilio → HN inferido", () => {
    const contrato = exigirContrato(
      contratoSintetico({
        preambulo:
          "Entre AGROEXPORT PRUEBA S. DE R.L., identificada con RTN 08019995123456, con domicilio en San Pedro Sula, quien en adelante se denominará EL CONTRATANTE, y PERIFERIA IT GROUP S.A.S., NIT 900.123.456-7, EL CONTRATISTA:",
      }),
    )
    expect([contrato.nit_cliente.valor, contrato.nit_cliente.confianza]).toEqual(["08019995123456", 0.95])
    expect([contrato.pais.valor, contrato.pais.confianza]).toEqual(["HN", 0.8])
    expect([contrato.cliente.valor, contrato.cliente.confianza]).toEqual(["Agroexport Prueba S. de R.L.", 0.8])
  })

  test("RUC panameño 155612345-2-2019 sin país en el domicilio → PA inferido y nit antes del primer guion", () => {
    const contrato = exigirContrato(
      contratoSintetico({
        preambulo:
          "Entre LOGÍSTICA PRUEBA S.A., identificada con RUC 155612345-2-2019, con domicilio en Colón, quien en adelante se denominará EL CONTRATANTE, y PERIFERIA IT GROUP S.A.S., NIT 900.123.456-7, EL CONTRATISTA:",
      }),
    )
    expect([contrato.nit_cliente.valor, contrato.nit_cliente.confianza]).toEqual(["155612345", 0.95])
    expect([contrato.pais.valor, contrato.pais.confianza]).toEqual(["PA", 0.8])
  })

  test("si el único NIT es el de Periferia, nit_cliente queda null", () => {
    const contrato = exigirContrato(
      contratoSintetico({
        preambulo: "Entre PERIFERIA IT GROUP S.A.S., identificada con NIT 900.123.456-7, EL CONTRATANTE, y otra parte:",
      }),
    )
    expect([contrato.nit_cliente.valor, contrato.nit_cliente.confianza]).toEqual([null, 0])
  })
})
