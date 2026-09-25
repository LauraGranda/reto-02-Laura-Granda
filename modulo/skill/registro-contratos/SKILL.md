---
name: registro-contratos
description: Manual del proceso de registro de contratos vigentes (clasificaciones, reglas RN1–RN7, confianza, esquema del maestro y alertas). Úsalo al procesar contratos del buzón.
---
# Manual del proceso: registro de contratos vigentes

## 1. Contexto
El maestro de contratos vigentes está congelado desde el **2026-05-30**. A partir de ahora, todos los contratos se reciben en un buzón único y deben registrarse, **con o sin póliza**. Cada documento se archiva en `Contratos/<año de inicio>/<cliente>/`.

## 2. Glosario
| Término | Significado |
|---|---|
| Contrato | Documento firmado con número, partes, objeto, valor, plazo y, si aplica, garantías. |
| Contrato marco | Contrato sin valor fijo; los servicios se piden por órdenes de servicio. |
| Otrosí | Modificación de un contrato existente (plazo, valor, garantías). |
| Póliza | Garantía exigida al contratista. Tipos: `cumplimiento`, `responsabilidad_civil`, `calidad`, `salarios_prestaciones`. Varias se separan con `;`. |
| estado_poliza | `vigente` (constituida), `pendiente` (exigida y aún sin constituir o ampliar), `vencida`, `no_aplica` (el contrato no exige póliza). |
| Valor indeterminado | Contrato por demanda: valor 0, siempre en revisión. |
| NIT / RUC / RTN | Identificador tributario: NIT (Colombia), RUC (Ecuador, Perú, Panamá), RTN (Honduras); sin puntos ni dígito de verificación. |

## 3. Clasificaciones
| Clasificación | Cuándo | Qué pasa con el maestro |
|---|---|---|
| nuevo | No coincide con ninguna fila. | Se inserta una fila. |
| actualizacion | Mismo número con algún dato distinto, o un otrosí. | Se modifican solo los datos que cambian. |
| duplicado | Mismo número, valor, fecha de inicio y fecha de fin. | No se escribe nada. |
| rechazado | Sin adjunto de contrato (ej. una cotización) o sin partes ni objeto identificables. | No se escribe nada; se reporta el motivo. |

## 4. Reglas del negocio
- **RN1 Duplicado.** Se evalúa antes que la actualización: un reenvío idéntico nunca cambia el maestro.
- **RN2 Actualización.** Mismo número con algún cambio, o mismo NIT del cliente con un objeto casi idéntico (similitud ≥ 0.9). Si coinciden NIT y objeto pero el número es distinto, el número pasa a revisión. El objeto se usa para detectar coincidencias por NIT; para calcular cambios no se comparan objeto ni nombre del cliente, porque el maestro guarda versiones resumidas.
- **Otrosí.** Siempre modifica un contrato existente. Solo se revisan los datos que cambian; lo demás se conserva del maestro. Si el otrosí ya está aplicado, es duplicado. Si su contrato no existe en el maestro, el número pasa a revisión. Cuando exige ampliar las garantías, la póliza pasa a `pendiente`.
- **RN3 Nuevo.** Sin coincidencias. Si no trae número, al registrarlo se asigna `AUTO-<año>-<secuencia>`.
- **RN4 Rechazado.** Ver la tabla de clasificaciones.
- **RN5 Revisión humana.** Pasan a revisión humana los datos con confianza menor a 0.8 y los conflictos: mismo número de contrato con otro identificador, fecha de fin anterior a la de inicio, o un dato enviado que no coincide con lo que dice el documento.
- **RN6** El maestro congelado es de solo lectura; se trabaja sobre una copia en SharePoint.
- **RN7** Toda operación queda en el log del sistema.
- Un contrato nuevo con póliza entra en estado `pendiente`; sin póliza, `no_aplica`.
- Una póliza condicional (ej. solo sobre cierto monto) se registra como exigida y `pendiente`.
- Un documento con errores no detiene a los demás.
- Un mensaje ya procesado no se vuelve a registrar.
- Solo se descartan mensajes rechazados o duplicados; un contrato registrable nunca se descarta.

## 5. Confianza de los datos
Cada dato extraído trae su confianza y su evidencia (el texto del que sale).

| Confianza | Significa | Ejemplo |
|---|---|---|
| 0.95 | Explícito en el texto. | "Valor: COP $…" |
| 0.8 | Inferido de una fuente confiable. | País según el tipo de identificador. |
| 0.6 | Derivado por cálculo. | Fecha de fin = inicio + plazo en meses. |
| 0.5 | Ambiguo. | Valor "por demanda". |
| 0 | Ausente en el texto; nunca se inventa. | Sin número de contrato. |

El **umbral es 0.8**. Por debajo, la analista revisa el dato y su evidencia antes de registrar. Los datos con confianza 0.8 o más se registran sin revisión; su evidencia queda disponible para consulta.

## 6. Columnas del maestro
| Columna | Significado |
|---|---|
| id_contrato | Número del contrato (o AUTO). |
| cliente | Razón social de la contraparte. |
| nit_cliente | Identificador tributario del cliente. |
| pais | CO, EC, PE, PA o HN. |
| objeto | Qué se contrató (máx. 200 caracteres). |
| valor | Monto sin separadores; 0 si es indeterminado. |
| moneda | COP, USD, PEN, PAB o HNL. |
| fecha_inicio | Inicio de la vigencia (AAAA-MM-DD). |
| fecha_fin | Fin de la vigencia (AAAA-MM-DD). |
| requiere_poliza | Si el contrato exige póliza. |
| tipo_poliza | Tipos exigidos, separados por `;`. |
| estado_poliza | Situación de la póliza. |
| comercial | Quien envió el contrato. |
| ruta_sharepoint | Ubicación del documento archivado. |
| fecha_registro | Cuándo entró al maestro. |
| fuente | buzon, manual o migracion. |

## 7. Confirmación humana
Con datos en revisión, el registro espera la respuesta de la analista. Si **confirma**, se registra con los datos mostrados; si **corrige** un valor, con el valor corregido. El historial guarda quién confirmó, qué datos se confirmaron y, por cada corrección, el valor extraído y el valor final. Aun confirmado, un contrato nuevo no se registra si le falta alguno de estos datos: cliente, nit_cliente, pais, valor, moneda, fecha_inicio, fecha_fin o requiere_poliza.

## 8. Remitentes no registrados
Si el correo del remitente no está en la lista de comerciales, se reporta como aviso y **no bloquea** el registro; la columna `comercial` guarda su correo para agregarlo después a la lista.

## 9. Alertas para gerencia
Reporte para gerencia, con la **fecha de referencia** que indica la analista:
1. **Vencen en los próximos 60 días**, contando el día de referencia y el día 60.
2. **Pólizas exigidas no vigentes**: pendientes o vencidas, aunque el contrato haya terminado.
3. **Registrados desde el corte** (2026-05-30): lo que el proceso recuperó.
4. **Ya vencidos** (informativo): contratos con fecha de fin pasada.
5. **Actualizados desde el corte** (informativo): otrosíes aplicados según el historial.

Sin hora de generación: la misma fecha produce el mismo reporte.
