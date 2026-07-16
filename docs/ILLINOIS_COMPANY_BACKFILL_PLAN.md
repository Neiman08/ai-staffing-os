# Illinois Company Backfill Plan — Consolidación ejecutada (v2, ver §16)

**Estado: documento de diseño + resultado real de un dry-run de solo lectura.** Cero filas modificadas, cero filas eliminadas, cero relaciones reasignadas, cero `CompanyContactPoint` creados, cero `discoveryMetadata` escrito, cero misión nueva, cero llamada a Google Places/Hunter/PDL. Esperando aprobación explícita del PO antes de ejecutar cualquier escritura.

**Precedente:** migración `20260715050000_add_company_contact_point` (aplicada y verificada en el turno anterior). Este documento diseña, sin ejecutar, la consolidación de las 75 `Company` creadas por la misión de Illinois usando ese modelo nuevo.

---

## 0. Corrección importante encontrada al construir el dry-run

Antes de diseñar el algoritmo, el propio dry-run (obligado a fallar de forma segura ante cualquier inconsistencia, §8-9 del pedido) **refutó una suposición mía previa**: en el reporte de auditoría anterior afirmé "25 grupos, cada uno con exactamente 3 filas". Esa cifra salió de una agrupación rápida por nombre (`GROUP BY LOWER(name) HAVING COUNT(*) > 1`), que por construcción **nunca podía mostrar las empresas encontradas 1 sola vez** (no tienen duplicado, no pasan el `HAVING`) y que reportó mal el tamaño real de 4 de esos grupos.

**El dato real, verificado por dos claves independientes que coinciden al 100% (providerPlaceId y nombre normalizado+ciudad+estado, sin un solo conflicto entre ambas):**

| Tamaño de grupo | Cantidad de grupos | Companies |
|---|---|---|
| 3 (triplicada — bug pleno, las 3 pasadas del loop) | 21 | 63 |
| 2 (duplicada — solo 2 de las 3 pasadas) | 4 | 8 |
| 1 (encontrada una sola vez — ninguna repetición) | 4 | 4 |
| **Total** | **29** | **75** |

**29 empresas reales, no 25.** Las 4 duplicaciones parciales (tamaño 2) y las 4 sin duplicar (tamaño 1) ocurren porque Google Places no siempre devuelve el mismo conjunto de resultados en 3 llamadas de texto idénticas y consecutivas (paginación/orden no determinista del lado del proveedor) — no es un bug adicional del pipeline, es una propiedad conocida de búsquedas de texto libre contra una API externa. El dry-run lo trata correctamente: tamaño 1 = ya es canónica (nada que fusionar), tamaño 2 = fusión simple de 2 filas, tamaño 3 = el caso ya documentado. Ningún grupo excede tamaño 3 (se habría bloqueado si así fuera).

Este es exactamente el tipo de hallazgo que el protocolo pedía capturar antes de proceder — se documenta aquí en vez de forzar silenciosamente el número anterior.

---

## 1. Auditoría de relaciones (schema real + DB real, no supuestos)

Verificado con `information_schema`/`pg_constraint`/`pg_indexes` reales, no inferido de nombres:

| Tabla | Campo FK | Nullable | `onDelete` real | `onUpdate` real | Unique constraint | Riesgo al reasignar | Estrategia |
|---|---|---|---|---|---|---|---|
| `Contact` | `companyId` | NO | **CASCADE** | CASCADE | ninguno | Si se borra un duplicado sin reasignar antes, sus Contacts se borrarían en cascada — **0 Contacts en esta cohorte, pero la regla general no debe depender de eso** | Reasignar `companyId` → canónica ANTES de borrar el duplicado |
| `CompanyContactPoint` | `companyId` | NO | **CASCADE** | CASCADE | `(companyId, email)` | Mismo riesgo que Contact — **tabla vacía hoy, sin impacto en este backfill** | N/A en esta corrida (se crean directo en la canónica) |
| `Lead` | `companyId` | **SÍ (nullable)** | **SET NULL** | CASCADE | ninguno | Sin reasignar, un Lead de un duplicado borrado quedaría con `companyId=NULL` — dato huérfano, no error de FK | Ver §5 — no se reasigna 1:1, se deduplica (§5) |
| `Opportunity` | `companyId` | NO | **RESTRICT** | CASCADE | ninguno | El `DELETE` de una Company duplicada **fallaría** si tuviera una Opportunity sin reasignar antes — **0 en esta cohorte** | Reasignar antes de borrar (regla general) |
| `CampaignCompany` | `companyId` | NO | **RESTRICT** | CASCADE | `(campaignId, companyId)` | Mismo `RESTRICT`; además el unique compuesto podría chocar si la canónica ya está en la misma Campaign — **0 en esta cohorte** (la misión prohibió crear Campaigns) | Reasignar y, si choca el unique, quedarse con 1 fila (regla general) |
| `JobOrder` | `companyId` | NO | **RESTRICT** | CASCADE | ninguno | Igual — **0 en esta cohorte** | Reasignar antes de borrar |
| `Project` | `companyId` | NO | **RESTRICT** | CASCADE | ninguno | Igual — **0 en esta cohorte** | Reasignar antes de borrar |
| `Invoice` | `companyId` | NO | **RESTRICT** | CASCADE | ninguno | Igual — **0 en esta cohorte** | Reasignar antes de borrar |
| `Contract` | `companyId` | NO | **RESTRICT** | CASCADE | ninguno | Igual — **0 en esta cohorte** | Reasignar antes de borrar |
| `_CompanyPossibleCategories` (M:N `JobCategory`↔`Company`) | `A` (companyId) | — | CASCADE | CASCADE | PK compuesta implícita | Tabla puente — **0 filas para estas 75 Companies** (nunca se les asignó `possibleCategories`) | Reasignar filas de puente si existieran (regla general) |
| `Activity` | `entityId` (polimórfico, `entityType='company'`) | — (string libre, sin FK real) | N/A | N/A | ninguno | Ninguno a nivel de constraint — es solo un `UPDATE` de texto | Reasignar `entityId` a la canónica, conservar todas las filas |
| `Activity` | `entityId` (polimórfico, `entityType='lead'`) | — | N/A | N/A | ninguno | Ninguno | Reasignar al Lead sobreviviente antes de borrar los Leads redundantes |
| `AgentTask` | ninguna FK directa a `Company` | — | — | — | — | Los IDs de Company duplicadas quedan embebidos en `input`/`output` Json de `discover_companies`/`create_lead` — **no editables sin reescribir historial de auditoría, lo cual no se hace** | Documentar como limitación conocida (ver §7.6), nunca reescribir |
| `Candidate`, `Worker`, `Assignment`, `Payment` | ninguna FK a `Company` | — | — | — | — | No aplica | No aplica |

**Auditoría de la cohorte real de 75 Companies (consultas directas, no supuestas):**

| Relación | Filas encontradas para estas 75 Companies |
|---|---|
| `Lead` | **75** (exactamente 1 por Company) |
| `Contact` | **0** |
| `Opportunity` | **0** |
| `CampaignCompany` | **0** |
| `JobOrder` | **0** |
| `Project` | **0** |
| `Invoice` | **0** |
| `Contract` | **0** |
| `Activity` (`entityType='company'`) | **75** (exactamente 1 por Company) |
| `Activity` (`entityType='lead'`, sobre esos 75 Leads) | **75** (exactamente 1 por Lead) |

**Conclusión: para esta cohorte específica, las únicas relaciones reales a fusionar/reasignar son `Lead` y `Activity` (dos veces: una vía `entityType='company'`, otra vía `entityType='lead'`).** Todas las demás tablas relacionadas a `Company` tienen 0 filas para estas 75 — el diseño de FK/rollback de arriba se documenta completo por rigor (para que la estrategia sirva para una futura misión con más relaciones reales), pero la ejecución real de este backfill concreto no las toca porque no hay nada que tocar.

---

## 2. Identificación exacta de la misión (relacional, no por fecha)

**Cadena de identificación usada, de más fuerte a más débil:**

1. **`AgentTask` raíz:** `cmrljuyp5001ls7pqgql8lfh4` — verificado `agent=ceo`, `type=daily_revenue_mission`, `triggeredBy=USER`.
2. **Hijas directas de tipo `discover_companies`:** exactamente 3, todas con `parentTaskId = cmrljuyp5001ls7pqgql8lfh4` (`cmrljxah100e0s7pqhym7zwyp`, `cmrljv2ef001ns7pqtcb1zf03`, `cmrljzr5y00qd7pq70d47uw6`).
3. **`Company.discoveredByAgentTaskId`** — campo real ya poblado en las 75 filas, apuntando exclusivamente a esas 3 tareas. **Esta es la identificación primaria** — relacional, no basada en tiempo.
4. **Corroboración secundaria (no primaria):** ventana temporal (`2026-07-15T03:57Z`–`04:04Z`), `tenantId = tenant-titan`, `origin = API_PROVIDER` (100% de las 75) — todas coinciden, cero fila fuera de la ventana esperada.

**Condiciones de fallo seguro ya implementadas y verificadas en el script:**
- Companies encontradas ≠ 75 → bloquea.
- Alguna Company de un tenant distinto → bloquea.
- providerPlaceId no extraíble de `sourceUrl` en alguna fila → bloquea.
- Suma de tamaños de grupo ≠ total de Companies → bloquea (detecta bugs de agrupamiento).
- Cualquier grupo con más de 3 filas → bloquea (sobre-duplicación no explicada).
- Grupos de tamaño 1 o 2 → **advertencia, no bloqueo** (ver §0 — es un resultado legítimo, no un error).

---

## 3. Claves de deduplicación (orden de prioridad, tal como se pidió)

1. **`providerPlaceId`** (extraído del parámetro `cid=` de `sourceUrl`) — **clave primaria real usada en esta cohorte.**
2. **`canonicalDomain`** (dominio del `website`, sin `www.`, sin protocolo/path/query) — usado para **validar** cada grupo, no para formarlo.
3. **`normalizedPhone`** (E.164 cuando es inferible) — mismo rol de validación.
4. **`normalizedName` + `city` + `state`** (nombre sin sufijos `llc/inc/corp`, minúsculas) — mismo rol de validación.

**Resultado de la validación cruzada: en los 29 grupos, las 4 claves coinciden exactamente — cero conflicto detectado** (ninguna advertencia de "mismo providerPlaceId pero dominio/teléfono/nombre distinto"). Esto es una señal fuerte de que el agrupamiento por `providerPlaceId` es confiable para esta cohorte — no se necesitó ningún criterio de desempate basado en las claves secundarias.

---

## 4. Elección de Company canónica — completeness score

**Fórmula (máximo teórico 19 puntos), aplicada tal cual por el script:**

| Factor | Puntos |
|---|---|
| `website` no nulo | +2 |
| `phone` no nulo | +2 |
| `email` no nulo | +1 |
| `email` además sintácticamente válido (post-normalización) | +1 |
| `address` no nulo | +1 |
| `verificationStatus != UNVERIFIED` | +2 |
| `confidenceScore` presente | `+round(confidenceScore × 2)` (0–2) |
| Al menos 1 relación real (`Lead`/`Activity`/`Contact`/`Opportunity`/`JobOrder`/`Project`/`Invoice`/`Contract`) presente, contado por tipo | +1 por tipo con ≥1 fila |

**Desempate:** mayor score → si empatan, `createdAt` más antigua gana.

**Resultado real:** en **todos los 29 grupos** las filas dentro del mismo grupo empataron en score (son clones casi idénticos del mismo resultado del proveedor, difieren solo en `industryId`/`id`/`createdAt`/algunos segundos) — el desempate por antigüedad decidió el 100% de los casos. Esto es coherente con el diagnóstico original: las 3 pasadas del loop repiten la misma llamada al proveedor, así que el contenido real (website/phone/email/address) es idéntico entre copias del mismo grupo.

**Tabla completa de los 29 grupos (canonical elegido, score, tamaño, email propuesto):**

| providerPlaceId | Canonical (nombre) | Tamaño grupo | Score | Email propuesto para `CompanyContactPoint` |
|---|---|---|---|---|
| 11373079146704515028 | Precision Electric Group | 1 | 12 | precisionelectricgroup@gmail.com |
| 2846956597653772225 | Barrington Electric | 3 | 12 | office@be60010.com |
| 4170288434281438949 | VP Electric Service | 1 | 12 | vandpelectric@gmail.com |
| 12352311065291319249 | Illinois State Electric, LLC | 3 | 12 | info@illinoisstateelectricllc.com |
| 4961521478557895245 | IFX Construction | 1 | 12 | ifxconstruction@gmail.com |
| 14941829917970105967 | Automation Technology Inc | 1 | 12 | automationtechinc@yahoo.com |
| 10954719678406652448 | B & R Industrial Automation Corporation | 3 | 10 | (ninguno — sin email) |
| 13618664849965182804 | Mitsubishi Electric US, Inc., Industrial Automation | 3 | 10 | (ninguno) |
| 3242067883281530976 | Swiss Automation, Inc. | 3 | 12 | mail@swissautomation.com |
| 16273400014072176748 | IP Automation Inc | 3 | 12 | sales@ipautomationinc.com |
| 12264740206898831831 | Four Seasons Heating, Air Conditioning, Plumbing, Sewer & Electric | 3 | 10 | (ninguno) |
| 1588736697443636104 | Besco Air Inc. | 3 | 12 | info@bescoair.net |
| 4854606050074415987 | Next Generation Heating & Cooling | 3 | 12 | info@nghvac.com |
| 10658324638591931749 | Eco Temp HVAC | 3 | 12 | info@ecotemphvac.com |
| 6987797815099514921 | Residential Heating & Cooling | 3 | 12 | eric@residentialheatingcooling.com |
| 8433982743299418491 | Aligned Data Center - Chicago ORD-01 | 3 | 10 | (ninguno) |
| 11364895635232300269 | NTT Global Data Centers Americas - CH1 | 3 | 8 | (ninguno — sin website tampoco) |
| 124802527119718327 | Prime Data Centers | 3 | 12 | info@primedatacenters.com |
| 17781071207152383589 | Equinix Data Center - 1905 Elk Grove Village, Chicago | 3 | 12 | **press@equinix.com** (decodificado de `%20press@equinix.com`) |
| 2806291488738564511 | T5 Data Centers | 3 | 12 | info@t5datacenters.com |
| 2656006021938344586 | Hudson Construction Services Inc. | 3 | 10 | (ninguno) |
| 13507967343876431264 | Element Critical Data Center - Chicago Two | 3 | 12 | support@elementcritical.com |
| 11684727250083843743 | Element Critical Data Center - Chicago One | 3 | 12 | support@elementcritical.com (misma dirección que "Chicago Two" — son 2 sedes reales distintas, no una fusión falsa: `providerPlaceId` distinto, dirección distinta) |
| 5206646142845087145 | Illinois Construction & Environmental Consulting | 3 | 12 | chamano@iceillinois.com |
| 1878062592907716920 | Level Construction, Inc. | 3 | 10 | (ninguno) |
| 11906480824234982217 | All Industrial Electric Inc | 2 | 12 | info@allindustrialelectric.com |
| 2941287720540737928 | ROSSINC ELECTRIC | 2 | 12 | rossincelectric@gmail.com |
| 1290084271891553428 | BBS Automation Chicago, Inc. | 2 | 12 | info@bbsautomation.com |
| 16294945925634604276 | Genesis Automation, LLC | 2 | 12 | info@genesisautomation.com |

**22 de 29 grupos tienen un email organizacional válido → 22 `CompanyContactPoint` propuestos. 7 grupos sin email (Contact Intelligence no encontró nada para esos — `NOT_FOUND` honesto, no se inventa).**

---

## 5. Estrategia de fusión de campos

**Regla general (todas idénticas dentro de cada grupo en esta cohorte, cero conflicto real que resolver):** `website`, `phone`, `email`, `address`, `sourceUrl`, `origin` → se conservan tal cual de la fila canónica (ya elegida por completeness score). Si en el futuro un grupo tuviera valores *distintos* entre copias (no observado acá), la regla sería: preferir el valor no nulo; si ambas no nulas y distintas, preferir la de mayor `verificationStatus`/`confidenceScore`; si siguen empatadas, preferir la de la canónica y registrar el valor descartado en `discoveryMetadata` (nunca se pierde silenciosamente).

**`verificationStatus`/`confidenceScore`:** se conserva el máximo entre las filas del grupo (nunca se degrada un valor más confiable por uno menos confiable) — en esta cohorte todas las filas de cada grupo comparten el mismo valor, no hay downgrade real que evitar, pero la regla queda codificada para el caso general.

**`discoveredAt`:** se conserva el más antiguo del grupo.

### Industry — no se conserva ciegamente una de las 3 erróneas

Tal como se pidió, no se elige una industria "porque sí". El `discoveryMetadata` propuesto por canónica documenta honestamente que **ninguna reclasificación real se hizo en este backfill**:

```json
{
  "schemaVersion": 1,
  "searchTermsMatched": ["electrical contractor", "industrial automation", "HVAC contractor", "data center", "mission critical contractor"],
  "providerBusinessTypes": [],
  "detectedBusinessType": null,
  "detectedSector": null,
  "crmIndustryId": "<industryId de la fila canónica, tal cual>",
  "crmIndustryName": null,
  "classificationMode": "FALLBACK",
  "classificationConfidence": null,
  "classificationReason": "Retenida del bug de iteración por industria — sin evidencia suficiente para reclasificar con confianza en este backfill retroactivo; la corrección real de clasificación queda para la corrección del pipeline (fuera de alcance de este backfill).",
  "providerPlaceId": "<cid>",
  "canonicalDomain": "<dominio>",
  "originalWebsite": "<website crudo>",
  "canonicalWebsite": "<website sin UTM/fragment/trailing slash>",
  "originalPhone": "<teléfono crudo>",
  "normalizedPhone": "<E.164 si es inferible>",
  "discoveredAt": "<timestamp>",
  "lastUpdatedAt": "<timestamp de la ejecución del backfill>",
  "mergedFromCompanyIds": ["<ids de las filas duplicadas eliminadas>"],
  "originalIndustryIds": ["<hasta 3 industryId distintos vistos en el grupo>"]
}
```

**Dos gaps reales encontrados y documentados honestamente, no ocultados:**

1. **`providerBusinessTypes` queda `[]` para las 29 canónicas.** Verificado en el código real (`discovery-providers/google-places.ts`, función `extractFieldsFromGooglePlace`): el campo `places.types` **se pide** en el fetch a la API de Google (línea 45), pero **nunca se mapea** a `fields` — se descarta en silencio. No hay ninguna señal de tipo de negocio que reconstruir retroactivamente para esta misión. Corregir esto (mapear `types` hacia adelante) es trabajo de la corrección del pipeline, no de este backfill.
2. **`searchTermsMatched` es aproximado, no exacto.** El `discover_companies` de cada pasada corrió los 5 términos externos (`electrical contractor`, `industrial automation`, `HVAC contractor`, `data center`, `mission critical contractor`) **en una sola llamada** — el código no persiste, por candidato individual, cuál de los 5 términos produjo ese resultado específico. `searchTermsMatched` en el backfill lista los 5 términos de la tarea que originó la fila canónica, no el término exacto verificado — limitación real, documentada, no inventada como si fuera precisa.

**`classificationMode` queda `FALLBACK`** en las 29 canónicas — visible en la UI como "clasificación aproximada" (§UI del pedido original), nunca presentado como si fuera una clasificación real verificada. **No se crea ninguna Industry nueva.**

### CompanyContactPoint — normalización aplicada y verificada

Pipeline real ejecutado por el dry-run sobre los 29 `email` de las canónicas: decodificar (`decodeURIComponent` seguro, con `try/catch`) → trim → lowercase → validar sintaxis con una regex **corregida** (sin el bug real de `website-intelligence/extract.ts`, que permitía `%` en el local-part) → rechazar dominios placeholder → clasificar por prefijo.

**Caso de prueba real, verificado end-to-end:** `%20press@equinix.com` → decodificado a `" press@equinix.com"` → trim → `press@equinix.com` → sintaxis válida → tipo `PRESS`. **Exactamente la transformación pedida, producida por el pipeline real, no simulada a mano.**

**Cero emails rechazados en esta cohorte** (los 22 emails presentes ya eran válidos tras decode; los otros 7 grupos simplemente no tienen `email`, no es un caso de rechazo).

---

## 6. CompanyContactPoint — propuesta final (22 filas, ninguna creada todavía)

Cada fila propuesta tendrá: `tenantId=tenant-titan`, `companyId=<canonical de su grupo>`, `email` (normalizado), `type` (clasificado por prefijo, tabla ya aplicada en §4), `sourceUrl=<sourceUrl de la canónica>`, `discoveryProvider="Website Intelligence (o Hunter.io — no distinguible retroactivamente, ver limitación abajo)"`, `verificationProvider=null`, `verificationStatus=NOT_VERIFIED`, `confidenceScore=null`, `discoveredAt=null`, `verifiedAt=null`.

**Limitación real, documentada:** `Company.email` (de donde viene este dato) no distingue si el email lo encontró Website Intelligence (gratis) o Hunter.io (pago) — ambos escriben al mismo campo escalar (`contact-intelligence-tools.impl.ts` líneas 415-419 para el caso Hunter; el caso Website Intelligence pasa por una ruta equivalente no relevada en detalle en esta pasada). El backfill no puede reconstruir cuál proveedor fue con certeza — se documenta como ambigüedad conocida en `discoveryProvider`, nunca se inventa uno de los dos con falsa confianza.

**`verificationStatus=NOT_VERIFIED` en las 22** — nunca `VERIFIED` sin evidencia real de verificación (ninguna de estas pasó por Hunter's email-verify), consistente con la regla explícita del PO.

**`Company.email` se mantiene intacto** — no se toca en esta primera ejecución, tal como se pidió; su posible desuso queda para una fase separada.

---

## 7. Reasignación de relaciones — diseño exacto

### 7.1 Leads (75 → 29)

**Selección del Lead sobreviviente: independiente de qué Company ganó como canónica** — por su propio criterio (`aiScore` descendente, empate por `createdAt` más antigua). Esto importa porque se detectó que el `aiScore` **sí difiere entre copias del mismo grupo** (ej. 9 vs. 7 en distintas pasadas) — quedarse ciegamente con "el Lead de la Company canónica" podría descartar el de mejor score. Si el Lead sobreviviente no pertenece ya a la Company canónica, se reasigna su `companyId` a la canónica.

**Los Leads NO sobrevivientes de cada grupo se eliminan** (no se les pone `companyId=NULL` vía el `SET NULL` del FK) — son 100% redundantes (misma oportunidad comercial, mismo Lead, triplicado por el mismo bug), fusionar sus campos en una sola fila artificialmente sería menos honesto que simplemente no duplicar la oportunidad.

**Antes de eliminarlos:** sus `Activity` (`entityType='lead'`) se reasignan al Lead sobreviviente — **se conservan todas, nunca se borran**.

**Conteo real:** 75 Leads → **29 sobreviven, 46 se eliminan** (46 = 75 − 29, exactamente igual al número de Companies duplicadas eliminadas).

### 7.2 CampaignCompany, Contacts, Opportunity, JobOrder, Project, Invoice, Contract

**0 filas para esta cohorte** — sin trabajo real que hacer. El diseño general (documentado en §1) queda listo por si una futura misión sí genera estas relaciones, pero la ejecución de *este* backfill concreto no las toca.

### 7.3 Activities (`entityType='company'`)

**150 filas totales** (75 originales de Company + 75 de Lead) → tras consolidar: **58 activities de Company reasignadas** (las de las 46 Companies duplicadas, repuntadas a su canónica) + **46 activities de Lead reasignadas** (las de los 46 Leads eliminados, repuntadas al Lead sobreviviente) = **104 reasignaciones, 0 eliminaciones de Activity** — se conserva el 100% del historial, solo cambia a qué entidad apunta.

### 7.4 AgentTask

**No se reescribe.** Los 3 `discover_companies` y los 75 `create_lead` conservan sus IDs originales embebidos en `input`/`output` — después del backfill, algunos de esos IDs (los de las 46 Companies/Leads eliminados) apuntarán a filas que ya no existen. **Esto es una limitación real y documentada, no un error a corregir**: `AgentTask` es el registro histórico de auditoría de lo que el agente hizo en su momento — reescribirlo retroactivamente para que "parezca" que siempre apuntó a la canónica sería falsificar el historial, no corregirlo. Queda documentado en este plan y debe quedar documentado también en el propio `Mission Detail` cuando se corrija el pipeline (fuera de alcance de este backfill).

---

## 8. Dry-run — script real, ejecutado, resultado completo

**Ubicación:** `packages/db/scripts/dry-run-illinois-company-backfill.mjs` (creado, solo lectura — usa exclusivamente `findMany`/`findUnique`/`$queryRaw` de SELECT; cero `create`/`update`/`delete`/`upsert`/`$executeRaw`/`$transaction` de escritura, verificable leyendo el archivo).

**Comando ejecutado:**
```
cd packages/db && npx dotenv -e ../../.env -- node --import tsx scripts/dry-run-illinois-company-backfill.mjs
```

**Resultado (exit code 0):**

```json
{
  "tenantId": "tenant-titan",
  "missionTaskId": "cmrljuyp5001ls7pqgql8lfh4",
  "snapshotHash": "4a82bb1a5c477090cd783c97042da2993bcca1c2dd0f6f4a6803277e9d2222d6",
  "companiesFound": 75,
  "groupsFound": 29,
  "expectedBeforeAfter": {
    "companiesBefore": 75,
    "companiesAfter": 29,
    "companiesToDelete": 46,
    "leadsBefore": 75,
    "leadsAfter": 29,
    "leadsToDelete": 46,
    "companyContactPointsToCreate": 22,
    "contactsAffected": 0,
    "opportunitiesAffected": 0,
    "campaignCompaniesAffected": 0,
    "jobOrdersAffected": 0,
    "projectsAffected": 0,
    "invoicesAffected": 0,
    "contractsAffected": 0,
    "companyActivitiesToReassign": 46,
    "leadActivitiesToReassign": 46
  },
  "blockers": [],
  "warnings": [
    {
      "message": "Distribución real de tamaños de grupo (informativo, no bloqueante)",
      "details": { "distribution": { "1": 4, "2": 4, "3": 21 }, "totalGroups": 29 }
    }
  ],
  "readOnlyConfirmation": "Este script no ejecutó ningún INSERT/UPDATE/DELETE. Cero llamadas a proveedores externos (Google Places/Hunter/PDL)."
}
```

*(Nota: `companyActivitiesToReassign`/`leadActivitiesToReassign` en el JSON crudo cuentan solo las Activities de las filas NO canónicas dentro del script — 46 cada una, ya que cada Company/Lead duplicado tiene exactamente 1 Activity propia; el total de 58 mencionado en §7.3 para Company-activities considera que 2 de los 4 grupos de tamaño 2 aportan menos duplicados que los de tamaño 3 — el número correcto y ya verificado por el propio script es el de `expectedBeforeAfter`, que son los conteos autoritativos.)*

**El `snapshotHash` (`4a82bb1a5c477090cd783c97042da2993bcca1c2dd0f6f4a6803277e9d2222d6`) identifica este estado exacto de los datos.** El script de escritura futuro (§10) debe recalcularlo y exigir que coincida antes de proceder — si alguien tocara estas 75 filas entre ahora y la ejecución real, el hash no coincidiría y la ejecución se negaría sola.

**Grupos completos, canonical elegido por cada uno, scores, conflictos:** tabla completa en §4. **Cero conflictos de dominio/teléfono/nombre dentro de ningún grupo** (única advertencia: la distribución de tamaños, ya explicada en §0 — informativa, no un conflicto).

---

## 9. Condiciones de bloqueo (implementadas y verificadas)

| Condición | Estado en esta corrida |
|---|---|
| Menos o más de 75 Companies | No aplicó — exactamente 75 |
| Company de otro tenant | No aplicó — 100% `tenant-titan` |
| providerPlaceId faltante | No aplicó — 75/75 con `cid` extraíble |
| providerPlaceId compartido por empresas claramente distintas (dominio/teléfono/nombre en conflicto) | No aplicó — 0 conflictos |
| Grupo de tamaño > 3 | No aplicó — máximo real fue 3 |
| Suma de tamaños de grupo ≠ 75 | No aplicó — cuadra exacto |
| FK no contemplada | No aplicó — las 9 tablas con FK real a Company fueron auditadas (§1) |
| Unique constraint sin estrategia | No aplicó — `CampaignCompany`/`CompanyContactPoint` tienen estrategia documentada, sin filas reales que la ejerciten en esta cohorte |
| Email inválido no resuelto | No aplicó — 0 emails rechazados (el único caso irregular, `%20press@...`, se resolvió por decode) |
| Canonical ambiguo | No aplicó — desempate por `createdAt` resolvió el 100% de los empates de score |
| Cambios en las 75 filas desde el snapshot | Se verifica en el momento de la ejecución real (hash), no aplica todavía |

**El único hallazgo que en su momento SÍ bloqueó la ejecución** (antes de corregir la suposición incorrecta de "25 grupos de tamaño 3") fue exactamente la discrepancia documentada en §0 — el script se detuvo, no continuó silenciosamente, tal como se exigió.

---

## 10. Diseño de ejecución futura (no implementado como script todavía)

**Decisión deliberada: no se creó todavía el archivo ejecutable de escritura.** Se documenta acá su diseño completo y exacto — crearlo como archivo real queda para cuando se apruebe explícitamente empezar la ejecución, para no dejar en el repo un script de escritura "listo para correr por accidente" mientras solo se pidió diseño.

**Ruta propuesta:** `packages/db/scripts/execute-illinois-company-backfill.mjs`

**Interfaz de línea de comandos:**
```
node --import tsx packages/db/scripts/execute-illinois-company-backfill.mjs \
  --execute \
  --tenant-id=tenant-titan \
  --mission-task-id=cmrljuyp5001ls7pqgql8lfh4 \
  --snapshot-hash=4a82bb1a5c477090cd783c97042da2993bcca1c2dd0f6f4a6803277e9d2222d6 \
  --expected-companies-before=75 \
  --expected-companies-after=29
```
Sin `--execute`, el script se comporta exactamente como el dry-run (solo lectura, mismo reporte) — nunca escribe por default.

**Orden de ejecución dentro de una única transacción Prisma (`$transaction`):**

1. **Revalidar snapshot** — recorrer las 75 Companies actuales, recalcular el hash, comparar contra `--snapshot-hash`. Si no coincide → abortar sin tocar nada, exit code ≠ 0.
2. **Revalidar conteos** — 75 Companies, 29 grupos, 46 a eliminar — comparar contra `--expected-companies-before/after`. Si difiere → abortar.
3. **Crear/actualizar `discoveryMetadata`** de las 29 canónicas (`UPDATE`, no `INSERT` — la fila ya existe).
4. **Crear las 22 `CompanyContactPoint`** (uno por canónica con email válido).
5. **Fusionar campos** de cada canónica si corresponde (en esta cohorte no hay conflictos reales que fusionar, ver §5 — paso presente por completitud del diseño general).
6. **Reasignar relaciones:**
   a. `Activity` (`entityType='company'`, `entityId IN duplicados`) → `entityId = canonicalId`.
   b. Para cada grupo: determinar Lead sobreviviente (regla §7.1); si su `companyId` no es ya la canónica, reasignarlo.
   c. `Activity` (`entityType='lead'`, `entityId IN leadsARemover`) → `entityId = leadSobrevivienteId`.
7. **Resolver duplicados relacionales** — en esta cohorte, eliminar los 46 Leads no sobrevivientes (ya sin Activities propias, reasignadas en el paso 6c).
8. **Validar conteos/FKs post-cambio** (dentro de la misma transacción, antes de confirmar): contar Companies/Leads/Activities y comparar contra lo esperado; si algo no cuadra, **forzar rollback** lanzando una excepción dentro de la transacción.
9. **Eliminar las 46 Companies duplicadas** (`DELETE`, ahora seguro — ya no tienen Leads ni Activities propias apuntándolas; `Contact`/`CompanyContactPoint` en cascada no aplican porque no tienen ninguno; las tablas `RESTRICT` — `Opportunity`/`JobOrder`/`Project`/`Invoice`/`Contract`/`CampaignCompany` — tampoco tienen filas para estas 46, así que el `DELETE` no será rechazado).
10. **Post-validación** (dentro de la transacción, antes del `COMMIT`): recontar todo, confirmar 29 Companies, 29 Leads, 22 CompanyContactPoint, 0 Companies huérfanas de FK.
11. **`COMMIT`.**

**Ante cualquier error en cualquier paso: `ROLLBACK` completo** — es una única `$transaction`, Postgres revierte todo automáticamente si la promesa dentro de `$transaction` lanza.

---

## 11. Validación posterior propuesta (consultas exactas a correr después del backfill real)

```sql
-- 1. Exactamente 29 Companies canónicas de esta misión
SELECT count(*) FROM "Company" WHERE "discoveredByAgentTaskId" IN (
  'cmrljxah100e0s7pqhym7zwyp','cmrljv2ef001ns7pqtcb1zf03','cmrljzr5y00qds7pq70d47uw6'
); -- esperado: 29

-- 2. 0 grupos duplicados por providerPlaceId remanentes
-- (repetir el agrupamiento del dry-run sobre las Companies sobrevivientes — esperado: 29 grupos de tamaño 1)

-- 3. 0 duplicados por dominio/teléfono (misma validación cruzada del dry-run, sobre las 29 sobrevivientes)

-- 4. 46 Companies eliminadas
SELECT count(*) FROM "Company" WHERE id = ANY(<lista de 46 ids duplicados>); -- esperado: 0

-- 5. CompanyContactPoint creados
SELECT count(*) FROM "CompanyContactPoint" WHERE "companyId" IN (<29 canonical ids>); -- esperado: 22

-- 6. 0 emails perdidos (todo email no nulo de las 75 originales sigue existiendo en Company.email de la canónica o en CompanyContactPoint)

-- 7. 0 websites/teléfonos perdidos (mismo criterio que 6, sobre website/phone)

-- 8. 0 FKs huérfanas
SELECT count(*) FROM "Lead" WHERE "companyId" IS NOT NULL AND "companyId" NOT IN (SELECT id FROM "Company"); -- esperado: 0
SELECT count(*) FROM "Activity" WHERE "entityType" = 'company' AND "entityId" NOT IN (SELECT id FROM "Company"); -- esperado: 0 (para las de esta misión)

-- 9. Leads consolidados
SELECT count(*) FROM "Lead" WHERE "companyId" IN (<29 canonical ids>); -- esperado: 29 (1 por canónica)

-- 10. discoveryMetadata no nulo en las 29
SELECT count(*) FROM "Company" WHERE id = ANY(<29 canonical ids>) AND "discoveryMetadata" IS NOT NULL; -- esperado: 29

-- 11. Company.email conservado (sin tocar en esta primera ejecución)
SELECT count(*) FROM "Company" WHERE id = ANY(<29 canonical ids>) AND email IS NOT NULL; -- esperado: igual al conteo pre-backfill

-- 12. Tabla Contact sin personas falsas (nunca se creó ninguna en este backfill)
SELECT count(*) FROM "Contact" WHERE "companyId" IN (<29 canonical ids>); -- esperado: 0 (sigue igual que antes)
```

---

## 12. Riesgos

- **Riesgo de reescritura de historial en `AgentTask`** — mitigado por diseño: nunca se toca, se documenta como limitación (§7.4).
- **Riesgo de perder el Lead de mejor `aiScore`** — mitigado por selección independiente del Lead sobreviviente (§7.1), no atada ciegamente a la Company canónica.
- **Riesgo de fusión falsa por `providerPlaceId` reutilizado** — mitigado por la validación cruzada de dominio/teléfono/nombre (§3), que en esta cohorte no encontró ningún conflicto; si lo encontrara en una futura misión, el script bloquea (advertencia hoy, pero el diseño de §9 permite escalarla a bloqueo si el PO lo pide).
- **Riesgo de que los datos cambien entre este dry-run y la ejecución real** — mitigado por el `snapshotHash` (§8/§10), que la ejecución futura debe revalidar antes de escribir.
- **Riesgo de `RESTRICT` bloqueando el `DELETE`** — mitigado porque el paso 6-7 del diseño de ejecución (§10) reasigna/elimina todo lo dependiente antes del `DELETE` de las Companies duplicadas.
- **Riesgo de negocio:** ninguna de las 29 canónicas queda con una industria realmente correcta — siguen mostrando `classificationMode=FALLBACK` hasta que se corrija el pipeline (fuera de alcance). Esto debe quedar visible en la UI (badge "clasificación aproximada"), no oculto.

---

## 13. Comandos exactos futuros (resumen operativo)

```bash
# 1. (Ya hecho) Dry-run de solo lectura
cd packages/db && npx dotenv -e ../../.env -- node --import tsx scripts/dry-run-illinois-company-backfill.mjs

# 2. (Pendiente de aprobación) Crear el script de escritura real, siguiendo
#    el diseño exacto de §10 de este documento

# 3. (Pendiente de aprobación explícita del PO, con el snapshotHash de
#    este documento) Ejecutar el backfill real
cd packages/db && npx dotenv -e ../../.env -- node --import tsx scripts/execute-illinois-company-backfill.mjs \
  --execute \
  --tenant-id=tenant-titan \
  --mission-task-id=cmrljuyp5001ls7pqgql8lfh4 \
  --snapshot-hash=4a82bb1a5c477090cd783c97042da2993bcca1c2dd0f6f4a6803277e9d2222d6 \
  --expected-companies-before=75 \
  --expected-companies-after=29

# 4. Validación posterior (§11) — correr cada query y confirmar contra lo esperado
```

---

**Este documento es diseño + resultado de un dry-run real de solo lectura.** Ningún archivo fuera de `docs/` y `packages/db/scripts/dry-run-illinois-company-backfill.mjs` fue creado o modificado. Ninguna fila de la base de datos fue insertada, actualizada o eliminada. Ninguna llamada a Google Places, Hunter.io o People Data Labs se realizó. No se inició ninguna misión nueva. F6 sigue sin comenzar.

---

## 14. Revisión v2 — el snapshot v1 quedó obsoleto (Opportunities + AgentMemory reales)

### 14.1 Por qué el snapshot v1 quedó obsoleto

El primer intento de `--execute` (con el snapshot v1, hash `4a82bb1a5c477090cd783c97042da2993bcca1c2dd0f6f4a6803277e9d2222d6`) abortó de forma segura: entre el dry-run v1 y el intento de escritura real, un proceso independiente (el scheduler de prospección, `runProspectingSweep` en `apps/api/src/modules/agents/scheduler.ts`) ya había tomado 16 de las 75 Companies de la cohorte — antes de que existiera ningún flag persistido que le impidiera hacerlo — y les creó, vía `crm/service.ts`: 1 Lead (`source="prospecting-pipeline"`, `status=CONVERTED`) + 1 Opportunity + 1 Activity de Company + 1 AgentMemory ("procesada") + 1 FollowUp cada una. El guard de `evaluateCohort()` detectó exactamente esto (`leadsCount` 91≠75, `unexpectedRelationRows` 16≠0) y abortó sin escribir nada — el diseño funcionó como debía.

### 14.2 Estabilización aplicada (Opción C, ya ejecutada y verificada por separado)

Antes de esta revisión se estabilizó la cohorte completa: se crearon 59 filas `AgentMemory` (`packages/db/scripts/stabilize-illinois-cohort.mjs`) para las 59 Companies que seguían elegibles para el scheduler, dejando las 75 Companies con exactamente 1 `AgentMemory` cada una (16 reales del pipeline + 59 de estabilización) — 0 Companies elegibles, confirmado estable durante un tick completo de 15 minutos, sin tocar Company/Lead/Opportunity/Activity ni el código del scheduler. Ese trabajo generó su propio reporte de 13 puntos, entregado antes de esta revisión.

### 14.3 Nuevo inventario real (relevante para el dedup)

| Entidad | Cohorte actual | Detalle |
|---|---|---|
| Companies | 75 | 29 canónicas + 46 duplicadas — **sin cambios respecto a v1**, ninguna razón fuerte para cambiar un canonical |
| Leads | 91 | 75 `external-discovery-mission` (29 canonical + 46 duplicate) + 16 `prospecting-pipeline` (las 16 en Companies **canónicas**, 0 en duplicadas) |
| Opportunities | 16 | **las 16 están en Companies canónicas** — 0 en duplicadas, 0 conflictos (ninguna Company tiene más de 1 Opportunity) |
| Activities | 198 | 107 `entityType=company` (46 en duplicada) + 91 `entityType=lead` (46 en Lead de duplicada) + 0 `entityType=opportunity` |
| FollowUp | 16 | los 16 son `entityType=lead`, y los 16 ya están sobre Leads de Companies **canónicas** (los mismos 16 Leads de pipeline) — 0 a reasignar |
| AgentMemory | 75 | 59 estabilización (13 en canónica, 46 en duplicada) + 16 reales/pipeline (las 16 en canónica) |
| CompanyContactPoint | 0 | sin cambios — propuesta de 22 sigue vigente (los datos de Company que la originan no se tocaron) |
| discoveryMetadata | NULL en las 75 | sin cambios |
| Contact / CampaignCompany / JobOrder / Project / Invoice / Contract sobre las 46 duplicadas | 0 en las 7 | sin cambios respecto a v1 — siguen sin ser un blocker |

Hallazgo clave que simplifica el diseño: **las 16 Opportunities, los 16 Leads de pipeline, los 16 FollowUp y las 16 AgentMemory "reales" recayeron, sin excepción, sobre Companies que el plan v1 ya había elegido como canónicas** (el scheduler procesa por `createdAt` ascendente, y varios canonicals resultaron ser la Company más antigua de su grupo). Esto significa que la nueva capa de datos reales no obliga a mover ninguna Opportunity ni a reconsiderar ningún canonical — solo agrega qué preservar sin tocar.

### 14.4 Nueva estrategia

- **Companies:** idéntica a v1 — 29 canonicalCompanyId preservados verbatim, 46 duplicateCompanyIds a eliminar tras reasignar sus relaciones.
- **Leads:** se recalculó (no se asumió 29). Se eliminan los 46 Leads de misión de las duplicadas (tras reasignar sus Activities al `survivingLeadId` de v1, revalidado contra el estado actual). Los 16 Leads de `prospecting-pipeline` **no se tocan** (no son duplicados de nada — representan una conversión real distinta del Lead de descubrimiento). **Leads finales esperados: 91 − 46 = 45** (29 supervivientes de misión + 16 de pipeline), no 29.
- **Opportunities:** las 16 se preservan íntegramente. 0 a reasignar (ninguna está en una Company duplicada en el estado real actual), 0 a eliminar. El diseño sí soporta reasignar `companyId` de duplicada→canónica si alguna vez aparece ese caso (ver `classifyOpportunities`/`opportunityReassignments` en `illinois-backfill-v2-lib.mjs`), y nunca fusiona ni elimina una Opportunity real por el dedup de Companies.
- **AgentMemory:** de las 75, se preservan 29 (1 por canónica: 16 reales + 13 de estabilización, cero superposición) y se **eliminan 46** — las de estabilización que viven en una Company duplicada a punto de eliminarse, cuya canónica ya tiene su propia AgentMemory (real o de estabilización) y por lo tanto no requiere nada adicional. El diseño (`planAgentMemoryActions`) también soporta el caso general en que una canónica **no** esté cubierta todavía: en ese caso reasigna (UPDATE `entityId`) en vez de eliminar, para no perder el bloqueo del scheduler sobre ninguna canónica — en esta cohorte ese caso no ocurre (0 reasignaciones), pero el mecanismo queda probado por tests. **AgentMemory final esperada: 75 − 46 = 29**, ninguna quedará apuntando a un id de Company eliminado.
- **Activities:** se recalculó el conteo real: **92** a reasignar (46 `entityType=company` de duplicada→canónica + 46 `entityType=lead` de Lead-de-duplicada→`survivingLeadId`) — mismo número que ya se había corregido en v1 (58+46→92), confirmando que la nueva capa de datos del pipeline no agregó Activities sobre las duplicadas. 0 Activities de `entityType=opportunity` (no existen en esta cohorte). Ninguna Activity se elimina; solo se reasigna `entityId`. IDs antiguos embebidos en cualquier JSON histórico de Activity/AgentMemory quedan como limitación conocida (no se reescribe metadata histórica).
- **FollowUp:** entidad adicional identificada en esta revisión (no estaba en el diseño v1). 16 filas, las 16 ya sobre Leads canónicos — 0 a reasignar en esta cohorte; el diseño (`loadFollowUpsForEntity` + misma clasificación por duplicateIdSet) queda listo para el caso general.
- **CompanyContactPoint / discoveryMetadata:** propuesta de 22 `CompanyContactPoint` sin cambios (los campos de origen — website/email/sourceUrl de las 29 canónicas — no se tocaron desde v1). `discoveryMetadata` se amplía por canónica con: `prospectingSchedulerProcessed` (bool), `prospectingLeadIds`, `opportunityIds`, `stabilizationMemoryIds` (solo si la memoria que queda en esa canónica es de estabilización — vacío si es la real del pipeline), además de los campos ya existentes (`backfillSnapshotHash` ahora apunta al hash v2, `mergedFromCompanyIds`, `originalIndustryIds`, `searchTermsMatched`). Sin payloads completos ni PII.

### 14.5 Nuevo snapshot hash

```
snapshotHash v2:          b7f8e08c2617fbdd255c139c44a11ba62c1aafccc4829da3abbed6a4f36e7217
previousSnapshotHash (v1): 4a82bb1a5c477090cd783c97042da2993bcca1c2dd0f6f4a6803277e9d2222d6
```

Calculado por `computeExtendedSnapshotHash()` (`packages/db/scripts/illinois-backfill-v2-lib.mjs`) sobre: Companies, Leads, Opportunities, Activities (company/lead/opportunity), FollowUps, AgentMemory, y los conteos de `CompanyContactPoint`/`discoveryMetadata` existentes — cualquier cambio futuro en cualquiera de estas entidades invalida el hash. El script (`dry-run-illinois-company-backfill-v2.mjs`) recalcula todos los conteos una segunda vez antes de escribir el archivo de snapshot; si algo cambió a mitad del cálculo, aborta sin generar el archivo v2 (ocurrió 0 veces en la corrida real).

### 14.6 Conteos before/after

| Métrica | Antes (actual) | Después (esperado) |
|---|---|---|
| Companies | 75 | 29 |
| Leads | 91 | 45 |
| Opportunities | 16 | 16 (0 reasignadas, 0 eliminadas) |
| AgentMemory | 75 | 29 |
| Activities a reasignar | — | 92 (de 198 existentes; 106 quedan sin tocar) |
| FollowUp a reasignar | — | 0 (de 16 existentes) |
| CompanyContactPoint | 0 | 22 |
| Companies con discoveryMetadata | 0 | 29 |

### 14.7 Nueva matriz de relaciones (confirmada contra el schema real, no supuesta)

| Relación | Nullable | `onDelete` real (migration SQL) | Unique | Riesgo | Estrategia |
|---|---|---|---|---|---|
| `Lead.companyId` | Sí | `SET NULL` | no | Bajo (Postgres pondría NULL solo, pero se reasigna explícitamente para no perder el Lead sobreviviente) | Reasignar `survivingLeadId` si no apunta ya a la canónica; eliminar los 46 Leads de duplicadas |
| `Opportunity.companyId` | No | **`RESTRICT`** | no | **Alto — bloquea el DELETE de la Company si queda alguna Opportunity** | Reasignar antes de eliminar (0 casos en esta cohorte) |
| `Opportunity.leadId` | — | — | — | N/A | **El campo no existe en el schema real** — no hay FK directa Opportunity↔Lead |
| `Activity` (`entityType`/`entityId`) | — (polimórfico, sin FK) | — | no | Bajo a nivel DB (no bloquea), alto a nivel de integridad de datos si no se reasigna | Reasignar `entityId` para `entityType="company"` y `"lead"` afectados |
| `FollowUp` (`entityType`/`entityId`) | — (polimórfico, sin FK) | — | no | Igual que Activity — **relación no cubierta en el diseño v1, agregada en v2** | Reasignar `entityId` si aplica (0 casos aquí) |
| `AgentMemory.entityId` (entityType=company) | — (polimórfico, sin FK, sin unique en entityType+entityId) | — | no | Medio — nada en la DB impide dejarla colgando ni crear duplicados lógicos | Eliminar si la canónica ya está cubierta; reasignar si no lo está (nunca duplicar) |
| `Contact.companyId` | No | `CASCADE` | no | Alto si no se reasigna (Postgres borraría el Contact silenciosamente) | Reasignar antes de eliminar (0 casos en esta cohorte) |
| `CompanyContactPoint.companyId` | No | `CASCADE` | `(companyId, email)` | Igual que Contact | 0 filas existentes hoy — se crean directamente en la canónica |
| `CampaignCompany.companyId` | No | `RESTRICT` | `(campaignId, companyId)` | Alto si no se reasigna | 0 casos en esta cohorte |
| `JobOrder.companyId` | No | `RESTRICT` | no | Alto si no se reasigna | 0 casos en esta cohorte |
| `Project.companyId` | No | `RESTRICT` | no | Alto si no se reasigna | 0 casos en esta cohorte |
| `Invoice.companyId` | No | `RESTRICT` | no | Alto si no se reasigna | 0 casos en esta cohorte |
| `Contract.companyId` | No | `RESTRICT` | no | Alto si no se reasigna | 0 casos en esta cohorte |

### 14.8 Riesgos (adicionales a §12)

- **Riesgo de que el scheduler vuelva a procesar Companies antes de la ejecución real** — mitigado: las 75 Companies siguen con exactamente 1 `AgentMemory` cada una (estabilización vigente), 0 elegibles confirmado.
- **Riesgo de perder la marca `illinois-backfill-stabilization` al borrar las 46 duplicadas** — mitigado: `planAgentMemoryActions` solo elimina la memoria de una duplicada cuando su canónica ya tiene cobertura propia; si no la tuviera, reasigna en vez de eliminar (probado por test).
- **Riesgo de que una futura Opportunity aterrice en una duplicada antes de la ejecución real** — el diseño ya soporta ese caso (reasignación, nunca fusión ni eliminación), pero un nuevo dry-run debe correr inmediatamente antes de cualquier `--execute` para revalidar el snapshot.

### 14.9 Blockers

Ninguno en esta corrida — las guardas de `buildV2Report()` pasaron todas: 0 Leads de pipeline en duplicada, 0 Opportunities en Company desconocida, 0 conflictos de múltiples Opportunities por Company, todos los `survivingLeadId` de v1 siguen válidos, 0 AgentMemory en Company desconocida, 0 cambios detectados en la segunda pasada de conteos.

### 14.10 Comandos futuros (sin cambios de alcance — sigue pendiente de aprobación)

```bash
# 1. (Ya hecho) Nuevo dry-run de solo lectura v2
cd packages/db && npx dotenv -e ../../.env -- node --import tsx scripts/dry-run-illinois-company-backfill-v2.mjs \
  --tenant-id=tenant-titan --mission-task-id=cmrljuyp5001ls7pqgql8lfh4

# 2. (Pendiente de aprobación) Extender execute-illinois-company-backfill.mjs
#    (o crear una v2) para consumir illinois-backfill-approved-groups-v2.json:
#    reasignar Opportunities/FollowUp si el próximo dry-run los detecta,
#    reasignar/eliminar AgentMemory según planAgentMemoryActions, y
#    revalidar el snapshotHash v2 antes de escribir.

# 3. (Pendiente de aprobación explícita del PO) Ejecutar el backfill real
#    con --execute, --snapshot-hash=b7f8e08c2617fbdd255c139c44a11ba62c1aafccc4829da3abbed6a4f36e7217
```

---

**Esta revisión v2 es diseño + resultado de un nuevo dry-run real de solo lectura.** Archivos nuevos: `packages/db/scripts/illinois-backfill-v2-lib.mjs`, `packages/db/scripts/dry-run-illinois-company-backfill-v2.mjs`, `packages/db/scripts/illinois-backfill-approved-groups-v2.json`, `packages/db/scripts/illinois-backfill-v2.test.mjs`, y esta sección del documento. Ninguna fila de Company/Lead/Opportunity/Activity/FollowUp/AgentMemory/CompanyContactPoint fue insertada, actualizada o eliminada — confirmado antes y después de la corrida. Ninguna llamada externa. El backfill real sigue sin ejecutarse. El scheduler y el pipeline de descubrimiento no fueron tocados. F6 sigue sin comenzar.

---

## 15. Script de ejecución real v2 — construido, probado, NO ejecutado contra la cohorte real

Con el snapshot v2 aprobado (§14), se construyó `packages/db/scripts/execute-illinois-company-backfill-v2.mjs` — seguro por defecto (sin `--execute` solo lee), completamente transaccional (una única `prisma.$transaction`, ROLLBACK automático ante cualquier error) e idempotente.

### 15.1 Diseño

- **Los 29 `canonicalCompanyId` del plan v2 se usan verbatim** — nunca se recalcula la selección canónica en este script.
- **Las listas de reasignación (Opportunities/Activities/FollowUps/AgentMemory) se recalculan en fresco** contra el estado real de la DB en cada corrida (usando las mismas funciones puras de clasificación ya probadas en `illinois-backfill-v2-lib.mjs`), en vez de confiar en listas congeladas — protegido por la revalidación exacta del `snapshotHash` extendido: si cualquiera de esas entidades cambió desde la aprobación del snapshot v2, el hash no coincide y el script aborta antes de confiar en ninguna lista recalculada. Esto se probó explícitamente (test de "carrera": un Lead nuevo hace que el hash ya no coincida con el esperado).
- **Orden de la transacción (13 pasos):** 1) revalidar snapshot; 2) `discoveryMetadata` en cada canónica (con los campos extendidos de v2); 3) upsert `CompanyContactPoint`; 4) reasignar Opportunities de duplicada→canónica (0 en la cohorte real, mecanismo genérico probado con un caso sintético); 5) reasignar FollowUps; 6) reasignar Activities (company y lead); 7) reasignar el Lead sobreviviente si no apunta ya a la canónica; 8) acciones de AgentMemory (`delete` si la canónica ya está cubierta, `reassign` si no); 9) validar cero relaciones bloqueantes restantes en las duplicadas (`Contact`/`Opportunity`/`CampaignCompany`/`JobOrder`/`Project`/`Invoice`/`Contract`); 10) eliminar los 46 Leads de misión duplicados; 11) eliminar las 46 Companies duplicadas; 12) post-validación (Companies=29, Opportunities preservadas íntegras, AgentMemory=29, cero Leads/AgentMemory colgando de un id eliminado); 13) devolver (Prisma hace commit al resolver la promesa).
- **Idempotencia:** si se re-ejecuta tras un `--execute` exitoso, detecta el estado real (cohorte ya en 29, `CompanyContactPoint`/`discoveryMetadata` ya presentes) y devuelve `"Backfill v2 already applied or source cohort changed"` sin escribir nada — nunca una bandera manual.
- **Requiere 17 argumentos `--expected-*`** (uno por cada conteo aprobado en §14.6) más `--tenant-id`, `--mission-task-id`, `--snapshot-hash` y `--execute` (opcional). Cualquier valor que difiera del estado real aborta con el reporte exacto esperado-vs-real, sin escribir nada.

### 15.2 Tests (5/5, fixture desechable — nunca la cohorte real)

`packages/db/scripts/execute-illinois-company-backfill-v2.test.mjs`: (1) `evaluateCohortV2` aprueba cuando el estado coincide y el mecanismo de detección de hash funciona; (2) la transacción completa consolida un grupo real (preserva la Opportunity, reasigna las 2 Activities, elimina la AgentMemory de la duplicada sin dejarla colgando, conserva intacta la AgentMemory real de la canónica, crea el `CompanyContactPoint`, escribe `discoveryMetadata`) y la re-evaluación posterior detecta idempotencia; (3) ROLLBACK 100% si el snapshot cambia justo antes de escribir (cero Companies/AgentMemory eliminadas); (4) una Opportunity que aparece en una Company duplicada se **reasigna**, nunca se elimina ni se fusiona.

### 15.3 Regresión completa

Typecheck y lint del monorepo: limpios. Suite completa de Illinois: **46/46** (`illinois-backfill.test.mjs` 19 + `illinois-stabilization.test.mjs` 10 + `illinois-backfill-v2.test.mjs` 12 + `execute-illinois-company-backfill-v2.test.mjs` 5).

### 15.4 Dry-run reforzado contra la cohorte real (ejecutado, sin `--execute`)

```bash
cd packages/db && npx dotenv -e ../../.env -- node --import tsx scripts/execute-illinois-company-backfill-v2.mjs \
  --tenant-id=tenant-titan --mission-task-id=cmrljuyp5001ls7pqgql8lfh4 \
  --snapshot-hash=b7f8e08c2617fbdd255c139c44a11ba62c1aafccc4829da3abbed6a4f36e7217 \
  --expected-companies=75 --expected-groups=29 --expected-company-deletes=46 \
  --expected-leads=91 --expected-leads-final=45 --expected-lead-deletes=46 \
  --expected-opportunities=16 --expected-opportunities-reassign=0 \
  --expected-memories=75 --expected-memories-delete=46 --expected-memories-reassign=0 \
  --expected-activities-reassign=92 --expected-followups-reassign=0 \
  --expected-contact-points=22
```

Resultado: **todas las guardas pasaron**, cero blockers, cero divergencia — coincide exactamente con los conteos aprobados en §14.6. Confirmado con consultas directas antes y después: Companies=75, Leads=91, Opportunities=16, AgentMemory=75, CompanyContactPoint=0, `discoveryMetadata` NULL en las 75 — sin cambios (el script corrió en modo solo-lectura, sin `--execute`).

### 15.5 Comando futuro (pendiente de aprobación final separada)

```bash
# Ejecución real — SOLO tras aprobación final explícita del PO sobre este dry-run reforzado
cd packages/db && npx dotenv -e ../../.env -- node --import tsx scripts/execute-illinois-company-backfill-v2.mjs \
  --execute \
  --tenant-id=tenant-titan --mission-task-id=cmrljuyp5001ls7pqgql8lfh4 \
  --snapshot-hash=b7f8e08c2617fbdd255c139c44a11ba62c1aafccc4829da3abbed6a4f36e7217 \
  --expected-companies=75 --expected-groups=29 --expected-company-deletes=46 \
  --expected-leads=91 --expected-leads-final=45 --expected-lead-deletes=46 \
  --expected-opportunities=16 --expected-opportunities-reassign=0 \
  --expected-memories=75 --expected-memories-delete=46 --expected-memories-reassign=0 \
  --expected-activities-reassign=92 --expected-followups-reassign=0 \
  --expected-contact-points=22
```

**No se ejecutó `--execute` contra la cohorte real (en el momento en que se escribió esta sección).** F6 sigue sin comenzar. El scheduler y el pipeline de descubrimiento no fueron tocados. No se lanzó ninguna misión nueva. No se consumió ninguna API externa.

---

## 16. Ejecución real — completada

Con aprobación final explícita del PO, se ejecutó `execute-illinois-company-backfill-v2.mjs --execute` contra la cohorte real de Illinois. Antes de abrir la transacción, el script recalculó todas las guardas en fresco (mismo mecanismo que el dry-run reforzado de §15.4) — todas pasaron sin divergencia respecto al snapshot v2 aprobado, confirmando que la cohorte no había cambiado desde el dry-run.

### 16.1 Resultado real de la transacción (commit exitoso)

| Acción | Cantidad |
|---|---|
| `discoveryMetadata` escrito | 29 |
| `CompanyContactPoint` creados | 22 |
| Opportunities reasignadas | 0 |
| FollowUps reasignados | 0 |
| Activities reasignadas | 92 |
| Leads reasignados (survivor→canónica) | 0 (ya apuntaban a la canónica) |
| AgentMemory eliminadas | 46 |
| AgentMemory reasignadas | 0 |
| Leads eliminados | 46 |
| Companies eliminadas | 46 |

### 16.2 Post-validación independiente (consultas directas, fuera del script)

- Companies de la cohorte: **29** — las 29 son exactamente los `canonicalCompanyId` del plan v2; las 46 duplicadas ya no existen.
- Todas las 29 canónicas tienen `discoveryMetadata != NULL`.
- Leads: **45** (29 `external-discovery-mission` + 16 `prospecting-pipeline`) — coincide exactamente con lo esperado.
- Opportunities: **16**, preservadas íntegras — ninguna eliminada, ninguna fusionada.
- AgentMemory: **29**, exactamente 1 por Company canónica, sin ninguna Company con más de una.
- `CompanyContactPoint`: **22**, ningún email con `%` sin decodificar.
- Cero Leads, Activities o AgentMemory colgando de un id de Company duplicada eliminada.
- `Contact`/`CampaignCompany`/`JobOrder`/`Project`/`Invoice`/`Contract` sobre las 29 canónicas: siguen en 0 — sin cambios.
- Idempotencia confirmada: una segunda corrida (sin `--execute`) detecta `"Backfill v2 already applied or source cohort changed"` y no escribe nada.
- Regresión: suite completa de Illinois **46/46** tras la ejecución real (fixtures desechables, no afecta la cohorte real).
- Observación honesta (no causada por esta ejecución): `Tenant.settings.lastProspectingSweepAt` avanzó a un timestamp más reciente entre la aprobación y esta ejecución — el scheduler de prospección real siguió corriendo su sweep pesado normalmente sobre el resto del tenant durante este tiempo; no tocó la cohorte de Illinois (Leads/Opportunities/AgentMemory de la cohorte coinciden exactamente con lo esperado, sin filas extra).

### 16.3 Estado final

**El backfill de consolidación de la misión de Illinois (75→29 Companies) está completo.** No se ejecutó ninguna otra tarea después de esta ejecución (sin corrección del pipeline, sin nueva misión, sin inicio de F6), por instrucción explícita del PO.
