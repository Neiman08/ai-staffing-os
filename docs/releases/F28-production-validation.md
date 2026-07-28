# F28 — Corrección de misiones reales (Roofing & Landscaping, Illinois)

Cierre de fase, 2026-07-28. Diagnóstico, corrección, tests, deploy y validación en producción de los problemas reales encontrados en dos Daily Revenue Missions ejecutadas el 2026-07-27 (roofing y landscaping en Illinois).

## 1. Objetivo

Investigar y corregir en conjunto los problemas reales detectados en dos misiones reales ejecutadas en producción:

1. Roofing contractors en Illinois.
2. Landscaping y lawn care en Illinois.

Alcance explícito, definido por el PO al arrancar F28:

- Crear Leads, Opportunities y Drafts — nunca enviar correos automáticamente, nunca aprobar automáticamente.
- Restringir estrictamente a Illinois salvo expansión explícita ("estados vecinos", "Midwest").
- Aislar cada misión de cualquier otra (nunca reutilizar empresas de otra misión/campaña sin pedirlo explícitamente).
- Clasificar correctamente roofing y landscaping (nunca aceptar "construction" genérico como roofing; nunca aceptar garden centers/viveros/proveedores como landscaping).
- Reportes ejecutivos honestos, sin números imposibles.
- No enviar ningún correo real durante toda la corrección.

## 2. Problemas detectados

Reportados originalmente por el PO a partir de una misión real de roofing (Illinois, 2026-07-27) que:

- Encontró 25 empresas pero "seleccionó" 33 para la campaña, incluyendo compañías de una misión anterior de data centers y demo seed.
- Aceptó empresas de construcción genérica ("IRPINO Construction") como si fueran roofing.
- Extrajo y persistió `admin@www.advancedroofing.biz` como email organizacional.
- Bloqueó la creación de Drafts pese a que la instrucción los pedía explícitamente ("no enviar correos" apagaba también "redactar").
- Reportó "empresas contactadas" sin haber enviado ningún correo real.

Una corrida posterior de landscaping en Illinois expuso dos problemas adicionales, no visibles hasta ejecutar en producción real:

- El gate que decide si correr descubrimiento+validación externa real solo se activaba si la Industry amplia del CRM estaba vacía o se pidió un volumen explícito — con Construction ya poblado, la misión de roofing nunca pasaba por la validación de trade específico.
- `GET /missions/:id` mostraba el historial completo de una Campaign reusada (de misiones anteriores), no solo lo que la misión actual había seleccionado.
- `landscaping` no tenía ninguna Industry real del CRM asociada — cualquier candidato, por bien clasificado que estuviera, se rechazaba al persistir.

## 3. Causas raíz

| # | Causa raíz | Ubicación |
|---|---|---|
| A | `allowMessageSending` (pensado para "no enviar") también gateaba la creación de Drafts | `mission-orchestrator.ts`, `discovery-conversion.ts` |
| B | Taxonomía de landscaping con solo 5 sinónimos y 1 exclusión | `taxonomy.ts` |
| C | `validateBusinessCandidate` nunca leía su propio input de estado; `classifyCandidate` pasaba el estado de la QUERY, no el real del candidato | `business-validation.ts`, `mission-executor.ts` |
| D | `select_target_companies` filtraba por industria/estado/ciudad en TODO el CRM, sin ningún filtro por misión | `campaign-tools.impl.ts` |
| D (reporte) | `selectedCompanies` de Mission Detail leía TODAS las CampaignCompany de una Campaign reusada, no solo las de la misión actual | `missions/service.ts` |
| D (gate) | El gate de descubrimiento externo se saltaba si la Industry amplia ya tenía cualquier empresa, sin importar el trade pedido | `mission-orchestrator.ts` |
| E | Un candidato encontrado vía la query genérica "construction" se validaba solo contra evidencia genérica | `business-validation.ts` |
| F | El Executive Report es texto libre de LLM sin invariantes posteriores | `ceo-tools.impl.ts` |
| G | Sin allowlist de vocabulario propio del producto (Leads, Drafts, hiring signals...) | `ceo-tools.impl.ts` |
| H | Sin normalización de `www.` en el dominio del email extraído | `email-trust.ts`, `website-intelligence/extract.ts` |
| I | Sin causa raíz de código — Playwright ausente en Render es una decisión ya documentada; PDL ya se degradaba correctamente | — |
| (B, seguimiento) | `landscaping` sin ninguna Industry real del CRM asociada (`crmIndustryBucket: null`) | `taxonomy.ts`, `packages/db/prisma/seed.ts` |

## 4. Cambios implementados

- **A** — Nuevo flag independiente `allowDraftCreation` en `MissionRestrictions`, detectado por separado del regex de "no enviar"; ambos gates de creación de Draft (`mission-orchestrator.ts`, `discovery-conversion.ts`) migrados de `allowMessageSending` a `allowDraftCreation`.
- **B** — Taxonomía de `landscaping` ampliada (sinónimos, formas cortas de `companyTypes`, exclusiones de retail/vivero/supply).
- **C** — Geo-rechazo real en `business-validation.ts` contra el estado detectado del candidato (no el de la query); soporte real para "Midwest"/"estados vecinos" en `geo.ts`.
- **D** — `restrictToCompanyIds` explícito, poblado desde `DiscoveryExecutionReport.createdCompanyIds`, en vez de intentar matchear por `AgentTask.id` (que apunta al task hijo, nunca al de la misión).
- **D (reporte)** — `selectedCompanies` filtrado por `select_target_companies.output.companyIds` de la misión actual.
- **D (gate)** — nueva condición `hasSpecificTradeMatch`: un trade específico (no genérico) siempre fuerza descubrimiento+validación real, sin importar cuántas empresas de otros trades ya existan en el bucket amplio.
- **E** — cross-check: un candidato encontrado vía query genérica necesita evidencia real (nombre, categorías de Google Places o descripción) del trade específico pedido por la misión.
- **F** — `emailsSentCount` real + `reportClaimsContactWithoutRealSends()` como invariante que reemplaza el reporte del LLM por uno determinista si miente sobre contacto real.
- **G** — allowlist `KNOWN_CAPABILITY_TERMS` para el vocabulario propio del producto.
- **H** — `normalizeEmailDomain()` (quita `www.` del dominio) aplicado en el punto de extracción y en `email-trust.ts` como defensa en profundidad; `admin@`/`all@` agregados a la clasificación de emails genéricos.
- **I** — sin cambio de código; investigación documentada (ver §6).
- **Industria de Landscaping** — nueva Industry real `"Landscaping & Lawn Care"` (decisión explícita del PO, mismo patrón que Hospitality en F13).

## 5. Commits relevantes

| Commit | Descripción |
|---|---|
| [`d2c2334`](https://github.com/Neiman08/ai-staffing-os/commit/d2c2334e2e3b8c37ee7151742666d80a0cb74ae4) | Fixes A–H (drafts/geo/aislamiento/roofing/reportes/vocabulario/email) |
| [`bcd87b4`](https://github.com/Neiman08/ai-staffing-os/commit/bcd87b4e7b6bf344123ed4ec25e3e498e10a8e61) | Gate de descubrimiento por trade específico + filtro de `selectedCompanies` en Mission Detail |
| [`8e57275`](https://github.com/Neiman08/ai-staffing-os/commit/8e57275df18ddea27d9a112a81b7e98bb3bb8cde) | Nueva Industry real "Landscaping & Lawn Care" |
| [`e7905b4`](https://github.com/Neiman08/ai-staffing-os/commit/e7905b4ef292b3199977153424eedbab1accf6c3) | Fix de conteo hardcodeado de Industries globales (encontrado por CI) |

## 6. Evidencia de CI

Los 4 commits corrieron contra una base de datos limpia (Postgres efímero de GitHub Actions, migraciones + seed desde cero):

| Commit | CI run | Resultado |
|---|---|---|
| `d2c2334` | [30333186244](https://github.com/Neiman08/ai-staffing-os/actions/runs/30333186244) | ✅ success |
| `bcd87b4` | [30335897805](https://github.com/Neiman08/ai-staffing-os/actions/runs/30335897805) | ✅ success |
| `8e57275` | [30356499779](https://github.com/Neiman08/ai-staffing-os/actions/runs/30356499779) | ❌ failure (conteo hardcodeado de 5 Industries globales, roto por la 6ta industria nueva — mismo patrón que F13 ya había dejado documentado) |
| `e7905b4` | [30358256651](https://github.com/Neiman08/ai-staffing-os/actions/runs/30358256651) | ✅ success (fix del conteo, reproducido localmente contra una DB fresca antes de subir) |

Suite completa de `apps/api` (última corrida local, DB no efímera): 1924/1932 tests, 6 skips esperados (gateados por proveedor real), 2 fallas preexistentes y no relacionadas (staleness de DB local + un test no determinista de scheduler con llamada real a OpenAI) — documentadas desde antes de F28.

## 7. Evidencia de despliegue

- Auto-deploy de Render disparado en cada push a `main` (`ai-staffing-os-api`).
- Verificado con comportamiento real, no solo con el health check: `GET /api/v1/missions/plan` reflejando `allowDraftCreation` (campo inexistente antes de F28), taxonomía "Landscaping & Lawn Care", scoping IL-only y `unrecognizedTerms: []` — todo en producción real.
- `GET /api/v1/industries` confirmando las 6 Industries reales, incluida `Landscaping & Lawn Care`, tras la acción manual del PO en Render Shell.
- Dos misiones reales ejecutadas en producción con el código de cada commit ya desplegado (ver §8).

## 8. Comparativo final — Roofing vs. Landscaping (producción real)

| Métrica | Roofing (MIS-...-0006) | Landscaping (MIS-...-0008) |
|---|---|---|
| Empresas descubiertas (crudo, Google Places) | 383 | 195 |
| Duplicadas (ya en CRM) | 129 | 30 |
| Rechazadas — fuera de Illinois | 221 | 119 |
| Rechazadas — evidencia de trade insuficiente | 22 | 0 |
| **Empresas aceptadas** | **11** | **46** |
| Empresas enriquecidas (con dato de contacto real) | 9 / 11 | 24 / 46 |
| Contactos nombrados (Hunter — PDL agotado) | 3 | 10 |
| Emails organizacionales verificados | 4 (18 extraídos, 7 empresas con email válido) | 11 (29 extraídos, 16 empresas con email válido) |
| **Leads creados** | **11** | **46** |
| **Opportunities creadas** | **11** | **46** |
| **Drafts creados** | **3** | **5** |
| **Correos enviados** | **0** | **0** |
| Costo real | $0.6422 | $0.5181 |
| Duración | 188.4 s | 692.7 s |

De los 9 Drafts reales generados entre ambas misiones (incluyendo 1 de un primer intento de roofing anterior al fix del gate), los 9 terminaron en `READY_TO_SEND` — decididos por un humano real (`actorType: HUMAN` en el audit log, verificado también a nivel de código: `decideApproval` es la única función que escribe esa acción y siempre la marca como humana). Cero en estado `SENT`.

## 9. Riesgos abiertos

1. **Google Places sin restricción geográfica a nivel de request** — la query es texto libre (`"<frase> in Illinois"`), sin `locationBias`/`locationRestriction`. Por eso se buscó (y se descartó correctamente después, sin excepciones) en Indiana/Wisconsin/Iowa/Missouri. Ningún dato incorrecto llegó a persistirse, pero se gasta cuota real en resultados descartados. Mejora propuesta: agregar `locationBias` (centro+radio de Illinois) a la request real.
2. **People Data Labs sin créditos** (`402 payment_required` en el 100% de los intentos de ambas misiones). El pipeline se degrada correctamente (Hunter + Website Intelligence siguen funcionando), pero la cobertura de contactos nombrados es menor de lo que sería con PDL activo. Decisión de negocio, no un bug de código.
3. **Website Intelligence sin Playwright en Render** — sitios que dependen de JavaScript para mostrar contacto no se ven (fallback a HTML estático únicamente). Decisión ya documentada y deliberada, pendiente de autorización explícita del PO por el costo/tiempo de build que implicaría activarlo.
4. **Quality gate de Drafts conservador por diseño** (no es un bug) — `opportunityRecommendation = MANUAL_REVIEW` bloqueó la mayoría de las Opportunities de ambas misiones hasta revisión humana; el rendimiento de Drafts por Opportunity va a seguir siendo bajo mientras ese gate exista, a propósito.

## 10. Conclusión final

Los 8 problemas originales (A–H) y los 2 encontrados durante la validación en producción (gate de descubrimiento por trade, y la Industry faltante de landscaping) quedaron diagnosticados con evidencia de código y de las misiones reales, corregidos con cambios acotados, cubiertos con tests de regresión nuevos, validados en CI contra una base limpia, desplegados en Render, y confirmados con dos corridas reales en producción — sin enviar ni aprobar automáticamente ningún correo en ningún momento. F28 se da por cerrada.
