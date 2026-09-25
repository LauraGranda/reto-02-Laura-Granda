# SOLUCIÓN · Agente de Registro de Contratos Vigentes

> Reto técnico 02 · Periferia IT Group · Laura Granda
> Link público: (https://reto-02-laura-granda-production.up.railway.app/)

---

## 1. Problema en una frase

El maestro de contratos está congelado desde el 30 de mayo de 2026 y solo llegan a administración los contratos que exigen póliza, así que nadie sabe con certeza qué está vigente, qué vence ni qué garantías faltan.

**A quién le duele:**

| Actor | Dolor |
|---|---|
| Analista administrativa | No tiene una fuente de verdad; reconstruye el estado de cada contrato a mano. |
| Gerencia | No puede responder "¿qué vence este trimestre?". |
| La empresa | Pólizas exigidas que no se constituyen o vencen sin renovarse; el proceso murió cuando se fue una persona. |

---

## 2. Arquitectura

```
Navegador (web/index.html)
   │  POST /api/chat · GET /api/sessions/:id · GET /api/health · POST /api/reset
   ▼
src/server.ts (solo HTTP)
   ▼
src/agent/loop.ts (ciclo del agente + guardrails)
   ├──► src/llm/adapter.ts ──► gemini.ts | anthropic.ts   (fabrica.ts elige por LLM_PROVIDER)
   └──► src/tools/contratos.ts (6 herramientas) ──► src/tools/dominio/ (lógica pura)
                                   │
                    fixtures/ (solo lectura)      out/ (escritura: maestro, historial, log, alertas)
```

| Pieza | Dónde vive | Responsabilidad |
|---|---|---|
| Comportamiento | `agent/prompt.md` (inglés) | Cómo actúa el agente: flujo, guardrails, formato de respuesta. |
| Conocimiento | `src/knowledge/registro-contratos.md` (español) | Manual del proceso: clasificaciones, reglas RN1–RN7, confianza, esquema del maestro, alertas. |
| Ejecución | `src/tools/` | Las únicas fuentes de valores que el agente puede afirmar. |

Un cambio de reglas de negocio se hace en `src/tools/dominio/` (umbrales y constantes en `reglas.ts`) y en el conocimiento; nunca en el servidor.

**Decisiones de estructura:**

- **Un solo servidor Bun** sirve el front y la API: un comando, un despliegue, sin CORS.
- **Desviación justificada de la estructura sugerida:** el ciclo vive en `src/agent/loop.ts` y no dentro de `server.ts`, para probarlo sin HTTP; la lógica de las herramientas vive en `src/tools/dominio/`, de modo que toda la ejecución queda bajo `src/tools/`.
- **Envoltorio común de herramientas** (`ejecutarConSeguridad`): ninguna herramienta lanza excepciones, todas responden `{ ok, data | error }` y cada ejecución queda en `out/log.jsonl` (RN7).
- **Sin framework de agentes.** Usé los SDK oficiales de Google y Anthropic y un ciclo propio: el PRD evalúa justamente el ciclo, el adaptador y los guardrails, y quería controlarlos.
- **Módulo reutilizable** (`modulo/`): las herramientas se reexportan y el prompt y el conocimiento se generan con `bun run modulo`; un test falla si divergen de la aplicación.

---

## 3. Ciclo del agente

**El bucle.** En cada turno: (1) el ciclo envía al modelo el prompt, el conocimiento, la conversación y las definiciones de las herramientas; (2) si el modelo pide herramientas, valida sus argumentos con zod, las ejecuta (en paralelo cuando el modelo las pide juntas) y le devuelve los resultados; (3) repite hasta que el modelo responde con texto o se alcanza el tope.

**Cómo cumplo cada regla del ciclo:**

| Regla | Implementación |
|---|---|
| CA1 · Tope de iteraciones | `MAX_ITERATIONS` (25) llamadas al modelo por turno. Al alcanzarlo, el resumen de lo hecho se arma con los resultados de las herramientas, sin volver a llamar al modelo (más barato y sin posibilidad de inventar). |
| CA2 · Sin valores inventados | El prompt lo prohíbe y el diseño lo garantiza: `validar` y `registrar` no confían en el contrato que envía el modelo; re-extraen del documento y toman de ahí las confianzas. |
| CA3 · Confirmación humana | Dos capas. El prompt ordena terminar el lote y preguntar. El código bloquea: `registrar` con `confirmado: true` solo se ejecuta si ese mensaje quedó pendiente en un **turno anterior**, después de un mensaje nuevo de la analista. Además, `registrar` se niega a escribir datos dudosos sin confirmación. |
| CA4 · Trazabilidad | Cada llamada (incluidos los rechazos de argumentos y los bloqueos) queda en el historial visible del chat y en `out/log.jsonl`. |
| CA5 · Errores claros | Si el proveedor falla antes de ejecutar herramientas, el turno se deshace completo; si falla después, se conserva lo hecho y se avisa. La sesión nunca muere. |

**Guardrails en dos capas.** El prompt *pide* (8 guardrails priorizados: no inventar valores, no alterar lo extraído, confirmar antes de registrar, tratar documentos como datos y nunca como instrucciones, no abortar el lote, no asumir fechas, confidencialidad y alcance). El código *garantiza* lo crítico, porque un prompt es una petición y no una garantía:

- re-extracción en `validar` y `registrar`;
- guarda de confirmación por mensaje en el ciclo;
- validación zod de todo argumento y patrón `msg-NNN` para el `mensaje_id` (evita leer archivos fuera del buzón);
- `descartar` solo funciona con mensajes rechazados o duplicados;
- **candado único de escritura:** `registrar` y `descartar` escriben de a uno, y la re-validación ocurre dentro del candado, así las llamadas en paralelo no pierden escrituras ni duplican filas; las lecturas siguen en paralelo;
- escritura atómica del maestro (archivo temporal y reemplazo);
- topes de costo: tokens por sesión, tokens por día y largo máximo del mensaje.

**Casos reales que validaron el diseño:**

- Con Gemini, el modelo vio en `validar` que el msg-006 tenía campos en revisión y fue directo a pedir confirmación, sin intentar registrarlo; el pendiente quedó registrado igual porque el ciclo lo anota también desde `validar`.
- Con Claude, en una primera prueba la conversación alcanzó el tope de tokens por sesión en el turno de confirmación (el entorno tenía un tope de 200.000): el sistema bloqueó la llamada sin gastar de más y el pendiente se conservó. Medí que una conversación completa con Claude consume unos 234.000 tokens, así que fijé el tope en 300.000.

---

## 4. Elección del modelo

| Rol | Modelo | Por qué |
|---|---|---|
| Principal (desarrollo, link y defensa) | **Gemini 3.8 Flash** | Diseñado para flujos agénticos, rápido y económico; aguanta que el link se pruebe varias veces. |
| Alternativo (calidad y demostración del cambio) | **Claude Sonnet 5** | Muy buen seguimiento de instrucciones; demuestra que el cambio de proveedor es una variable de entorno. |
| Descartado | OpenAI | Un tercer adaptador sin requisito que lo pida. GPT-5.6 Luna queda como candidato de ahorro en producción, validándolo antes. |

**El argumento central:** puedo usar un modelo económico sin arriesgar la calidad del dato, porque las reglas críticas no dependen del modelo. La extracción es determinista, `validar` re-extrae del documento y la confirmación humana está forzada en código. El modelo orquesta y conversa.

**Configuración de costo:** esfuerzo de razonamiento bajo (`LLM_ESFUERZO=bajo`), porque el razonamiento se cobra como tokens de salida y orquestar herramientas no lo necesita; sin cambiar los parámetros de muestreo de Gemini 3.x, como recomienda Google.

**Costo medido.** Corrí la misma conversación completa con ambos proveedores: procesar el buzón de 6 mensajes y confirmar el msg-006. El servidor registra los tokens de cada turno.

| Proveedor | Precio (entrada / salida por millón de tokens) | Iteraciones | Tokens (entrada / salida) | Costo por conversación | Costo por contrato |
|---|---|---|---|---|---|
| Gemini 3.8 Flash | USD 0,75 / 3,75 (introductorio hasta el 31-dic-2026) | 9 | 121.862 / 8.196 | **USD 0,12** | **≈ USD 0,02** |
| Claude Sonnet 5 | USD 2 / 10 | 11 | 222.023 / 12.014 | **USD 0,56** | **≈ USD 0,09** |

**Lo que muestran los datos:**

- **Los dos llegaron al mismo resultado correcto.** La calidad del dato no dependió del modelo, así que la elección fue una decisión de costo respaldada con evidencia: Gemini costó 4,6 veces menos.
- **Claude hizo más iteraciones en secuencia** y, como cada iteración reenvía el historial, consumió 1,8 veces más tokens de entrada.
- **El historial es el mayor costo.** Con Gemini, confirmar un solo contrato consumió 55.672 tokens de entrada, el 40 % de la conversación, porque arrastra los resultados de las 17 herramientas del turno anterior. Compactar esos resultados es la siguiente optimización.
- Una consulta suelta después de reiniciar la demo costó unos USD 0,03 con Gemini.

Los precios introductorios de Gemini terminan el 31 de diciembre de 2026; habría que reevaluar entonces.

---

## 5. Estrategia de extracción

**Principio:** extracción 100 % determinista (regex y heurísticas), sin LLM. Cada valor extraído trae su evidencia: el fragmento del documento del que sale (o su fuente declarada, como la fecha del correo).

**Cómo encuentro cada dato:** el contrato se divide en cláusulas por sus encabezados y cada dato se busca **solo dentro de su cláusula**. Así, el monto de la cláusula de garantías del contrato marco nunca se toma como su valor.

| Dato | Cómo se obtiene |
|---|---|
| Número | Patrón `No. XX-AAAA-N` en el encabezado; en un otrosí, el contrato que modifica. |
| Partes | NIT/RUC/RTN de la parte que aparece antes de "EL CONTRATANTE"; nunca el NIT de Periferia. Razón social desde el bloque de firmas. |
| País | Primero el domicilio del contratante; si no aparece, el formato del identificador (NIT → CO, RUC de 13 dígitos → EC, RUC de 11 → PE, RUC con guiones → PA, RTN de 14 → HN). |
| Valor y moneda | Paréntesis de la cláusula VALOR, entendiendo `265.000.000` y `120,000.00`. Si el contrato no fija valor (por demanda): valor 0 a revisión, y la moneda sale de otra mención en el contrato (solo la moneda, nunca el monto) o, como último recurso, de la moneda del país, siempre a revisión. |
| Plazo | Fechas en palabras ("primero (1) de agosto de 2026"); si el plazo va en meses, se deriva la fecha de fin. El otrosí nunca sobrescribe la fecha de inicio. |
| Póliza | Cláusula de garantías, con el vocabulario del maestro (`cumplimiento`, `responsabilidad_civil`, `calidad`, `salarios_prestaciones`). |

**Cómo calculo la confianza:** una escala fija, explicable y auditable, en lugar de pedirle al modelo que se autoevalúe (en mi tesis de maestría sobre evaluación de LLM vi lo poco confiable que es esa autoevaluación).

| Confianza | Significado | Ejemplo |
|---|---|---|
| 0,95 | Explícito en el texto | Valor en la cláusula VALOR |
| 0,8 | Inferido de una fuente confiable | País por el tipo de identificador |
| 0,6 | Derivado por cálculo | Fecha de fin = inicio + 12 meses |
| 0,5 | Ambiguo | Valor "por demanda" |
| 0 | Ausente; nunca se inventa | Sin número de contrato |

Todo dato por debajo de **0,8** va a revisión humana, junto con los **conflictos**: mismo número con otro identificador, fecha de fin anterior a la de inicio, o un dato enviado por el modelo que no coincide con el documento. En un otrosí solo se evalúan los campos que cambian.

**Clasificación:** RN1 duplicado (mismo número, valor y fechas), RN2 actualización (mismo número con cambios, otrosí, o mismo NIT con objeto similar ≥ 0,9 por coeficiente de Dice), RN3 nuevo, RN4 rechazado. Un otrosí ya aplicado es duplicado (idempotencia).

**Dónde entra el modelo y dónde no:** el modelo decide el orden de las herramientas, conversa con la analista y presenta resultados. No extrae, no clasifica, no calcula confianzas y no puede registrar datos dudosos sin aprobación.

---

## 6. Regla de gobierno

**Objetivo:** que ningún contrato quede fuera del maestro, tenga o no póliza, y que el proceso sobreviva a la rotación de personas.

**1. Canal único.** Todo contrato se envía a `contratos@periferia…` (buzón compartido). Lo administra la **analista administrativa**, con un **backup nombrado** en el área administrativa. Ningún otro canal es válido para registrar un contrato.

**2. Obligación del comercial.** Enviar al buzón, en máximo **3 días hábiles desde la firma**: el contrato firmado en PDF, cada otrosí y las actas de terminación. Asunto: `[CONTRATO] Cliente – Nº de contrato`. Aplica a todos los contratos, **con o sin póliza**.

**3. Acuse automático.** En minutos, el agente responde al comercial con: recibido, clasificación (nuevo, actualización, duplicado o rechazado), datos pendientes de confirmar y, si el remitente no está registrado, la solicitud de indicar el comercial responsable.

**4. Excepciones y escalamiento.**

| Caso | Qué pasa |
|---|---|
| Contrato sin firma | Se retiene sin registrar y se devuelve al comercial. Si no se corrige en 2 días hábiles, se escala al director comercial. |
| Datos dudosos (ej. sin valor determinado) | Revisión de la analista con la evidencia; si hace falta, consulta al comercial. |
| Remitente no registrado | Se registra igual, y la dirección comercial actualiza la lista de comerciales. |
| Contrato firmado y no enviado | Se detecta en el cruce mensual con facturación (indicador) y se escala al director comercial. |

**5. Cierre del gap (junio–agosto de 2026).** Una campaña de **2 semanas**: la analista cruza la facturación de junio a agosto contra el maestro; cada cliente facturado sin contrato registrado se asigna a su comercial, que lo envía al buzón con el formato estándar. Termina cuando todo cliente facturado del periodo tiene su contrato registrado o una justificación.

**6. Indicador mensual.** **% de contratos facturados que existen en el maestro** (meta ≥ 95 %). Complementario: días entre la firma y el registro (meta: mediana ≤ 3 días hábiles).

**Pregunta abierta: ¿quién es el dueño del maestro?** La analista administrativa, con backup nombrado. Gerencia es la dueña del reporte de alertas, que recibe cada semana. La dirección comercial es responsable de que los contratos lleguen y de mantener la lista de comerciales.

---

## 7. Decisiones y trade-offs

| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| Extracción con regex | Extraer con el LLM | Trazable, determinista y sin costo por token; el valor registrado siempre sale del documento. |
| `validar` y `registrar` re-extraen del documento | Confiar en el contrato que envía el modelo | El documento es la fuente de verdad; el modelo no puede colar valores alterados ni subir confianzas. |
| Confirmación forzada en código | Solo en el prompt | Un prompt es una petición; el código garantiza CA3 aunque el modelo se equivoque. |
| Ciclo propio con SDK oficiales | Framework de agentes (LangGraph, Mastra) | El PRD evalúa el ciclo, el adaptador y los guardrails; un agente con 6 herramientas no justifica el framework. Se pierde observabilidad lista, cubierta con el log. |
| Candado único de escritura | Ejecutar herramientas una por una | Las lecturas siguen en paralelo y la protección no depende del ciclo ni del prompt. |
| Esquema tolerante a claves ausentes | Exigir todas las claves | El modelo omite los `null` al generar argumentos; se acepta al recibir y se valida estricto al guardar, porque se re-extrae del documento. |
| Comparar solo campos de negocio | Comparar todos los campos | El maestro guarda objeto y cliente resumidos; compararlos daría falsas actualizaciones. |
| Prompt en inglés y conocimiento en español | Todo en un idioma | Menos tokens en cada llamada; el conocimiento lo mantiene el dueño del proceso, en su idioma. |
| Preguntar la fecha de las alertas | Usar una fecha predeterminada o la real | No agrega complejidad y respeta CA2; las sugerencias del front ya incluyen la fecha. |
| Fecha de registro real | Simular la fecha de registro | No falsear un dato de auditoría. |
| Convertidor de Markdown propio | Librería externa | Sin dependencias; escapa todo el HTML antes de convertir (sin XSS). |
| Módulo generado y verificado con test | Copiar archivos a mano | Imposible que diverja sin que falle un test. |
| Railway, una réplica | Vercel / varias réplicas | Disco escribible para `out/`; sesiones y candado viven en memoria. |

**Dependencias:** `zod` (obligatorio), `papaparse` (CSV con comas dentro de los campos) y los SDK oficiales de Anthropic y Google; en desarrollo, `typescript` (verificación de tipos) y los tipos de Bun y de papaparse.

---

## 8. Supuestos

**Interpretación del PRD**
- Orden de las reglas: RN4 → otrosí → RN1 → RN2 → RN3. RN2 ("mismo número y algún campo distinto") choca con RN1; RN1 va primero para que un reenvío idéntico nunca sea actualización.
- `contratos_extraer` devuelve las 11 columnas de 7.2 que salen del texto; `estado_poliza`, `comercial`, `ruta_sharepoint`, `fecha_registro` y `fuente` las calculan `validar` y `registrar`.
- Sin cláusula de garantías, `requiere_poliza` es `false`; si la garantía no es una póliza (ej. bancaria), queda `null` y va a revisión.
- Un contrato nuevo no se registra, aun confirmado, si le falta cliente, NIT, país, valor, moneda, fechas o la indicación de póliza.
- Un archivo archivado nunca se sobrescribe, y el mensaje se marca procesado solo al final: si algo falla, se puede reintentar.
- "Pólizas no vigentes" incluye contratos ya terminados: la póliza sigue siendo un riesgo abierto.

**Extracción**
- El nombre del cliente se toma del bloque de firmas (mayúsculas correctas).
- msg-006: la firma no tiene día, así que la fecha de inicio es la de recepción del correo (2026-08-31, confianza 0,8) y la fecha de fin se deriva a 12 meses (0,6); la analista confirma o corrige.
- La póliza condicional del contrato marco se registra como exigida y `pendiente` (criterio conservador).
- Si el formato del identificador no permite deducir el país, el país queda `null` y pasa a revisión.

**Clasificación y registro**
- Un otrosí ya aplicado es duplicado; un otrosí de un contrato inexistente va a revisión.
- Un otrosí que exige ampliar garantías cambia la póliza a `pendiente`, y se muestra como diferencia antes de registrar.
- Coincidencia por NIT y objeto con otro número de contrato: va a revisión.
- Remitente no registrado: se reporta sin bloquear y se guarda su correo en la columna `comercial`.
- El otrosí se archiva como `<id>-otrosi-<n>.<ext>`, conservando la ruta original de la fila.
- Sin número de contrato: `registrar` asigna `AUTO-<año de inicio>-<secuencia>`.
- Con confirmación, el valor de la analista es el final; el historial guarda quién confirmó, lo extraído y lo final.
- Un duplicado no genera historial (solo log); un mensaje ya procesado no se registra dos veces; `descartar` solo aplica a rechazados o duplicados.
- Se agregó la herramienta `contratos_descartar` (el contrato mínimo del PRD lo permite) para cerrar mensajes que no se registran.

**Alertas**
- La fecha de referencia (`hoy`) existe para que el resultado sea determinista (HU-5) y se usa para los vencimientos; el rango de 60 días incluye ambos extremos.
- La fecha de registro es la real del sistema; el filtro "desde el corte" no tiene límite superior. La demo sin modelo fija 2026-09-03 por determinismo, inyectada en el contexto y nunca por el modelo.
- Dos secciones informativas extra al final, marcadas: contratos ya vencidos y actualizados desde el corte.

---

## 9. Cobertura

| Historia | Estado | Evidencia |
|---|---|---|
| HU-1 · Leer el buzón | Hecho | Tests, `demo.ts`, prueba real |
| HU-2 · Extraer con confianza | Hecho | Tests por contrato, `demo.ts` |
| HU-3 · Validar y clasificar | Hecho | Tests (6 mensajes, idempotencia, conflictos) |
| HU-4 · Registrar y archivar | Hecho | Tests, `demo.ts` (11 filas, fixture intacto) |
| HU-5 · Alertas | Hecho | Tests (bordes de 60 días, determinismo) |
| HU-6 · Manejo de errores | Hecho | Tests de errores; el lote nunca se aborta |
| CA1–CA5 | Hecho | Tests con modelo simulado (incluye un modelo que intenta saltarse la confirmación) |
| Bonus 9.4 · Módulo | Hecho | `modulo/` + test de no divergencia |
| `contratos_leer_pdf` (P1) | No hecho | Fuera de alcance; los fixtures traen el texto |

**Pruebas:** 139 tests automatizados (con un modelo simulado, sin red ni claves); `bun run demo.ts` se autoverifica; en una máquina limpia, el proyecto se instala y arranca con un solo comando, y los tests y la demo corren sin claves; la conversación completa se probó con Gemini y con Claude con el mismo resultado.

**Qué falta para producción:** lectura de PDF y OCR para escaneados; conexión real a Exchange y SharePoint (hoy se archiva el `.txt`); autenticación y roles; persistencia de sesiones, maestro y contador de uso en una base de datos; acuse automático real al comercial.

---

## 10. Uso de IA

| Herramienta | Para qué |
|---|---|
| Claude (chat) | Analizar los tres retos y elegir este; planear las fases; revisar el PRD contra los fixtures; revisar prompts, conocimiento y decisiones antes de implementarlas. |
| Claude Code | Escribir el código fase por fase, con un `CLAUDE.md` que fijaba reglas de estilo, estructura y resultados esperados. |


**Propuestas de la IA que acepté con ajustes:** re-extraer en `validar`; mostrar el cambio de póliza como diferencia; la guarda de confirmación por mensaje (sin cortar el turno y activada también desde `validar`); el candado de escritura (único y con la re-validación dentro).

**Lo que aprendí de las pruebas reales con Gemini:**

| Métrica | Primera corrida | Tras la corrección |
|---|---|---|
| Llamadas a herramientas | 21 | 17 |
| Llamadas fallidas | 4 | 0 |
| Argumentos inválidos | 3 | 0 |

El modelo omitía las claves con `null` al generar argumentos. Lo corregí en el esquema, no en el prompt, porque es un comportamiento del modelo: menos costo y menos latencia. También vi que el agente a veces omitía el motivo de los rechazos; la lección es que **lo que el PRD exige mostrar debe estar escrito en el prompt**, no dejarse al criterio del modelo.

Por último, medí en lugar de suponer: el servidor registra en consola los tokens de cada turno, y con eso comparé ambos proveedores en la misma conversación. Esa medición es la que sostiene la elección del modelo.

---

## 11. Riesgos de llevarlo a producción

| Riesgo | Impacto | Mitigación |
|---|---|---|
| Contratos escaneados o en PDF | Alto | OCR y lectura de PDF; mismo flujo de confianza y revisión. |
| El proceso depende de que los comerciales envíen | Alto | Regla de gobierno, acuse automático e indicador mensual contra facturación. |
| El modelo inventa, redondea o salta la confirmación | Alto | Re-extracción del documento y confirmación forzada en código. |
| Inyección de instrucciones desde documentos | Medio | Los documentos son datos; ninguna acción crítica depende del modelo. |
| Falsos duplicados por variaciones del nombre | Medio | Deduplicar por NIT antes que por nombre; revisión humana de coincidencias entre 0,7 y 0,9, o embeddings. |
| Formatos de identificador no cubiertos (ej. un RUC panameño sin guiones) | Medio | Quedan en revisión; catálogo de formatos por país. |
| Varias analistas o servidores escribiendo a la vez | Medio | Hoy un candado en memoria; en producción, base de datos con transacciones. |
| Costo y abuso del link público | Medio | Topes por sesión y por día, largo máximo de mensaje y límite de gasto en el proveedor. |
| El historial reenviado en cada llamada domina el costo y acerca el tope de sesión (con Claude, ~234.000 de 300.000 tokens) | Medio | Compactar los resultados de herramientas de turnos anteriores; caché de prompt; reintentos con espera ante límites de velocidad. |
| Reglas propias de cada proveedor que cambian con sus versiones | Medio | Tests de traducción por proveedor y revisar las notas de versión antes de actualizar el SDK. |
| Reinicio del servicio | Bajo en demo | Hoy se pierden sesiones y `out/`; en producción, persistencia real y SharePoint. |
| Prórroga automática de contratos marco no modelada | Bajo | Alerta manual; regla de renovación en una siguiente versión. |
| Datos reales en planes gratuitos de proveedores | Alto | Solo planes de pago con políticas de datos adecuadas. |

**Mejoras siguientes:** conectar un buzón de correo real y enviar las alertas automáticamente cuando corresponda, sin que una persona tenga que pedirlas; un front más interactivo; respaldo automático entre proveedores; historial con valores iniciales de cada contrato; validar cruzado con el cuerpo del correo (si dice "no pide póliza" y el contrato sí, a revisión), y un conjunto de evaluación del agente para comparar más modelos y encontrar el mejor equilibrio entre calidad y precio.
