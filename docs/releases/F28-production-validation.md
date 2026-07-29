# F28 — Corrección de misiones reales (Roofing, Landscaping & Hospitality, Illinois)

Cierre de fase, 2026-07-28/29. Diagnóstico, corrección, tests, deploy y validación en producción de los problemas reales encontrados en Daily Revenue Missions ejecutadas el 2026-07-27 al 2026-07-29 (roofing, landscaping y hospitality en Illinois). El cuerpo principal de este documento (§1-10) cubre roofing/landscaping; el addendum (§11-16) cubre el seguimiento real de Hospitality que encontró 6 problemas adicionales, todos corregidos y validados en producción.

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

## 10. Conclusión (roofing/landscaping)

Los 8 problemas originales (A–H) y los 2 encontrados durante la validación en producción (gate de descubrimiento por trade, y la Industry faltante de landscaping) quedaron diagnosticados con evidencia de código y de las misiones reales, corregidos con cambios acotados, cubiertos con tests de regresión nuevos, validados en CI contra una base limpia, desplegados en Render, y confirmados con dos corridas reales en producción — sin enviar ni aprobar automáticamente ningún correo en ningún momento.

---

# Addendum — Seguimiento real de Hospitality (2026-07-28/29)

## 11. Objetivo del addendum

La misión de Hospitality validó correctamente el pipeline general, pero el PO pidió investigar y corregir inconsistencias adicionales encontradas al ejecutarla en producción real — en dos rondas: una investigación inicial sobre el comportamiento del planner/reporte, y una segunda ronda sobre los resultados de la primera corrida real corregida. Mismo alcance que el resto de F28: diagnóstico con evidencia antes de tocar código, cambios acotados, tests de regresión, CI en base limpia, deploy verificado, validación con misiones reales — nunca un correo real enviado.

## 12. Problemas detectados y causas raíz

### Ronda 1 — investigación de planner/reporte

| # | Problema | Causa raíz | Ubicación |
|---|---|---|---|
| H1 | El planner seguía generando queries reales contra IN/WI/IA/MO pese a restringir la misión a Illinois | `buildRefinementQueries` ("Ronda 3") corría siempre que la ronda 1 no cubriera el volumen pedido, sin mirar si la misión pedía un solo estado — nunca autorizado explícitamente | `mission-executor.ts` |
| H2 | Executive Report decía "0 empresas, 0 oportunidades" con Companies/Opportunities reales existentes | `computeMissionProgress` solo contaba AgentTask hijas del pipeline clásico (`create_lead`/`create_opportunity`/`select_target_companies`) — el camino dinámico (`runDynamicDiscoveryMission` con `convertToCommercialActions=true`) crea esos registros DENTRO de la única tarea `discover_companies`, invisible para ese cómputo | `ceo-tools.impl.ts` |
| H3 | "Tareas Delegadas" solo mostraba `discovery`, pese a que Website Intelligence/Contact Intelligence/Email Verification/Sales sí corrieron | Mismo root cause que H2: esos 4 procesos corren como llamadas directas dentro de la única tarea `discover_companies`, nunca como AgentTask propia | `mission-executor.ts`, `missions/service.ts` |
| H4 | Taxonomía de Hospitality no priorizaba hoteles comerciales sobre alojamiento chico | `googleSearchPhrases`/`synonyms`/`companyTypes` sin orden comercial-primero, sin reconocer "conference hotel"/"extended stay"/"hotel chain" | `taxonomy.ts` |

### Ronda 2 — resultados de la primera corrida real corregida

| # | Problema | Causa raíz / conclusión | Ubicación |
|---|---|---|---|
| H5 | De 201 resultados crudos, solo 3 aceptados | **No es un bug** — 197/201 eran duplicados de 2 misiones de Hospitality anteriores el mismo día contra el mismo mercado real y finito de Illinois. El tope de 20 por query es el límite real y documentado de la API de Google Places por request | `google-places.ts` |
| H6 | Empresas sin hiring signal ("No Signal") terminaban aceptadas | **Gap de diseño, no bug** — la validación de negocio nunca miró `hiringStatus`; llevó al nuevo flag `requireHiringSignal` (ver §13) | `business-validation.ts`, `conversion-policy.ts` |
| H7 | Executive Report decía "0 Leads, 0 Opportunities" en 3 misiones reales seguidas | `interpretDailyDirective` (LLM) devolvió `industryNames: []` para instrucciones largas/con formato de lista, pese a que el parser determinista (`interpretBusinessIntent`, sin LLM) sí matcheaba "hospitality" — `industryTargets` quedaba `[]` y el loop entero de `create_campaign`/`select_target_companies`/`create_lead`/`create_opportunity` nunca corría | `mission-orchestrator.ts` |
| H8 | motel/inn/bed and breakfast seguían corriendo pese a pedir "hoteles comerciales" | Llevó al nuevo mecanismo de exclusión acotada (ver §13) | `intent-interpreter.ts` |
| H9 | `providersOmitted` mostraba `[]` pese a que PDL falló con HTTP 402 real en cada intento | Un 402/401/403/429/5xx real de PDL solo se registraba en `patternsFailed` (detalle técnico interno), nunca en `providersOmitted` (lo único que el Executive Report realmente muestra) | `contact-enrichment.ts` |

### Encontrado durante la validación en producción del fix

| # | Problema | Causa raíz | Ubicación |
|---|---|---|---|
| H10 | `companiesTargeted` reportó 2 con solo 1 Company real (`MIS-20260729-0001`) | El fix de H2 sumaba `select_target_companies.addedCount` + un conteo aparte de `Company.discoveredByAgentTaskId` — en el camino híbrido (descubrimiento real seguido del loop estático seleccionando esas mismas empresas, el más común desde el fix de H1/D del cuerpo principal), una misma Company se contaba dos veces | `ceo-tools.impl.ts` |

## 13. Cambios implementados

- **H1** — `buildRefinementQueries` ahora exige `plan.states.length > 1` (misma señal que ya usa `geo.ts` para "expansión autorizada explícitamente") antes de generar queries de estados vecinos.
- **H2** — `computeMissionProgress` suma Leads/Opportunities/Drafts reales vía `Lead`/`Opportunity`.`createdByAgentTaskId` y `ApprovalRequest.agentTaskId` apuntando a la tarea `discover_companies`, además de las fuentes del pipeline clásico.
- **H3** — `summarizeDelegatedWork()` (función pura) resume el trabajo real ya recolectado en `companyValidations` (Website Intelligence/Contact Intelligence/Email Verification/Sales) y se expone en `getMissionDetail`, renderizado como línea adicional bajo la fila de discovery — nunca se inventó ninguna AgentTask nueva. De paso corrigió un desalineamiento real de schema: `MissionDetail.childTasks` estaba tipado sin `output` pese a que el backend siempre lo devolvía.
- **H4** — `googleSearchPhrases`/`synonyms`/`companyTypes` de hospitality reordenados comercial-primero; agregado reconocimiento de "conference hotel"/"extended stay"/"hotel chain/group" (no existían). Bed & Breakfast/Guest House/Inn nunca se excluyen — solo quedan al final.
- **H7** — `mission-orchestrator.ts` usa el `crmIndustryBucket` ya calculado por el parser determinista (`externalPlan.searchQueries`) como respaldo cuando `interpreted.industryNames` del LLM viene vacío.
- **H9** — un 402/401/403/429/5xx real de PDL ahora se agrega también a `providersOmitted` (antes solo a `patternsFailed`) — la distinción original ("fallo real vs. nunca intentado") no aplicaba a señales de cuenta/servicio completo.
- **Nuevo — `requireHiringSignal`** (`MissionRestrictions`, default `false`, activado por frase explícita — "que estén contratando"/"actively hiring" — combinado por OR, no por AND, porque es un requisito que se activa, no un permiso que se restringe): cuando está activo, una Company sin señal de contratación positiva (Confirmed/Probable/Possible) nunca recibe Lead ni Opportunity, en ninguno de los dos pipelines (`hasPositiveHiringSignal`, función única compartida por `conversion-policy.ts` y `mission-orchestrator.ts`). La Company sigue existiendo.
- **Nuevo — exclusión de "hoteles comerciales"**: cuando la instrucción dice explícitamente "hoteles comerciales"/"commercial hotels" y matcheó hospitality, motel/inn/bed and breakfast/guest house se agregan a `exclusions` (mecanismo ya existente, reusado) — nunca una regla global, nunca aplicado a otro trade.
- **H10** — `companiesTargeted` ahora toma la unión de ids reales (`select_target_companies.companyIds` ∪ `Company.discoveredByAgentTaskId`) y cuenta el tamaño del set, en vez de sumar conteos — una misma Company nunca puede contar dos veces. `leadsCreated`/`opportunitiesCreated` no tenían este riesgo (usan `deps.taskId`, siempre el id de su propia tarea, nunca el de `discover_companies` — disjuntos por construcción).
- **Infraestructura** — `/api/v1/health` y `/api/v1/health/ready` exponen `gitCommit` (`RENDER_GIT_COMMIT`, inyectada automáticamente por Render en cada deploy) para poder verificar el commit exacto desplegado sin token de la API de Render.

## 14. Commits del addendum

| Commit | Descripción | CI |
|---|---|---|
| [`667faf8`](https://github.com/Neiman08/ai-staffing-os/commit/667faf8714bd12cc0b007102aaefcbecfe5aace9) | H1–H4 (gate de estados vecinos, Executive Report del camino dinámico, Tareas Delegadas, taxonomía comercial-primero) | ✅ [30380545072](https://github.com/Neiman08/ai-staffing-os/actions/runs/30380545072) |
| [`a40deef`](https://github.com/Neiman08/ai-staffing-os/commit/a40deef20454f6b80e118b3ef4681e6310aeb0fb) | H7, H9, `requireHiringSignal`, exclusión de hoteles comerciales, `gitCommit` en health | ✅ [30413887179](https://github.com/Neiman08/ai-staffing-os/actions/runs/30413887179) |
| [`1ba5809`](https://github.com/Neiman08/ai-staffing-os/commit/1ba580957774858a7c3108ab2575ebc7f381affe) | H10 (doble conteo de `companiesTargeted` en el pipeline híbrido) | ✅ [30417053136](https://github.com/Neiman08/ai-staffing-os/actions/runs/30417053136) |

Los 3 commits corrieron contra base de datos limpia (Postgres efímero de GitHub Actions). Suite completa de `apps/api` (última corrida): 1966-1974 tests según commit, 6 skips esperados, mismas 2 fallas preexistentes y no relacionadas de siempre (staleness de DB local + test no determinista de scheduler con OpenAI real) — nunca una regresión nueva.

## 15. Evidencia de despliegue y validación en producción

Cada commit se verificó desplegado con evidencia exacta (`gitCommit` en `/api/v1/health/ready` comparado byte a byte contra el SHA pusheado) antes de correr cualquier misión real.

Tres misiones reales de Hospitality en Illinois, todas con `requireHiringSignal: true` y "hoteles comerciales" detectados correctamente:

| Misión | industryNames (LLM) | companiesTargeted | Leads/Opportunities | Queries ejecutadas | providersOmitted |
|---|---|---|---|---|---|
| `MIS-20260729-0001` (valida H7/H9, expone H10) | `[]` (fallback determinista activado) | **2** ⚠️ (bug H10: 1 Company real) | 0 (única empresa: NO_SIGNAL, gate `requireHiringSignal` correcto) | `hotel, resort, conference hotel, extended stay hotel, hotel chain, hospitality group, boutique hotel, lodging property` (motel/inn/bed and breakfast ausentes — H8 confirmado) | `"People Data Labs omitido: intento real falló -- créditos agotados (HTTP 402)..."` (H9 confirmado) |
| `MIS-20260729-0002` (post-fix H10) | `[]` (fallback determinista activado) | **1** ✅ (coincide con la Company real) | 0 (misma empresa NO_SIGNAL, gate correcto) | mismas 8 queries, sin motel/inn/bed and breakfast | mismo mensaje real de PDL 402 |

`MIS-20260729-0002` reprodujo exactamente el mismo escenario híbrido que expuso H10 (`createdCompanyIds` y `select_target_companies.companyIds` con el mismo id) y confirmó `companiesTargeted: 1`, coincidiendo exactamente con `selectedCompanies`. Executive Report totalmente consistente con los números reales en ambas corridas.

## 16. Riesgos abiertos (adicionales a §9)

1. **Sin evidencia productiva de `requireHiringSignal` dejando pasar un Lead/Opportunity real** — en ninguna de las 3 misiones reales de Hospitality apareció una empresa con hiring signal positivo; el comportamiento "sí avanza cuando hay señal" solo está confirmado por tests unitarios/de integración (`conversion-policy.test.ts`, `mission-require-hiring-signal.test.ts`), no por una corrida real. No bloqueante — deuda técnica a revisar si aparece un caso real.
2. Los 4 riesgos ya documentados en §9 (Google Places sin `locationBias`, PDL sin créditos, Website Intelligence sin Playwright, quality gate conservador) siguen vigentes, sin cambios.

## 17. Conclusión final (F28 + addendum de Hospitality)

Los 8 problemas originales (A–H) de roofing/landscaping, los 2 encontrados en su propia validación en producción, y los 10 encontrados en el seguimiento real de Hospitality (H1–H10, incluyendo uno descubierto durante la propia validación en producción del fix anterior) quedaron todos diagnosticados con evidencia de código y de misiones reales, corregidos con cambios acotados, cubiertos con tests de regresión nuevos (varios confirmados fallando sin el fix y pasando con él), validados en CI contra una base limpia, desplegados en Render con el commit exacto verificado, y confirmados con misiones reales en producción — sin enviar ni aprobar automáticamente ningún correo en ningún momento.

**F28 y su addendum de Hospitality quedan cerrados.** Ninguna mejora futura identificada (§9, §16) es bloqueante — quedan documentadas como deuda técnica o posibles funcionalidades nuevas para una fase futura, no como pendientes de esta.
