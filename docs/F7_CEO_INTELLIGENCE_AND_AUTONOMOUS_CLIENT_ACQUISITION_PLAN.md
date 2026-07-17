# F7 — CEO Intelligence & Autonomous Client Acquisition — Plan Técnico

**Estado: F7.0, F7.1, F7.2, F7.3 y F7.4 completos y aprobados. A la espera de aprobación del PO para F7.5.** Este documento entrega exactamente lo pedido por el PO para F7.0: auditoría, causas raíz, fallos reproducidos con datos reales, arquitectura propuesta, fases, cambios de schema candidatos, riesgos, proveedores, tests, decisiones necesarias. **Cero código funcional escrito. Cero llamada nueva a Google Places/PDL/Hunter/OpenAI/Gmail/Twilio/job boards. Cero commit** (se hace commit de este documento solamente si el PO lo autoriza explícitamente, igual que cualquier otro entregable de solo-documentación de este proyecto).

No reemplaza a `docs/F7_PLAN.md` — ese documento queda como auditoría histórica (la búsqueda de un plan de F7 ya aprobado, que no existía en ese momento). Este es el plan dedicado para el alcance que el PO aprobó después: CEO Intelligence & Autonomous Client Acquisition.

---

## 0. Resumen del problema (tal como lo planteó el PO)

El CEO Agent interpreta instrucciones de forma demasiado literal — depende de que el usuario nombre una de las 4 industrias exactas que existen hoy en el CRM (`Construction`, `Warehouse/Logistics`, `Manufacturing`, `General Labor`). Instrucciones perfectamente razonables ("hoteles que necesiten housekeeping", "hospitales que necesiten environmental services", "janitorial services", "food and beverage") no tienen ninguna industria real a la cual mapear, así que fallan — algunas explícitamente, otras en silencio. Este documento confirma esa hipótesis con evidencia real (código + datos), identifica gaps estructurales adicionales que el PO no había señalado explícitamente pero que el código revela, y propone una arquitectura de 10 capas para resolverlo sin parchear con más keywords sueltas.

---

## 1. Auditoría técnica — arquitectura real, archivo por archivo

### 1.1 `mission-orchestrator.ts` (861 líneas) — el pipeline real

Secuencia **fija y determinista**, nunca decidida por el LLM (comentario explícito en el código: *"el CEO Agent no decide qué tool llamar ni en qué orden"*):

```
interpretDailyDirective (LLM, síncrono, en launchMission)
  → por cada industryTarget (industries.length > 0 ? industries : [null]):
      → create_campaign (si allowCampaignCreation)
      → si useExternalDiscovery && state && industry:
          → discover_companies (Discovery Agent)
          → por cada Company nueva:
              → find_contacts (Contact Intelligence)
              → find_email (Contact Intelligence, ampliado F4.7)
      → select_target_companies (si hay campaña) | query directa a Company (si no hay campaña)
      → por cada Company:
          → score_company (si commercialScore == null)
          → create_lead (si no existe)
          → create_opportunity (si !useExternalDiscovery && allowOpportunityCreation)
          → [solo si !useExternalDiscovery] plan_sequence + personalize_message
  → closeMission (LLM, Executive Report)
```

**Hallazgo crítico #1 — el gate de industria es absoluto:**
```ts
if (interpreted.useExternalDiscovery && industries.length === 0) {
  await failMission(missionTaskId, `No se pudo interpretar ninguna industria real del CRM...`);
  return;
}
```
`industries` viene de `scopedDb.industry.findMany({ where: { name: { in: interpreted.industryNames } } })` — es decir, **solo cuenta si el LLM devolvió un nombre que coincide EXACTO con una de las 4 `Industry` rows reales del tenant.** No hay ningún nivel de "bucket más cercano" para sectores que no son ninguna de las 4 — Construction/Warehouse-Logistics/Manufacturing no tienen ningún parentesco semántico razonable con Hospitality, Healthcare, Food Service, o Janitorial.

**Hallazgo crítico #2 — sin industria real, no hay fallback:** si `useExternalDiscovery` es `false` (búsqueda "interna" del CRM) y `industries.length === 0`, el pipeline NO falla — sigue con `industryTargets = [null]`, y termina consultando `scopedDb.company.findMany({ where: { industryId: undefined, ... } })`, que devuelve compañías de CUALQUIER industria (el filtro se anula) o ninguna, dependiendo de otros filtros — un resultado silenciosamente incorrecto, no un error visible.

### 1.2 `interpretDailyDirective` (`packages/agents/src/tools/ceo-tools.ts` + `apps/api/.../ceo-tools.impl.ts`)

Único tool con LLM real del CEO Agent. El prompt (`ceo-tools.impl.ts` líneas 223-246):
- Lista las industrias/categorías reales del tenant y ordena "SOLO nombres de la lista de arriba — nunca inventes uno nuevo".
- Dice explícitamente: *"IMPORTANTE si vas a llenar externalSearchTerms: igual elegí acá la industria real más cercana de la lista de arriba (ej. 'Construction' para contratistas/trades de construcción)"* — **esta guía de "bucket más cercano" existe SOLO para Construction/trades**. No hay ninguna guía equivalente para mapear Hospitality→(¿cuál industria real?), Healthcare→(¿cuál?), Food Service/Restaurantes→(¿cuál?), Janitorial→(¿cuál?). El LLM, sin esa guía, legítimamente no tiene ninguna industria razonable a la cual mapear un hotel o una empresa de limpieza — y el propio prompt le pide explícitamente que en ese caso deje `industryNames` vacío y liste el término en `unrecognizedTerms`.
- Después de recibir la respuesta del LLM, hay un filtro de "defensa en profundidad" (`validIndustryNames = parsed.industryNames.filter((n) => realIndustryNames.has(n))`) que descarta cualquier industria inventada — correcto y necesario, pero significa que **aunque el LLM alucinara una industria plausible ("Hospitality"), igual se descartaría** porque no existe como fila real.
- `externalSearchTerms` (frases de búsqueda libres para Google Places) SÍ soporta texto arbitrario — este mecanismo ya es capaz de buscar "hotel" o "janitorial company" como frase libre. El problema no es ahí, es que el pipeline exige una industria real primero, incluso cuando el `externalSearchTerms` sería suficiente por sí solo para archivar algo bajo una categorización razonable.
- `missionRestrictions` se combina con un detector determinista de regex (`mission-restrictions.ts`) por AND lógico — este mecanismo YA funciona correctamente (ver evidencia real más abajo, §2) y es exactamente el patrón que el PO quiere replicar para las demás reglas no-negociables (determinismo manda sobre LLM).

### 1.3 `mission-restrictions.ts` (86 líneas) — el único ejemplo ya maduro de "reglas deterministas mandan sobre el LLM"

`detectMissionRestrictionsFromText` usa regex (español/inglés, con/sin acentos) para detectar "no crear campañas", "no outreach", etc., y `mergeMissionRestrictions` hace un AND lógico entre lo que dijo el LLM y lo que detectó el regex — **un flag solo puede volverse más restrictivo, nunca menos, sin importar qué diga el LLM.** Este es el patrón exacto que F7 debe replicar para exclusiones de negocio, restricciones de contacto, etc. — no hay que inventar el patrón, hay que generalizarlo.

### 1.4 Discovery Agent (`discovery-tools.impl.ts` + `discovery-providers/{google-places,overpass}.ts`)

- Google Places (`INDUSTRY_QUERY_PHRASES`) y Overpass (`OVERPASS_PATTERNS`) tienen, cada uno, **solo 3 entradas hardcodeadas** (`Manufacturing`, `Warehouse/Logistics`, `Construction`) — ninguna de las 2 sabe buscar "General Labor" tampoco. Overpass en particular **no soporta texto libre en absoluto** — solo tags OSM estructurados por el nombre exacto de industria; un `queryTerm` custom que no sea una de esas 3 industrias simplemente no aporta nada por ese proveedor (degradación silenciosa, documentada como tal en el código).
- Google Places SÍ acepta una `queryPhrase` de texto libre cuando `externalSearchTerms` trae algo — este es el mecanismo ya reutilizable para "hotel", "janitorial company", etc.
- **Dedup real hoy: `scopedDb.company.findFirst({ where: { name: { equals, mode: "insensitive" }, industryId } })`** — nombre exacto (insensible a mayúsculas) + misma industria. **No hay dedup por `providerPlaceId`, dominio canónico, ni teléfono normalizado** — el pedido explícito del PO ("deduplicar globalmente por Place ID, dominio, teléfono y nombre + ciudad", que además aparece LITERAL en 3 de las 8 instrucciones reales de misión ya ejecutadas, ver §2) no está implementado en absoluto en el pipeline en vivo.
- `Company.discoveryMetadata` (Json, ya en schema, shape completamente documentado en el comentario del modelo — `classificationMode`, `providerPlaceId`, `canonicalDomain`, `normalizedPhone`, etc.) **nunca se escribe desde `discover_companies`** — confirmado por grep: las únicas referencias reales a `discoveryMetadata` en todo el repo están en los scripts de backfill de Illinois (`packages/db/scripts/*.mjs`), un trabajo retroactivo y manual, no en el pipeline en vivo. El campo existe, el shape está diseñado, pero el pipeline en vivo no lo toca — la infraestructura de dedup/clasificación estructurada ya fue diseñada una vez (para el backfill) y nunca se conectó al flujo real de misiones.
- **No existe ningún paso de validación de tipo de negocio.** Una Company se crea directo desde el resultado crudo del proveedor (nombre + campos confirmados), sin ningún chequeo posterior de "¿esto es realmente un hotel/una fábrica/lo que se pidió?".

### 1.5 Contact Intelligence (`contact-intelligence-tools.impl.ts` + `website-intelligence/{crawler,extract}.ts` + `contact-providers/people-data-labs.ts` + `email-providers/hunter.ts` + `email-verification-providers/hunter.ts`)

- **`CompanyContactPoint` existe en `schema.prisma` (líneas 610-641), completamente diseñado** (tipo de punto de contacto, `sourceUrl`, `discoveryProvider`, `verificationStatus`, `confidenceScore`, dedup por `@@unique([companyId, email])`) — **pero tiene CERO referencias en todo `apps/api/src`** (confirmado por grep de `companyContactPoint`/`CompanyContactPoint` fuera de `schema.prisma`). El pipeline real de `find_email` escribe directamente a `Company.email` (un string plano, sin tipo, sin `verificationStatus`, sin `sourceUrl` estructurado) en vez de crear un `CompanyContactPoint`. Esto es exactamente el modelo que el PO pide crear en el punto 8 de su arquitectura objetivo — **ya existe, solo hay que conectarlo.**
- **`extractFromPage` (website-intelligence/extract.ts) no valida que un email extraído pertenezca al dominio que se está crawleando.** `isPlausibleEmail` solo descarta placeholders obvios (`example.com`, extensiones de archivo) — cualquier dirección de email en texto plano o `mailto:` de la página, sin importar su dominio, se agrega a `genericEmails`. `find_email` (contact-intelligence-tools.impl.ts línea 357-359) toma **el PRIMER elemento de `genericEmails`** y lo escribe a `Company.email` sin ningún chequeo de "¿el dominio de este email coincide con el dominio del sitio de esta empresa?".
- **Reproducido con datos reales (ver §2.3): `General Manufacturing, LLC` (website `generalmanufacturing.net`) tiene `Company.email = "editor@collegefencing360.com"`** — un dominio de un sitio de fencing universitario, evidentemente ajeno, capturado sin ninguna validación cruzada.
- `Contact.verificationStatus` para contactos de People Data Labs se marca `"CONFIRMED"` incondicionalmente (línea 256) apenas el proveedor devuelve un candidato con nombre+apellido y un título que mapea a un rol prioritario — no hay una verificación adicional de que el contacto siga vigente en la empresa.
- El detector determinista de título → `decisionRole` (`TITLE_TO_DECISION_ROLE`) es un vocabulario cerrado — cargos de hospitalidad ("Executive Housekeeper", "General Manager" de un hotel) no mapean a ningún rol conocido salvo "General Manager"→OWNER (keyword `"owner"` no matchea "general manager" en absoluto — de hecho `general manager` no está en ninguna keyword list, así que quedaría sin rol clasificado, `decisionRole: null`).

### 1.6 `provider-health.ts` (62 líneas)

Registro **en memoria del proceso** (`Map`), TTL de 15 minutos, clasifica HTTP 402→`CREDIT_EXHAUSTED`, 401/403→`UNAUTHORIZED`, 429/5xx→`UNAVAILABLE`. Correcto y ya funcionando (ver evidencia real §2: `"People Data Labs: CREDIT_EXHAUSTED"` aparece en `contactCoverage.providersOmitted` de 2 misiones reales). **Limitación real:** al ser en memoria del proceso, no sobrevive un restart del servidor ni se comparte entre instancias — aceptable para el volumen actual de un solo proceso, documentado como tal en otros lugares del proyecto (mismo patrón que el scheduler in-process).

### 1.7 Modelos reales de schema.prisma relevantes (confirmado por lectura directa)

- `Industry`: 4 filas reales (`Construction`, `Warehouse/Logistics`, `Manufacturing`, `General Labor`).
- `JobCategory`: 5 filas reales (`Journeyman Electrician`, `Apprentice Electrician`, `General Labor`, `Warehouse Worker`, `Forklift Operator`) — ninguna relacionada con hospitalidad/salud/alimentos/limpieza tampoco.
- `CompanyOrigin`: `DEMO_SEED | MANUAL | CSV_IMPORT | EXTERNAL_DISCOVERY | API_PROVIDER` — **8 Companies reales son `DEMO_SEED`, 73 son `API_PROVIDER`** (dato real, tenant-titan, verificado en esta auditoría).
- Ya existe un patrón de exclusión de `DEMO_SEED` en `crm/service.ts` (`excludeDemo` query param) y en `public/service.ts` (siempre excluido) — **pero NO en `mission-orchestrator.ts` ni en `campaign-tools.impl.ts`'s `selectTargetCompanies`**, ambos sin ningún filtro de `origin` en su query de candidatos. El patrón de exclusión ya existe en el código, simplemente no se reutilizó acá.
- `CompanyContactPoint`/`discoveryMetadata`: existen, diseñados, sin uso real (ver §1.4/§1.5).
- No existe ningún modelo de "hiring signal"/vacante detectada, ni de "taxonomía de negocio", ni de "plan de misión" estructurado más allá del `Json` libre de `AgentTask.input`/`.output` (que ya se usa para todo lo demás del proyecto, mismo patrón reutilizable).

---

## 2. Fallos reproducidos con datos reales (sin ninguna llamada nueva — solo lectura de `AgentTask`/`Company` ya existentes)

**8 Daily Revenue Missions reales existen en `tenant-titan` hoy.** Todas sus entradas/salidas fueron leídas directamente de la base — ninguna se volvió a ejecutar.

### 2.1 Manufacturing funciona (control positivo)

- `cmrmz5g3h...` — *"Busca 15 empresas nuevas en Illinois del sector Manufacturing..."* → `industryNames: ["Manufacturing"]`, `missionState: "COMPLETED"`, `companiesTargeted: 15`. ✅ funciona como se espera.
- `cmrjdelam...` (la misión "Iowa" original) — sectores mixtos (`Manufacturing`, `Warehouse/Logistics`, `Construction` + 5 `externalSearchTerms` libres para Data Centers/contratistas) → `COMPLETED`, `companiesTargeted: 25`. ✅ el mecanismo de `externalSearchTerms` + industria-bucket ya funciona para Construction/trades.

### 2.2 Hoteles y Janitorial fallan explícitamente (confirma la hipótesis del PO al pie de la letra)

- `cmrn1q1u3...` — *"Busca 20 hoteles nuevos en Illinois..."* → `industryNames: []`, `unrecognizedTerms: ["hoteles","Housekeeper","Room Attendant","Housekeeping","Laundry Attendant","Cleaning Staff"]`, `missionState: "FAILED"`, error: *"No se pudo interpretar ninguna industria real del CRM..."*.
- `cmrn1of0p...` — *"...sector Janitorial Services y Commercial Cleaning..."* → mismo patrón exacto, `industryNames: []`, `unrecognizedTerms: ["Janitorial Services","Commercial Cleaning"]`, `FAILED`.

### 2.3 Food & Beverage: "funciona" a medias, y termina COMPLETED con 0 resultados (el bug de estado incoherente, con datos reales)

- `cmrmz2cqg...` — *"Busca 15 fabricantes de alimentos y bebidas..."* → el LLM SÍ mapeó esto a `industryNames: ["Manufacturing"]` (razonable, sin que el prompt se lo indicara explícitamente para este caso) → pero `missionState: "COMPLETED"` con **`companiesTargeted: 0`**. La misión "tuvo éxito" sin encontrar una sola empresa nueva — indistinguible, en el estado final, de una misión que sí cumplió su objetivo.
- `cmrmyu6ca...` y `cmrmyno3l...` (fábricas con exclusiones de sector) — mismo patrón: `COMPLETED`, `companiesTargeted: 0`.
- **3 de las 8 misiones reales muestran exactamente este bug: `missionState: "COMPLETED"` con `companiesTargeted: 0`.** Esto confirma con datos reales el punto §10 del pedido del PO ("no marcar Completed si el objetivo no se cumplió" / necesidad de un estado `NO_RESULTS` distinto).

### 2.4 "Prioriza vacantes" nunca se ejecuta (confirmado estructuralmente + con datos reales)

Ninguna de las 8 misiones reales — a pesar de que varias piden explícitamente *"vacantes activas para Housekeeper..."*, *"ofertas activas de Production Worker, Machine Operator o Forklift Operator"* — tiene ningún campo de salida relacionado con vacantes/hiring signals. Términos como `"Production Worker"`, `"Machine Operator"` terminan en `unrecognizedTerms` (no son ni industrias ni categorías reales) y se descartan sin ningún efecto. **No existe, en ningún lugar del código real, una tool que inspeccione páginas de careers/jobs** — confirmado por grep exhaustivo de `mission-orchestrator.ts`, `discovery-tools.impl.ts`, `contact-intelligence-tools.impl.ts`, `website-intelligence/*`. Esto no es un bug de interpretación — es una capacidad que simplemente no existe todavía.

### 2.5 Contact Intelligence "se omite" — matizado con evidencia real

En las 2 misiones `FAILED` (hoteles, janitorial), Contact Intelligence nunca arranca porque el pipeline falla antes, en el gate de industria — correcto, no es un bug adicional. En la misión de food & beverage (`companiesTargeted: 0`), `contactCoverage.companiesConsidered: 0` — Contact Intelligence tampoco corrió, pero porque no había ninguna Company nueva sobre la cual correr (consecuencia del mismo bug de §2.3, no un fallo independiente de omisión).

### 2.6 Demo data como resultado — confirmado como riesgo estructural real, no reproducido en una misión concreta

Las 8 misiones reales usaron todas `useExternalDiscovery: true` (piloto F4.5A, siempre crea Companies nuevas). El código de la ruta "búsqueda interna" (`mission-orchestrator.ts` líneas 474-486, y `campaign-tools.impl.ts`'s `selectTargetCompanies`) no filtra por `origin`, y hoy existen 8 Companies reales `DEMO_SEED` en el tenant — así que una misión interna (`useExternalDiscovery: false`) sobre `Manufacturing`/`Construction`/etc. **podría** incluir demo data en sus resultados. No se reprodujo con una misión real porque ninguna de las 8 ejercitó ese camino — el gap es real (confirmado por lectura de código + conteo real de Companies por origen), la reproducción end-to-end queda pendiente para F7.11 (con una misión de prueba controlada, sin llamadas externas).

### 2.7 Emails con dominio incorrecto marcados sin ninguna distinción de confianza — reproducido con un ejemplo real, exactamente el que citó el PO

Consulta directa sobre las 48 Companies reales con `email` no nulo: **14 tienen un dominio de email que no coincide con el dominio de su propio website.** La mayoría son mismatches "aceptables" (negocios chicos que usan Gmail/Yahoo en vez de un dominio propio — normal, no un bug). Pero uno es exactamente el caso que el PO citó textual:

> `General Manufacturing, LLC` — website `generalmanufacturing.net` — `Company.email = "editor@collegefencing360.com"`

Un dominio de un sitio de fencing universitario, evidentemente ajeno a esta empresa de manufactura — capturado por `website-intelligence/extract.ts` sin ninguna verificación de que el email perteneciera al dominio crawleado, y persistido en `Company.email` sin ningún campo de `verificationStatus` que lo distinga de un email genuinamente confiable (`Company.email` es un string plano sin tipo de verificación — a diferencia de `Contact.emailVerificationStatus`, que sí existe).

### 2.8 Estado de misión incoherente — ya confirmado cuantitativamente en §2.3 (3 de 8 misiones reales)

---

## 3. Causas raíz (resumen, cada una con su evidencia de código/datos ya presentada arriba)

1. **Vocabulario de industria cerrado a 4 filas reales, sin capa de "bucket más cercano" generalizada** — solo existe para Construction/trades, no para el resto. → §1.1, §1.2, §2.2.
2. **Ningún concepto de "necesidad de personal"/hiring signal existe en el pipeline** — instrucciones basadas en vacantes se descartan silenciosamente. → §1.4 (ausencia total), §2.4.
3. **Dedup solo por nombre+industria exacto** — no por `providerPlaceId`/dominio/teléfono, a pesar de que el propio schema (`discoveryMetadata`) ya tiene el shape diseñado para esto desde el backfill de Illinois. → §1.4, §1.7.
4. **`CompanyContactPoint` diseñado y sin usar** — Contact Intelligence sigue escribiendo a `Company.email` (string plano, sin verificación tipada). → §1.5.
5. **Sin validación de dominio de email** — cualquier email de la página se acepta como si fuera de la empresa. → §1.5, §2.7.
6. **Sin validación de tipo de negocio** — una Company se crea del resultado crudo del proveedor sin ningún chequeo posterior de "¿esto es lo que se pidió?". → §1.4.
7. **Estado de misión no refleja si realmente se encontró algo** — `COMPLETED` con 0 resultados es indistinguible de un éxito real. → §2.3, §2.8.
8. **Sin filtro de `DEMO_SEED` en el camino de búsqueda interna de misiones/campañas** — a pesar de que el patrón de exclusión ya existe en otros módulos del proyecto. → §1.7, §2.6.
9. **Exclusiones de negocio ("excluye construcción, HVAC...") no son un concepto estructurado** — se mezclan con `unrecognizedTerms` sin ninguna garantía de que realmente se respeten como negativas. → §2.3 (misiones con "Excluye...").

---

## 4. Gaps mapeados 1:1 contra los 10 puntos de la arquitectura pedida por el PO

| # | Capa pedida | Estado hoy |
|---|---|---|
| 1 | Intent Understanding | 🟡 Parcial — `interpretDailyDirective` ya hace un LLM call estructurado, pero el schema de salida (§1.2) es mucho más angosto que el objeto pedido (falta `targetCompanyTypes`, `targetBusinessActivities`, `confidence`, `ambiguities`, `unsupportedCapabilities`, separación real de inclusion/exclusion). |
| 2 | Business Taxonomy | 🔴 No existe — 0 código, 0 modelo. Es la pieza central faltante (ver §5). |
| 3 | Mission Planner (plan explícito antes de ejecutar) | 🔴 No existe — el pipeline ejecuta paso a paso sin persistir un "plan" previo separado de la ejecución. |
| 4 | Dynamic Tool Orchestration | 🔴 No existe — la secuencia es fija en código (deliberadamente, por diseño de F4 — ver §1.1), nunca "decide" saltar un paso salvo por los flags de restricción ya existentes. |
| 5 | Discovery (dedup global, límite global, clasificación) | 🟡 Parcial — dedup local únicamente (§1.4), sin clasificación post-hoc. |
| 6 | Business Validation | 🔴 No existe. |
| 7 | Hiring Signal Intelligence | 🔴 No existe — 0 código. |
| 8 | Contact Intelligence (CompanyContactPoint real) | 🟡 Modelo listo, sin conectar (§1.5). |
| 9 | Email Validation (dominio, catch-all, placeholders) | 🟡 Parcial — placeholders sí, dominio no (§1.5, §2.7). |
| 10 | Mission State honesto | 🟡 Parcial — `PARTIAL` vs `COMPLETED` ya distingue cobertura de contacto (fix "misión Iowa"), pero no distingue "0 resultados" de "éxito" (§2.3). Faltan `BLOCKED`/`NO_RESULTS` como estados reales. |
| 11 | Executive Report (desglose completo) | 🔴 Reporte actual es un párrafo narrado por LLM con ~7 números — falta el desglose de 15+ categorías pedido (requested/planned/executed/raw/unique/accepted/rejected/etc.). |
| 12 | UI (Mission Detail) | 🔴 Muestra objectiveProgress/report/contactCoverage/missionState únicamente — falta interpretación, plan, queries, exclusiones, tools ejecutadas/omitidas, validación, hiring signals. |

---

## 5. Arquitectura propuesta (diseño, no implementación)

### 5.1 Business Taxonomy (la pieza que destraba todo lo demás)

**Decisión de diseño central de F7**, sujeta a aprobación explícita del PO antes de F7.2: una tabla de taxonomía **data-driven, versionada, en un solo lugar** (nunca dispersa en prompts o múltiples archivos, tal como exige el PO), con esta forma conceptual (nombre de modelo/campos a confirmar en F7.1, no en F7.0):

```
BusinessTaxonomyEntry {
  key                  // "hotel", "food_manufacturing", "janitorial", ...
  naturalLanguageTerms // ["hotel", "resort", "hospitality property", "hoteles", ...]
  crmIndustryBucket    // qué Industry real usar para archivar (o null si ninguna es razonable)
  searchPhrases        // frases de búsqueda reales para Google Places (texto libre, ya soportado)
  jobTitleSignals       // ["Housekeeper", "Room Attendant", ...] — para Hiring Signal Intelligence (§5.4)
  decisionRoleTitles    // ["General Manager", "Executive Housekeeper", "HR Manager", ...]
  exclusionTerms        // términos que NUNCA deben tratarse como searchTerm positivo para esta entrada
  version                // entero — cambios se versionan, nunca se pisan en silencio
}
```

Esto reemplaza — sin tocar `Industry`/`JobCategory` (F5/F6 territory, no se reabren) — la necesidad de que `industryNames` sea el único vector de clasificación. `crmIndustryBucket` sigue siendo `null` para Hospitality/Healthcare/Food Service/Janitorial en el corto plazo (no hay ninguna `Industry` real que las represente hoy, y crear una es una decisión de negocio de F5/F6 territory que NO se reabre acá) — el punto es que la Company **igual se puede descubrir, validar, buscar contactos, y reportar** sin depender de un bucket de industria real; el bucket, cuando exista, es solo metadata de archivo, nunca un gate que bloquea toda la misión (ver Hallazgo crítico #1 en §1.1 — ese gate es exactamente lo que hay que relajar).

**Decisión que el PO debe tomar (no la asume esta auditoría):** ¿la taxonomía vive en una tabla real de Postgres (versionada, editable sin deploy) o en un archivo `packages/shared`/`packages/agents` versionado por git (más simple, requiere deploy para cada sector nuevo)? Ver §9.

### 5.2 Intent Understanding (reemplaza/extiende `interpretDailyDirective`)

Mismo principio ya usado para `missionRestrictions` (§1.3): el LLM interpreta, un detector determinista revisa después, el resultado nunca puede ser más permisivo que ambas señales combinadas. El objeto de salida crece a lo que pidió el PO (`objectiveType`, `targetCompanyTypes`, `targetIndustries`, `targetBusinessActivities`, `targetJobTitles`, `targetHiringSignals`, `targetLocations`, `preferredCities`, `decisionRoles`, `inclusionCriteria`, `exclusionCriteria`, `requestedCompanyCount`, `enrichmentRequirements`, `requestedProviders`, `restrictions`, `reportingRequirements`, `confidence`, `ambiguities`, `unsupportedCapabilities`) — validado contra la Business Taxonomy (§5.1), nunca contra una lista fija de 4 nombres.

**Regla dura, ya pedida explícitamente por el PO y ausente hoy:** un término de `exclusionCriteria` nunca puede terminar siendo usado como `searchPhrase` positivo — esto requiere que el parser separe estructuralmente ambas listas desde el primer momento (hoy, `unrecognizedTerms` mezcla "no reconocido" con "excluido", ver §2.3 y §4 fila 1).

### 5.3 Mission Planner

Un objeto `MissionPlan` explícito, persistido en `AgentTask.input` (reutilizando el mismo campo `Json` que ya guarda todo lo demás — **sin cambio de schema**), generado ANTES de ejecutar cualquier tool: queries a correr, ciudades, sectores, orden, límites, condiciones de parada, estrategia de fallback, estrategia de enriquecimiento, restricciones aplicadas. La UI (§5.11) lo muestra tal cual, para que un humano vea "esto es lo que la IA va a hacer" antes/durante la ejecución — nunca soporta ejecución oculta.

### 5.4 Dynamic Tool Orchestration

**Tensión de diseño real a resolver con el PO, no asumida acá:** el pipeline de F4 es deliberadamente NO dinámico ("el CEO Agent no decide qué tool llamar ni en qué orden" — cita literal del código, principio central de F4). El PO ahora pide lo opuesto ("el CEO debe decidir dinámicamente si ejecutar discover/validate/inspect/..."). Esto es un cambio de principio arquitectónico, no un ajuste incremental — se resuelve, en el diseño propuesto, dejando que el **plan** (§5.3, generado una vez por el LLM + reglas deterministas) decida qué pasos corren, pero la **ejecución** del plan sigue siendo código determinista que solo hace lo que el plan ya declaró — nunca un LLM re-decidiendo en medio de la ejecución. Esto preserva el principio de auditabilidad de F4 (nunca un tool call que nadie pueda explicar de antemano) mientras cumple el pedido del PO (secuencia condicionada a la intención, no fija sin importar qué se pidió).

### 5.5 Discovery (dedup global + clasificación)

Extiende `discover_companies` para: (a) escribir `discoveryMetadata` en cada Company creada — el shape YA existe en el schema, esto es "conectar", no "diseñar desde cero"; (b) dedup en 4 niveles antes de crear (`providerPlaceId` → `canonicalDomain` → `normalizedPhone` → `normalizedName+city+state`), reusando exactamente la lógica ya escrita y probada en `packages/db/scripts/illinois-backfill-v2-lib.mjs` (funciones puras, no el script de backfill en sí — **no se reabre el backfill de Illinois, se reutiliza su lógica de dedup pura como referencia de diseño**, igual que cualquier otra función pura reutilizable del monorepo); (c) un límite global real por corrida de misión (ya existe `MAX_COMPANIES_PER_MISSION`, se mantiene).

### 5.6 Business Validation

Nuevo paso post-discovery: para cada Company recién creada, un chequeo (determinista donde sea posible — ej. tipo de negocio de Google Places `types[]` ya viene en la respuesta y hoy se ignora completamente, ver `google-places.ts`; LLM solo para los casos ambiguos que el chequeo determinista no resuelva) que produce `detectedBusinessType`, `evidence`, `confidence`, `accepted`/`rejected`, `rejectionReason` — persistido en `discoveryMetadata` (mismo campo, no un modelo nuevo).

### 5.7 Hiring Signal Intelligence

Nueva capacidad, hoy inexistente (§2.4). Reutiliza la infraestructura de `website-intelligence/crawler.ts` (ya sabe visitar `careers`/`jobs` paths — `isCareersPath` en `extract.ts` ya existe y **hoy no se usa para nada**, confirmado por grep — la detección de la URL ya está escrita, solo falta el paso que la consume) para inspeccionar la página de empleos real y buscar títulos relevantes de la Business Taxonomy (§5.1). Nunca inventa una vacante — si no puede verificarse, `NOT_FOUND` explícito (mismo principio ya usado en `find_email`).

### 5.8 Contact Intelligence real (conectar `CompanyContactPoint`)

`find_email` deja de escribir a `Company.email` (string plano) y empieza a crear `CompanyContactPoint` (modelo ya existente, §1.5) con `type` (`INFO`/`HR`/`RECRUITING`/`CAREERS`/etc.), `sourceUrl`, `discoveryProvider`, `verificationStatus`. **Decisión a confirmar con el PO:** ¿se mantiene `Company.email` como espejo de compatibilidad (algo ya lo lee hoy en UI/reportes) o se migra completamente a `CompanyContactPoint` y se deja `Company.email` como legacy/deprecado? Cualquiera de las dos es una decisión de producto, no de ingeniería — ver §9.

### 5.9 Email Validation (dominio real)

Antes de persistir cualquier email (Contact o CompanyContactPoint) con un estado distinto de "no verificado": normalizar (ya se hace: `decodeURIComponent`/trim/lowercase parcialmente, a completar), comparar el dominio del email contra el dominio canónico de la Company (**el gap exacto de §2.7** — hoy no existe esta comparación en ningún lado), detectar directorios/agregadores de terceros conocidos (ampliar `PLACEHOLDER_DOMAINS` con un criterio de "dominio de terceros" en vez de solo placeholders literales), marcar catch-all cuando el proveedor de verificación lo indique. El caso `editor@collegefencing360.com` para `General Manufacturing, LLC` debe, con esta capa, quedar `RISKY`/`INVALID` explícito, nunca aceptado sin marca.

### 5.10 Mission State honesto (5 estados reales)

`COMPLETED | PARTIAL | FAILED | BLOCKED | NO_RESULTS` — el gap concreto y ya cuantificado en datos reales (§2.3, §2.8): agregar `NO_RESULTS` como un estado real y distinto de `COMPLETED`, aplicado cuando la búsqueda se ejecutó correctamente pero no produjo ningún resultado válido. `BLOCKED` para cuando un proveedor/capacidad crítica pedida explícitamente no está disponible ANTES de arrancar (ej. el usuario pidió Hunter y no está configurado) — hoy esto se descubre a mitad de camino, nunca se declara por adelantado.

### 5.11 Executive Report + UI

El reporte (hoy un párrafo LLM con ~7 números) se extiende a las categorías pedidas por el PO (requested/planned/executed/raw/unique/accepted/rejected/new/existing/duplicates/contacts/organizational contact points/emails/hiring signals/providers omitted/cost/duration/limitations/next recommended action) — todas ya derivables de datos que el pipeline extendido va a producir (§5.3-§5.10), ninguna inventada. La UI (`Missions.tsx`, único archivo, se extiende — no se crea una segunda vista) muestra el `MissionPlan` (§5.3), el desglose completo, y las tools ejecutadas/omitidas con motivo.

---

## 6. Fases propuestas (F7.1–F7.12, ninguna implementada todavía)

Dependencias explícitas — no se implementa nada de esto sin aprobación subfase por subfase, mismo hábito que F5/F6.

- **F7.1 — Contratos de intención y plan** (`packages/shared`): `StructuredIntent`, `MissionPlan`, extensión de `MissionRestrictions` con exclusiones estructuradas. Sin LLM todavía, solo Zod.
- **F7.2 — Business Taxonomy**: decisión de almacenamiento (tabla vs. archivo versionado, ver §9), carga inicial con las categorías que el PO ya nombró (hoteles, food manufacturing, janitorial, data centers, industrial automation, healthcare/environmental services, restaurantes) — depende de F7.1.
- **F7.3 — Intérprete** (reemplaza/extiende `interpretDailyDirective`): valida contra la Taxonomía de F7.2, separa inclusion/exclusion estructuralmente. Depende de F7.2.
- **F7.4 — Planner**: genera y persiste el `MissionPlan`. Depende de F7.3.
- **F7.5 — Orchestrator dinámico**: ejecuta el plan de F7.4 en vez de la secuencia fija actual, preservando el principio "nunca un tool call sin que el plan ya lo haya declarado" (§5.4). Depende de F7.4.
- **F7.6 — Discovery + Validation**: dedup global (§5.5) + Business Validation (§5.6). Depende de F7.5.
- **F7.7 — Hiring Signal Intelligence**: nueva capacidad (§5.7). Depende de F7.6.
- **F7.8 — Contact Intelligence real**: conecta `CompanyContactPoint` (§5.8) + Email Validation (§5.9). Depende de F7.6 (puede correr en paralelo con F7.7).
- **F7.9 — Reporting/State**: 5 estados honestos (§5.10) + Executive Report extendido (§5.11, parte de reporte). Depende de F7.6-F7.8.
- **F7.10 — UI**: Mission Detail extendido. Depende de F7.9.
- **F7.11 — Tests**: cobertura completa (ver §7) — en la práctica, cada subfase anterior ya trae sus propios tests (mismo hábito de F5/F6); F7.11 es el cierre de cualquier gap de cobertura cruzada (ej. una misión de prueba controlada end-to-end con fixtures desechables, sin llamadas externas reales).
- **F7.12 — Cierre**: verificación final + documentación + commit de cierre, mismo formato que F6 §32.

---

## 7. Tests que el plan debe incluir (mapeados a fases, ninguno escrito todavía)

Hoteles, janitorial, food manufacturing, warehouses, hospitals, restaurants, data centers (F7.3/F7.6) · exclusions (F7.3) · multiple cities (F7.4) · hiring signals (F7.7) · provider unavailable / Hunter not configured / PDL exhausted (F7.6/F7.8, mismo patrón ya usado en `provider-health.test.ts` y `contact-intelligence.test.ts` existentes) · no contacts / only organizational emails / bad-domain email (F7.8/F7.9) · duplicate company / company already in CRM / demo data excluded (F7.6) · limit global (F7.6) · no campaigns/opportunities/outreach/messages (F7.5, mismo patrón ya probado en `mission-restrictions.test.ts`) · mission Completed/Partial/Failed/Blocked/No Results (F7.9, con casos reales ya identificados en §2.3 como regresión mínima obligatoria).

---

## 8. Riesgos

1. **Cambio de principio arquitectónico (§5.4):** el pipeline fijo de F4 es, por diseño, más auditable que uno dinámico. Un orchestrator "dinámico" mal diseñado podría reabrir el riesgo que F4 evitó a propósito (un LLM decidiendo acciones no predecibles). Mitigación de diseño ya propuesta: el LLM solo arma el *plan* una vez, la *ejecución* del plan sigue siendo 100% determinista — pero esto debe validarse con el PO antes de F7.4, no asumirse.
2. **Taxonomía como nuevo punto único de fallo:** si la taxonomía es incompleta o está mal versionada, todos los sectores dependen de ella — mismo riesgo que hoy tienen las 4 `Industry` reales, mitigado por el hecho de que la taxonomía es más fácil de extender que crear una `Industry` real (no requiere decisión de F5/F6 territory).
3. **Costo de más pasos por misión:** Business Validation + Hiring Signal Intelligence agregan llamadas (posiblemente LLM, posiblemente HTTP de crawling) por Company — el presupuesto de misión ya existe (`DEFAULT_DAILY_MISSION_BUDGET_USD`) pero debe revisarse si alcanza con más pasos por empresa.
4. **`CompanyContactPoint` sin consumidor en el frontend hoy** — conectar la escritura (F7.8) sin también actualizar la UI que lo muestre (F7.10) dejaría datos reales invisibles para el usuario — deben ir de la mano, no una fase completamente aislada de la otra en el orden de entrega real (aunque se documenten como subfases separadas).
5. **Reprocesar Companies ya existentes con la nueva validación de negocio** podría, en teoría, "des-clasificar" retroactivamente compañías ya creadas bajo el criterio viejo — **fuera de alcance de F7 explícitamente**: la validación de negocio (F7.6) aplica solo a Companies nuevas descubiertas de acá en adelante, nunca reprocesa el histórico (eso sería reabrir discovery/backfill de datos ya cerrados, prohibido).

---

## 9. Decisiones que el PO debe tomar antes de F7.1

1. **Almacenamiento de la Business Taxonomy (§5.1):** ¿tabla Postgres versionada (más flexible, requiere una migración — candidato de schema, ver abajo) o archivo versionado en `packages/shared`/`packages/agents` (sin migración, requiere deploy para cada sector nuevo)?
2. **`Company.email` vs `CompanyContactPoint` (§5.8):** ¿se mantiene `Company.email` como espejo de compatibilidad o se migra por completo?
3. **Alcance real de "Dynamic Tool Orchestration" (§5.4, riesgo #1):** ¿el PO acepta el diseño propuesto (LLM arma el plan una vez, ejecución 100% determinista) como la forma correcta de conciliar "dinámico" con "auditable", o prefiere otro balance?
4. **¿Se crean nuevas `Industry` reales** (Hospitality, Healthcare, Food Service, Commercial Services/Janitorial) **para que la taxonomía tenga un bucket real de archivo, o se acepta que esas Companies queden con `crmIndustryBucket: null`** (archivadas sin industria real, solo con la taxonomía como clasificación)? Esto es una decisión de F5/F6 territory (`Industry` es un modelo ya cerrado) — **F7 no crea industrias nuevas por sí solo sin esta autorización explícita**, tal como exige la regla de no reabrir F5/F6.
5. **Presupuesto de misión:** ¿se ajusta `DEFAULT_DAILY_MISSION_BUDGET_USD`/límites de Business Validation dado el costo adicional esperado (riesgo #3)?

---

## 10. Cambios de schema candidatos (NINGUNO aplicado — presentados como evidencia, a la espera de aprobación, mismo protocolo que F5/F6)

1. **Business Taxonomy como tabla real** (`BusinessTaxonomyEntry` o nombre a definir) — SOLO si el PO elige esa opción en la decisión §9.1. Alternativa sin schema: archivo versionado.
2. **Ninguno de los demás gaps requiere schema nuevo** — `CompanyContactPoint` y `discoveryMetadata` ya existen y alcanza con escribirlos; `MissionPlan`/`StructuredIntent` reutilizan `AgentTask.input`/`.output` (Json, mismo patrón de todo el proyecto); los 2 estados nuevos de misión (`BLOCKED`/`NO_RESULTS`) viven en el mismo campo `Json` de `AgentTask.output` (no es un enum de Postgres, es un string dentro del Json — confirmado revisando `MissionState` en `packages/shared`, no está en `schema.prisma` como enum real).

---

## 11. Proveedores — estado real (informativo, sin llamadas nuevas)

`GOOGLE_PLACES_API_KEY`, `PEOPLEDATALABS_API_KEY`, `HUNTER_API_KEY` — **las 3 están configuradas** en este entorno (confirmado leyendo `.env`, sin hacer ninguna llamada). Costo real acumulado de las 8 misiones ya ejecutadas: **$0.9114 USD** (suma de `AgentTask.costUsd` de cada misión + sus tareas hijas, dato real). Esto confirma que el presupuesto por misión ($3 USD/día por default) es holgado para el volumen actual — información útil para la decisión §9.5.

---

## 12. Confirmaciones finales de F7.0

1. **Solo documentación** — el único archivo modificado/creado en esta sesión de F7.0 es este documento (más las lecturas de código/DB, que no dejan rastro).
2. **Cero llamadas externas nuevas** — ninguna llamada a Google Places, People Data Labs, Hunter.io, OpenAI, Gmail, Twilio, ni ningún job board se hizo durante esta auditoría. Toda la evidencia viene de: código ya escrito (lectura), `AgentTask`/`Company` ya existentes en la base (lectura), `.env` (lectura de si una key está seteada, nunca su valor ni una llamada con ella), y `pnpm typecheck`/`lint`/`test` (ejecución local, sin red).
3. **Cero commit** — este documento no fue commiteado; se commitea solo si el PO lo autoriza explícitamente, junto con el resto de F7.0.
4. **Baseline confirmado sin cambios respecto al cierre de F6:** typecheck limpio (6/6 workspace projects), lint limpio (mismos 2 warnings preexistentes de `apps/web`, no relacionados), **514 tests backend (39 archivos enumerados explícitamente), 513 pass, 1 fail** (el mismo fallo preexistente de `prospecting.test.ts`, sin relación con F7, documentado desde F6.0).

**F7.0 completo.**

---

## 13. Resultado de F7.1 — Business Taxonomy + Intent Understanding + Mission Planner (aprobado)

Módulo 100% puro y determinista, `apps/api/src/modules/ceo-intelligence/` (`contracts.ts`, `taxonomy.ts`, `text-normalize.ts`, `geo.ts`, `intent-interpreter.ts`, `mission-planner.ts`) — cero Prisma, cero `fetch`, cero LLM. 20 categorías de taxonomía (Hospitality, Manufacturing, Food/Beverage Manufacturing, Packaging, Warehousing, Distribution, Healthcare, Janitorial, Commercial Cleaning, Construction, Roofing, Electrical, Industrial Automation, Data Centers, Mission Critical, Landscaping, Restaurants, Retail, Transportation), cada una con sinónimos es/en, company types, frases de búsqueda, títulos de trabajo, decisores, negative keywords, industrias relacionadas y validaciones. `interpretBusinessIntent(rawInstruction): StructuredIntent` + `buildMissionPlan(intent): MissionPlan`, 44 tests (100% passing), cubriendo los 17 ejemplos pedidos por el PO más ambigüedad/sinónimos/determinismo. Un bug real encontrado y corregido por los propios tests (sinónimo faltante "fabricas de alimentos"); un gap real encontrado y documentado sin corregir (bug de `mission-restrictions.ts` con conector "ni"/"o" — resuelto después, en F7.2). Cero llamadas externas, cero escrituras en BD, cero commit hasta la aprobación del PO, que llegó sin cambios pedidos al módulo.

---

## 14. Resultado de F7.2 — integración de planificación (aprobado)

### 14.1 Arquitectura

Estrategia de coexistencia explícita, sin tocar ni un carácter de `apps/api/src/modules/ceo-intelligence/` (F7.1) ni de `mission-orchestrator.ts`/`ceo-tools.impl.ts` (el flujo real de F4, con `interpretDailyDirective` + ejecución completa, sigue intacto):

- **`POST /missions`** (sin cambios) → `launchMission()` → `interpretDailyDirective` (LLM real) → pipeline completo (discovery, contactos, campañas).
- **`POST /missions/plan`** (nuevo) → `planMissionOnly()` (`apps/api/src/modules/agents/mission-planning.ts`, archivo nuevo) → `interpretBusinessIntent` + `buildMissionPlan` (F7.1, sin LLM) → persiste y se detiene. Cero AgentTask hijo, cero Company/Lead/Opportunity/Campaign.

Cuándo se documentó (nunca ejecutó) un fallback a `interpretDailyDirective`: cuando `confidence < 0.5` o hay ambigüedades, `ceoIntentMeta.warnings` registra explícitamente que un fallback opcional a LLM aplicaría en una fase futura autorizada — F7.2 nunca llama a OpenAI.

### 14.2 Bug de restricciones corregido (`packages/agents/src/tools/mission-restrictions.ts`)

Cambio mínimo, exactamente las expresiones confirmadas: `NO_OPPORTUNITY_RE` ganó una 3ra alternativa para "no crear campañas ni/o oportunidades" (antes solo detectaba "crear...oportunidad" adyacente); `NO_OUTREACH_RE` ganó "preparar/prepares" en su lista de verbos para "no preparar mensajes". 4 tests de regresión nuevos + los 11 preexistentes, 15/15 passing.

### 14.3 Contratos y versionado

Mirror en `packages/shared/src/schemas/missions.ts` (mismo criterio ya usado para `missionRestrictionsSchema`: packages/shared no puede importar de apps/api ni de packages/agents): `ceoStructuredIntentSchema`, `ceoMissionPlanSchema`, `ceoIntentMetaSchema`. Constantes `CEO_INTENT_SCHEMA_VERSION=1`, `BUSINESS_TAXONOMY_VERSION=1`, `MISSION_PLANNER_VERSION=1` — nunca mezcladas con `MATCH_SCHEMA_VERSION`/`MATCH_ALGORITHM_VERSION` de F6. `missionStateSchema` ganó el valor `"PLANNED"` (extensión seria de un enum Zod dentro de un campo Json, cero migración); `missionPhaseSchema` (`"PLANNED"|"EXECUTING"`) es la señal explícita adicional para cuando `AgentTask.status` (enum real de Prisma, sin cambios) sigue siendo `"DONE"`.

### 14.4 API

`POST /missions/plan` (permiso `missions.create`, igual que `POST /missions`) — crea la misión en modo planificación. `GET /missions/:id` (sin cambios de ruta) ahora también devuelve `ceoIntent`/`missionPlan`/`ceoIntentMeta` (null para toda misión que no pasó por `planMissionOnly`, incluidas todas las anteriores a F7.2).

### 14.5 UI (`apps/web/src/pages/Missions.tsx`)

Botón nuevo "Solo planificar (sin ejecutar)" junto a "Lanzar misión". Mission Detail: badge "Plan generado — todavía no ejecutado", sección "Interpretación del CEO" (objetivo, tipos de empresa, industrias, actividades, puestos, señales de contratación, decisores, ciudades, estados, exclusiones, restricciones, confianza, ambigüedades, capacidades no soportadas) y sección "Plan de misión" (pasos obligatorios/opcionales en orden, queries previstas, proveedores previstos, estrategia de deduplicación, fallback, stop conditions, warnings) — ambas presentes solo cuando `ceoIntent`/`missionPlan` no son null. Para una misión `PLANNED`, las secciones de ejecución (Empresas seleccionadas, Contact Intelligence, Tareas delegadas) quedan completamente ocultas, no solo vacías. Verificado visualmente en navegador real (capturas), y con una misión real preexistente (previa a F7.2) confirmando que sigue renderizando sin error.

### 14.6 Tests — 27 nuevos (todos passing)

`mission-planning.test.ts` (6): batería completa de los 18 casos obligatorios (cada uno valida serialización real contra los contratos espejo de `packages/shared`), restricciones aplicadas end-to-end, fallback documentado, **cero Company/Lead/Opportunity/Campaign/Contact/CompanyContactPoint/AgentTask-hijo** (verificado por conteo real antes/después contra un tenant sintético), tenancy (un plan de un tenant no es visible desde otro), compatibilidad con una misión real preexistente. `missions-plan.test.ts` (11): RBAC completo (ceo/admin/sales permitidos, 8 roles denegados — matriz verificada coherente), creación real de un plan vía HTTP + lectura vía `GET /missions/:id`, validación (instrucción vacía → 400, cero AgentTask creado). `mission-restrictions.test.ts` (+4 sobre los 11 ya existentes): regresión del bug corregido.

Suite completa: **44 archivos enumerados explícitamente, 578 tests, 577 pass, 1 fail** (el mismo `prospecting.test.ts` preexistente, sin relación).

### 14.7 Conteos antes/después (tenant-titan, real)

`Company`: 81 (sin cambio respecto al cierre de F6). `Lead`/`Opportunity`/`Campaign`/`Contact`/`CompanyContactPoint`: sin ninguna escritura atribuible a F7.2 (confirmado tanto por conteo directo como por el test dedicado de cero-efectos-secundarios). Único cambio real en `tenant-titan`: 2 `AgentTask` nuevos de tipo `daily_revenue_mission` con `missionPhase: "PLANNED"`, creados manualmente durante la verificación end-to-end en navegador real de este mismo trabajo (evidencia del feature funcionando, no un leak de test — mismos 2 llevan su propio `Activity`/`AuditLog` de auditoría, `action: "mission.planned"`, nada más).

### 14.8 Limitaciones conocidas (documentadas, no resueltas — fuera de alcance de F7.2)

- El fallback a `interpretDailyDirective` (LLM) nunca se ejecutó de verdad — solo se documenta cuándo aplicaría. Activarlo es una decisión de una fase futura.
- La ejecución real de un `MissionPlan` (correr `discover_companies`/`find_contacts`/etc. siguiendo el plan) no existe todavía — ese es exactamente el alcance de F7.5 (Dynamic Tool Orchestration) en el plan original, no de F7.2.
- `missionState="PLANNED"` no tiene ninguna acción disponible en la UI más allá de verlo (no hay botón "ejecutar este plan" — fuera de alcance explícito de F7.2).

### 14.9 Commits

`feat: F7.2 — integrate CEO intent and mission planning` (ver hash en el historial de git tras el commit de este trabajo).

### 14.10 Confirmaciones finales de F7.2

1. **Cero llamadas externas** — `interpretBusinessIntent`/`buildMissionPlan` son puras; ningún test ni la integración real llamó a Google Places/PDL/Hunter/OpenAI/Gmail/Twilio.
2. **Cero Companies/Leads/Opportunities/Campaigns creados** — verificado por conteo real antes/después contra tenant-titan y contra tenants sintéticos dedicados, y por un test explícito de cero-efectos-secundarios.
3. Typecheck limpio (6/6 workspace projects), lint limpio (mismos 2 warnings preexistentes de `apps/web`, no relacionados).

**F7.2 completo.**

---

## 15. Resultado de F7.3 — Dynamic Discovery Orchestration

### 15.1 Arquitectura

Nuevos módulos, ninguno modifica el AgentTool clásico `discover_companies` (`discovery-tools.impl.ts`, sigue existiendo intacto para el flujo `useExternalDiscovery=false`/legacy):

- `apps/api/src/modules/ceo-intelligence/discovery-identity.ts` — puro, cero Prisma: `normalizeCompanyName`, `normalizeDomain`, `normalizePhone`, `extractProviderPlaceId`, `buildCompanyIdentityKeys`, `deduplicateDiscoveryCandidates`. Replica deliberadamente la lógica ya escrita y probada en `packages/db/scripts/illinois-backfill-lib.mjs` (mismo criterio de nombre/dominio/teléfono) en vez de inventar una nueva.
- `apps/api/src/modules/agents/mission-executor.ts` — el ejecutor real (Prisma + fetch real vía Google Places/Overpass, nunca modifica esos dos proveedores). Separa las 8 responsabilidades pedidas: validación del plan (`buildFinalQueries` + guards `BLOCKED`), selección de proveedor (`executeOneQuery`, con `provider-health.ts` + `data-provider-budget.ts`, ambos reutilizados sin cambios), normalización (`buildCompanyIdentityKeys`), deduplicación global (`deduplicateDiscoveryCandidates`), clasificación (`classifyCandidate` + el stop-condition de bucket de Industry), persistencia (`persistAcceptedCandidate`, solo `Company`), reporte (`DiscoveryExecutionReport`).
- `mission-orchestrator.ts` — modificado quirúrgicamente: `runMissionPipeline` ahora desvía al inicio (`if (interpreted.useExternalDiscovery) { await runDynamicDiscoveryMission(...); return; }`) hacia una función nueva y delgada (`runDynamicDiscoveryMission`) que arma `StructuredIntent`+`MissionPlan` (F7.1, sin tocar) y llama a `executeDiscoveryPlan`. La rama de búsqueda interna en el CRM (`useExternalDiscovery=false`) queda **completamente intacta** — mismo código, mismos tests, cero regresión (confirmado, ver 15.6).

### 15.2 Reemplazo del loop por-industria

Se eliminó, del flujo nuevo, el patrón "por cada industria: ejecutar todos los search terms" — `buildFinalQueries(plan, primaryState)` toma exclusivamente `plan.searchQueries` (ya resueltas 1:1 contra la taxonomía en F7.1/mission-planner.ts), las combina con `plan.cities` (o una sola entrada sin ciudad si no hay ninguna), recorta, deduplica por texto normalizado, y descarta cualquier query que sea exclusivamente un término de exclusión. Cada query se ejecuta **una sola vez** (`executeOneQuery`), nunca una vez por industria/bucket.

### 15.3 Proveedores, presupuesto y salud

Google Places (primario, si `GOOGLE_PLACES_API_KEY` configurada y presupuesto no excedido vía `getDataProviderBudgetStatus`, reutilizado sin cambios) → Overpass (respaldo, solo cubre `Manufacturing`/`Warehouse-Logistics`/`Construction`, los mismos 3 patrones ya existentes en `overpass.ts`, sin tocar). `provider-health.ts` (existente, antes solo usado por Hunter/PDL) ahora también protege Discovery: el HTTP status se extrae del string de error que ya devuelven `searchGooglePlaces`/`searchOverpass` (regex `HTTP (\d+)`, ninguno de los dos archivos se modificó para exponerlo directamente) y se clasifica/marca con `classifyProviderHttpStatus`/`markProviderStatus`. Cero llamada real en los tests unitarios — `mission-executor.ts` acepta un parámetro `providers` inyectable (`DiscoveryProviderPort`), default los módulos reales.

### 15.4 Deduplicación global y clasificación

Orden fijo, exactamente como pidió el PO: `providerPlaceId` → `canonicalDomain` → `normalizedPhone` → `normalizedNameCityState` (esta última nunca es null — red de seguridad final). Se deduplica dentro de una query, entre queries, y contra **todas** las Companies ya existentes del tenant — **incluyendo `DEMO_SEED`** a propósito: "Prairie Manufacturing Co." (u otra empresa sembrada) nunca se re-crea como si fuera un descubrimiento nuevo si un proveedor devuelve un candidato con la misma identidad (test explícito, ver 15.6). El bucket de Industry real (`crmIndustryBucket`, ya resuelto por la taxonomía F7.1) decide el `industryId` — si es `null` (7 de las 20 categorías de taxonomía no tienen bucket real hoy: Hospitality, Healthcare, Janitorial, Commercial Cleaning, Landscaping, Restaurants, Retail), el candidato se **rechaza sin persistir** (nunca se inventa una Industry, nunca se aborta la misión completa — la query igual se ejecutó y cuenta en el reporte, por honestidad de costo/conteo). Esta decisión (§9.4 del plan original) sigue abierta — documentada, no resuelta acá.

### 15.5 Validación básica, persistencia y estados

Rechazo determinista si: sin nombre utilizable; el nombre coincide con una exclusión explícita de la misión; el nombre coincide con un `negativeKeyword` de la entrada de taxonomía que originó la query (ej. "staffing agency" para una búsqueda de hoteles). Cada Company aceptada persiste `discoveryMetadata` reusando el vocabulario ya documentado en el modelo (`classificationMode: "EXACT"`, `classificationConfidence`, `providerPlaceId`, `canonicalDomain`, `normalizedPhone`, etc.) — **nunca crea Lead/Opportunity/Campaign/Contact/CompanyContactPoint** (test explícito: "Discovery en F7.3 crea Company, pero nunca Lead/Opportunity/Campaign/Contact"). Estados lógicos (`output.missionState`, `AgentTask.status` sigue "DONE", cero cambio de enum real): `COMPLETED` (se alcanzó `requestedCompanyCount`), `PARTIAL` (empresas encontradas, no se alcanzó el número, o cancelada a mitad de camino), `NO_RESULTS` (queries corrieron bien, cero candidatos válidos — nunca `COMPLETED` con 0), `BLOCKED` (sin estado soportado / sin queries / sin proveedor con cobertura, antes de arrancar). `runDynamicDiscoveryMission` nunca llama a `closeMission`/`closeDailyMission` (esa función hace una llamada real a OpenAI para narrar el Executive Report) — el reporte de esta fase es 100% estructurado, `output.report` queda `null` a propósito.

### 15.6 Tests — 35 nuevos (todos passing) + 1 pre-existente sin relación

- `discovery-identity.test.ts` (18): normalización de nombre/dominio/teléfono, extracción de `providerPlaceId`, las 4 claves de identidad, deduplicación en las 4 prioridades + contra claves ya existentes + preservando el orden.
- `mission-executor.test.ts` (16, providers 100% mockeados, `global.fetch` sobreescrito para explotar si algo intenta red real): query ejecutada una vez, límite global (pide 2, el proveedor devuelve 5 → se crean exactamente 2), fallback real a Overpass tras un 402 (con `markProviderStatus` verificado), `NO_RESULTS` nunca `COMPLETED` con 0, `BLOCKED` (sin estado / sin queries), dedup por `providerPlaceId`/dominio/existente-en-CRM/DEMO_SEED, "crea Company pero nunca Lead", categoría sin bucket (se ejecuta, se rechaza), restricciones aplicadas, tenancy.
- `missions-dynamic-discovery.test.ts` (1, integración real de punta a punta contra `tenant-titan`, única prueba de esta fase con llamada real a Google Places — ver 15.7): confirma que `POST /missions` con una instrucción de descubrimiento externo real (Manufacturing/IL) ejecuta el nuevo flujo, nunca crea Lead/Opportunity/Campaign/Contact, y expone `discoveryExecution` en `GET /missions/:id`.

Suite completa (`pnpm test` en `apps/api`): **614 tests, 613 pass, 1 fail** — el fallo es `prospecting.test.ts`'s `runProspectingSweep` (real LLM, módulo no tocado por F7.3, falla también corriendo en aislado, confirmado pre-existente y sin relación).

### 15.7 Prueba real controlada (única llamada real de esta fase, además de la de arriba)

Instrucción real contra `tenant-titan` vía el dev server: *"Busca empresas de manufactura en Illinois que estén fuera de nuestro CRM, mediante búsqueda externa en fuentes externas/internet. Quiero encontrar 2 empresas nuevas. No crear campañas ni oportunidades."* — Manufacturing (bucket real aprobado), preferido sobre hoteles (sin bucket) tal como pidió el PO. Resultado real: `missionState: "COMPLETED"`, 2 Companies creadas (Sierra Manufacturing Corporation, Archer Manufacturing Corporation), 1 query ejecutada de 3 planificadas (`stopReason: "limit_reached"`), costo real `$0.032` (un solo request de Google Places), cero Lead/Opportunity/Campaign/Contact creados. Verificado también visualmente en navegador real (Playwright, capturas): secciones "Interpretación del CEO", "Plan de misión", "Plan ejecutado" (queries ejecutadas, proveedores usados, restricciones, limitaciones, motivo de detención), "Empresas seleccionadas" (las 2 reales, con badge de origen/confianza/website/teléfono), y "Contact Intelligence" mostrando el mensaje explícito "Contact Intelligence pendiente de una fase posterior" — nunca un grid de "0 emails/0 contactos" engañoso. Cero errores de consola. Ambas Companies y el AgentTask se limpiaron después de la verificación (no quedó ningún dato de esta prueba en `tenant-titan`).

### 15.8 UI (`apps/web/src/pages/Missions.tsx`)

`MISSION_STATE_VARIANTS` ganó `NO_RESULTS` (neutro) y `BLOCKED` (warning) — nunca confundidos con `COMPLETED`/`FAILED`. `MissionActions.isTerminal` los trata como terminales (el ejecutor corre de punta a punta de forma síncrona, nada que pausar/cancelar al terminar). Sección nueva `DiscoveryExecutionSection` ("Plan ejecutado"): estado + explicación en lenguaje humano, contadores (queries/crudos/aceptados/rechazados/duplicados/costo), detalle por query ejecutada, proveedores usados/omitidos, "Validación" (candidatos rechazados con razón/evidencia/confianza), restricciones aplicadas, limitaciones, motivo de detención. La sección "Contact Intelligence" existente ahora detecta `detail.discoveryExecution` y muestra el mensaje explícito en vez de las métricas (que serían todas 0 y engañosas). "Empresas seleccionadas" reutiliza la infraestructura existente — `missions/service.ts` ahora también agrega `discoveryExecution.createdCompanyIds` a la lista de Companies mostradas, sin inventar una sección paralela.

### 15.9 Contratos (`packages/shared/src/schemas/missions.ts`)

`missionStateSchema` ganó `"NO_RESULTS"`/`"BLOCKED"` (extensión aditiva seria, mismo criterio que `"PLANNED"` en F7.2 — cero migración). Nuevos: `discoveryQueryExecutionSchema`, `discoveryRejectedCandidateSchema`, `discoveryExecutionReportSchema` (espejo exacto de las shapes de `mission-executor.ts`, mismo criterio de "duplicar la forma, no la dependencia"). `missionDetailSchema` ganó `discoveryExecution` (nullable — null en toda misión legacy/planned-only/internal-CRM-search).

### 15.10 Conteos antes/después (tenant-titan, real)

Verificado explícitamente tras la limpieza de la prueba real controlada (15.7): `Company`: 81, `Lead`: 131, `Opportunity`: 53, `Campaign`: 1, `Contact`: 10, `CompanyContactPoint`: 22 — cero artefacto huérfano de F7.3 (confirmado por query directa: cero `AgentTask` de tipo `discover_companies` con `input.source: "mission-executor-f7.3"` remanente, cero Company de la prueba real remanente).

### 15.11 Limitaciones conocidas (documentadas, no resueltas — fuera de alcance de F7.3)

- La decisión de crear Industries reales para las 7 categorías de taxonomía sin bucket (§9.4) sigue abierta — esos candidatos se rechazan, no se persisten.
- `originalProviderTypes` en `discoveryMetadata` queda siempre `[]` — Google Places sí devuelve `types`, pero `extractFieldsFromGooglePlace` (existente, sin modificar) no los propaga a `ProviderCandidate.fields`; capturarlos requeriría tocar ese archivo, fuera de alcance de "no modificar los proveedores existentes".
- `providerPlaceId` solo se extrae cuando `sourceUrl` usa el formato de respaldo de `google-places.ts` (`place_id:` en la URL) — cuando la API devuelve `googleMapsUri` real, no hay id extraíble sin tocar ese archivo; limitación documentada, no bloqueante (cae a `canonicalDomain`/`normalizedPhone`/nombre+ciudad+estado).
- Business Validation es básica (nombre + exclusiones + `negativeKeywords`) — no incluye crawl real del sitio (eso es Website Intelligence, fuera de alcance).
- Hiring Signal Intelligence, People Data Labs, Hunter.io, Contact Intelligence completo, campañas/oportunidades/mensajes: explícitamente no implementados en esta fase.

### 15.12 Commit

`feat: F7.3 — dynamic CEO discovery orchestration` — únicamente los archivos de esta fase (`ceo-intelligence/discovery-identity.ts(+test)`, `agents/mission-executor.ts(+test)`, `agents/mission-orchestrator.ts`, `missions/service.ts`, `missions/missions-dynamic-discovery.test.ts`, `packages/shared/src/schemas/missions.ts`, `apps/web/src/pages/Missions.tsx`, este documento) — nunca mezclado con Hiring Signals/Contact Intelligence/Hunter/PDL/email validation/Campaign/Sales/Outreach/F7.4+.

### 15.13 Confirmaciones finales de F7.3

1. **Cero Lead/Opportunity/Campaign/Contact/CompanyContactPoint creados automáticamente** por el nuevo flujo — verificado por tests dedicados y por conteo real antes/después.
2. **Cero llamadas reales en tests unitarios** — solo 2 llamadas reales controladas en todo F7.3 (15.6/15.7), ambas documentadas, ambas limpiadas.
3. Typecheck limpio (api/web/shared), lint limpio.
4. Nunca se marcó `COMPLETED` con 0 empresas — confirmado por test y por el diseño de `missionState`.
5. La rama de búsqueda interna en el CRM (`useExternalDiscovery=false`) quedó intacta — misma suite de `missions.test.ts` (100 tests) pasando sin cambios.

**F7.3 completo.**

---

## 16. Resultado de F7.4 — Business Validation + Email Trust

### 16.1 Arquitectura

Dos módulos puros nuevos (`apps/api/src/modules/ceo-intelligence/`, cero Prisma/fetch, mismo criterio que el resto del directorio) + un módulo impuro nuevo (`apps/api/src/modules/agents/`, wiring real) + la extensión mínima quirúrgica de `mission-executor.ts`:

- **`business-validation.ts`** (Parte A) — un solo evaluador genérico `validateBusinessCandidate()` que LEE de `BUSINESS_TAXONOMY` (nunca un if por categoría, regla explícita del PO). Evidencia evaluada: nombre (contra `entry.companyTypes`, límite de palabra real vía `containsWord`), dominio del website (solo ítems de una sola palabra de `companyTypes`, ya que un hostname no tiene espacios), descripción pública (contra `entry.websitePhrases`, el campo de la taxonomía pensado explícitamente para esto — siempre vacía hoy, ningún proveedor la popula todavía), provider types (contra `companyTypes`, siempre vacío hoy — mismo motivo documentado en F7.3 §15.11), `businessActivities` (labels de la `StructuredIntent`, evidencia débil adicional). Reglas de rechazo, en orden: sin nombre → `REJECTED`; nombre coincide con una exclusión de la misión → `REJECTED`; nombre/dominio/descripción coincide con un `negativeKeyword` de la entrada de taxonomía → `REJECTED`; `taxonomyKey` desconocida → `REJECTED` (nunca se acepta en silencio, a diferencia del F7.3 original). Niveles de confianza: `EXACT` (match en el nombre) > `STRONG` (match en dominio/descripción/provider types) > `APPROXIMATE` (sin evidencia positiva, pero la query que lo encontró viene de `entry.googleSearchPhrases` de esta misma taxonomía) > `WEAK` (aceptado sin evidencia positiva ni corroboración de query) > `REJECTED`.
- **`email-trust.ts`** (Parte B) — `normalizeEmail()` (mailto:, parámetros, decode URL seguro, espacios, comillas envolventes, minúsculas, sintaxis, dominios placeholder — mismo criterio ya escrito y probado en `packages/db/scripts/illinois-backfill-lib.mjs`, duplicado a propósito) + `validateEmailTrust()`: `VERIFIED` solo con dominio exacto, subdominio real, o dominio alternativo EXPLÍCITAMENTE confirmado (`knownAlternateDomains`, vacío hoy); `RISKY` para proveedores de email gratuito (gmail/yahoo/etc.) o catch-all sin verificación (`isCatchAll`, vacío hoy); `INVALID` para sintaxis inválida, placeholder, o **dominio claramente ajeno sin ninguna relación** — exactamente el bug reportado por el PO (`editor@collegefencing360.com` contra `generalmanufacturing.net`); `UNKNOWN` cuando la empresa no tiene website conocido. `classifyContactPointType()` mapea el local-part a `CompanyContactPointType` por tokens (separados por `. _ + -`, exact-match para palabras cortas como "hr", prefix-match para palabras largas — evita el falso positivo real encontrado en desarrollo: "procurement" matcheaba "pr" de PRESS antes del fix). Reutiliza `EmailVerificationOutcome`/`CompanyContactPointType` (enums reales de Prisma) espejando el vocabulario, nunca inventando uno nuevo.
- **`company-enrichment.ts`** (`apps/api/src/modules/agents/`, impuro) — envuelve `runWebsiteIntelligence` (existente, sin modificar) + `validateEmailTrust`, procesa únicamente `genericEmails` (nunca `namedPeople` — esos son personas identificadas, Contact Intelligence, explícitamente fuera de alcance), deduplica por email normalizado, persiste `CompanyContactPoint` solo para `VERIFIED`/`RISKY` (nunca `INVALID`), actualiza `Company.email` solo si estaba vacío y el email es `VERIFIED` (nunca sobrescribe un valor existente, sea cual sea su calidad — deuda histórica documentada, no resuelta acá).
- **`mission-executor.ts`** — `classifyCandidate` reemplazado por un adaptador delgado sobre `validateBusinessCandidate`; tras `persistAcceptedCandidate`, se llama a `enrichCompanyWithOrganizationalEmails` para cada Company nueva. `discoveryMetadata.classificationMode` ahora guarda el nivel real (`EXACT`/`STRONG`/`APPROXIMATE`/`WEAK`) en vez del literal fijo `"EXACT"` de F7.3; nuevos campos `matchedEvidence`/`missingEvidence`/`businessValidationVersion`.

### 16.2 Extensión de la taxonomía (Parte A)

Se agregaron ítems de evidencia explícitamente pedidos por el PO a 6 categorías (`hospitality`, `manufacturing`, `food_manufacturing`, `warehousing`, `janitorial`, `commercial_cleaning`) — solo aditivo, ningún ítem existente se quitó. Bug real encontrado durante el desarrollo de tests: "Acme Manufacturing Co." y "Bright Star Janitorial Services" (patrones de nombre real, literalmente el ejemplo del PO "General Manufacturing, LLC") no matcheaban ningún ítem de `companyTypes` porque solo existían frases compuestas ("manufacturing company", "janitorial services company") — se agregaron las palabras sueltas "manufacturing" y "janitorial". Roofing/Electrical/Data Centers/Landscaping/Healthcare/Restaurants usan el mismo evaluador genérico sin ninguna extensión — sus `companyTypes` existentes ya alcanzan.

### 16.3 Pipeline (11 pasos)

(1) descubrir — `executeOneQuery` (F7.3, sin cambios); (2) normalizar — `buildCompanyIdentityKeys` (F7.3, sin cambios); (3) deduplicar — `deduplicateDiscoveryCandidates` (F7.3, sin cambios); (4) validar empresa — `classifyCandidate` → `validateBusinessCandidate` (F7.4 nuevo); (5) rechazar no relevantes — igual que F7.3, ahora con razones reales de Business Validation; (6) persistir Company — `persistAcceptedCandidate`, discoveryMetadata enriquecido; (7-8) inspeccionar website + extraer emails — `enrichCompanyWithOrganizationalEmails` → `runWebsiteIntelligence` (existente, sin modificar); (9) validar email — `validateEmailTrust`; (10) persistir CompanyContactPoint — solo VERIFIED/RISKY; (11) reporte — `DiscoveryExecutionReport` extendido.

### 16.4 Executive Report — campos nuevos

`candidatesValidated`, `acceptedCompanies`, `rejectedCompanies`, `rejectionReasons` (Parte A); `emailsExtracted`, `emailsVerified`, `emailsRisky`, `emailsInvalid`, `emailsUnknown`, `companyContactPointsCreated`, `companiesWithoutValidEmail`, `validationWarnings`, `companyValidations` (Parte B, un registro por Company real con su nivel de confianza + evidencia + resumen de emails). `rejectedCandidates` ganó `matchedEvidence`/`missingEvidence` opcionales.

### 16.5 CompanyContactPoint — persistencia real

Primera vez que este modelo (existente desde antes de F7, nunca poblado por el flujo real hasta ahora) recibe datos reales: `email`, `type` (clasificado por local-part), `sourceUrl`, `discoveryProvider: "Website Intelligence"`, `verificationStatus` (VERIFIED/RISKY, nunca INVALID), `confidenceScore`, `discoveredAt`, `verifiedAt`. Nunca degrada (ni siquiera toca) un punto de contacto que ya existe — verificado por `findUnique` antes de `create`, no `upsert` con `update:{}` (evita contar una fila ya existente como "creada").

### 16.6 Tests — 76 nuevos (todos passing) + 1 pre-existente sin relación

- `business-validation.test.ts` (31): hotel válido/inválido (×3 variantes de rechazo), manufacturing válido, distributor sin fabricación, logistics puro excluido, consulting excluido, staffing excluido, food manufacturing válido, warehouse válido/office-only-excluido, janitorial válido/staffing-excluido, roofing/electrical/data-center/landscaping/healthcare/restaurant válidos (mismo evaluador genérico), demo data (Prairie Manufacturing Co. valida igual que cualquier otra — el validador no conoce origin), niveles de confianza (EXACT/STRONG/APPROXIMATE/WEAK, los 4 exercised), rejection reasons, determinismo.
- `email-trust.test.ts` (35): normalización (mailto, parámetros, URL-encoded, espacios, mayúsculas, placeholder, sintaxis inválida, vacío), dominio (mismo exacto, subdominio directo e inverso, alternativo explícito, ajeno → `editor@collegefencing360.com` contra `generalmanufacturing.net` → `INVALID`, el caso real del PO), Gmail/Yahoo → RISKY, catch-all → RISKY, sin website → UNKNOWN, clasificación de rol (press/hr/careers/sales/info), determinismo.
- `company-enrichment.test.ts` (10, providers 100% mockeados, `global.fetch` sobreescrito): sin website; VERIFIED persiste + actualiza Company.email vacío; INVALID (el bug real) nunca persiste ni actualiza; RISKY persiste pero nunca actualiza Company.email; Company.email existente nunca se sobrescribe; dedup de emails duplicados; idempotencia (correr 2 veces no duplica); nunca crea Contact/Lead/Opportunity/Campaign (`namedPeople` se ignora explícitamente); cancelación honesta; tenancy.
- `mission-executor.test.ts` (16, actualizado): se corrigió un bug propio de los fixtures del test (`taxonomyKey: "hotel"` no existía en la taxonomía real, la key real es `"hospitality"` — el validador nuevo, más estricto, lo rechazaba por "taxonomy key desconocida" en vez de por bucket faltante); se inyectó un `WebsiteIntelligencePort` no-op en el helper `run()` para que Website Intelligence nunca intente red real en estos tests (antes de este fix, los tests seguían pasando pero logueaban intentos de red real bloqueados por el guardia de `global.fetch`).
- `missions-dynamic-discovery.test.ts` (1, extendido): además de las aserciones de F7.3, ahora confirma `companyValidations` (un registro por Company creada, nivel de confianza real), `emailsInvalid/companyContactPointsCreated` coherentes, el conteo real de `CompanyContactPoint` en `tenant-titan` coincide exactamente con lo reportado, y ningún `CompanyContactPoint` persistido queda nunca `INVALID`.

Suite completa (`pnpm test` en `apps/api`): **690 tests, 689 pass, 1 fail** — el mismo `prospecting.test.ts` preexistente (real LLM, módulo no tocado por F7.4), confirmado sin relación (falla también en aislado).

### 16.7 Prueba real controlada

La prueba de integración real de F7.3 (`missions-dynamic-discovery.test.ts`) ahora ejercita naturalmente todo el pipeline de F7.4 (Website Intelligence real corre para cada Company creada, gratis, sin API key) — se usó como la prueba real controlada exigida por el plan en vez de crear una separada: Manufacturing/Illinois (bucket real aprobado), máximo 2 Companies, sin Hunter/PDL, sin Leads/Opportunities/Campaigns. Resultado real: 2 Companies creadas (Archer Manufacturing Corporation, TRUMPF Smart Factory), ambas `businessConfidence: "EXACT"` (nombre coincide con "manufacturing"/"factory"). El sitio real de TRUMPF (`trumpf.com`) arrojó 2 emails organizacionales reales (`info@us.trumpf.com`, `human.resources@us.trumpf.com`) — ambos correctamente clasificados `VERIFIED` vía relación de subdominio real (`us.trumpf.com` es subdominio de `trumpf.com`), 2 `CompanyContactPoint` creados, `Company.email` actualizado. Costo real: $0.064 (2 requests de Google Places, Website Intelligence es gratis). Cero Lead/Opportunity/Campaign/Contact creados. Verificado también visualmente en navegador real (Playwright, capturas): secciones "Validación" (badges EXACT, evidencia "manufacturing"/"factory, manufacturing", advertencia "Sin email organizacional válido" para Archer que no tenía sitio) y "Emails organizacionales" (2 extraídos/2 verificados/0 riesgosos/0 inválidos/2 puntos de contacto) — cero errores de consola. Ambas Companies y sus CompanyContactPoint (cascada real vía `onDelete: Cascade`) se limpiaron después — cero dato de esta prueba quedó en `tenant-titan`.

### 16.8 UI (`apps/web/src/pages/Missions.tsx`)

Dos secciones nuevas en Mission Detail, ambas presentes solo cuando `detail.discoveryExecution.companyValidations` no está vacío: **"Validación"** (`BusinessValidationSection`) — una tarjeta por Company real, badge de nivel de confianza (EXACT/STRONG verde, APPROXIMATE/WEAK ámbar, REJECTED rojo — nunca aparece en la práctica, esos candidatos no llegan a persistirse), tipo/sector detectados, evidencia coincidente, evidencia faltante, advertencia "Sin email organizacional válido" cuando aplica. **"Emails organizacionales"** (`OrganizationalEmailsSection`) — contadores agregados (extraídos/verificados/riesgosos/inválidos/puntos de contacto) + una fila por Company con badges de estado — nunca muestra un email INVALID como si fuera utilizable. El mensaje de "Contact Intelligence" existente se aclaró a "Contact Intelligence (contactos personales) pendiente de una fase posterior" para distinguirlo explícitamente de Email Trust (que sí corrió).

### 16.9 Compatibilidad histórica

`companyValidations`/`emailsExtracted`/etc. quedan ausentes (no `undefined` que rompa serialización — el mirror schema de `packages/shared` los declara como campos requeridos del reporte, pero el reporte completo solo existe cuando `discoveryExecution` no es null) en cualquier misión anterior a F7.4 — `discoveryExecution` sigue siendo `null` para esas, la UI las sigue renderizando sin romperse (mismo mecanismo ya validado en F7.3). No se hizo backfill retroactivo de `CompanyContactPoint` para Companies descubiertas antes de F7.4.

### 16.10 Conteos antes/después (tenant-titan, real)

Idénticos a los de F7.3 tras limpiar la prueba real controlada — `Company`: 81, `Lead`: 131, `Opportunity`: 53, `Campaign`: 1, `Contact`: 10, `CompanyContactPoint`: 22 — cero drift, cero artefacto huérfano.

### 16.11 Bugs encontrados y corregidos durante F7.4

1. **Bug real del PO, resuelto de raíz para el flujo nuevo**: un email de dominio completamente ajeno (`editor@collegefencing360.com`) nunca puede quedar `VERIFIED`/`Confirmed` para una Company de otro dominio (`generalmanufacturing.net`) — `validateEmailTrust` lo clasifica `INVALID`, `company-enrichment.ts` nunca lo persiste. El bug original (`contact-intelligence-tools.impl.ts`'s `findEmailTool`, F4.6/F4.7) sigue existiendo sin tocar — fuera de alcance explícito de F7.4 (esa función pertenece al flujo clásico `useExternalDiscovery=false`/interno, no al nuevo ejecutor).
2. **Taxonomía real insuficiente para nombres de empresa comunes**: "Acme Manufacturing Co." y "Bright Star Janitorial Services" no matcheaban ningún `companyType` antes de agregar las palabras sueltas "manufacturing"/"janitorial" (ver 16.2) — encontrado escribiendo los tests obligatorios del PO, no en producción, pero real.
3. **Falso positivo de clasificación de rol**: `"procurement@acme.com"` se clasificaba `PRESS` (por el substring "pr" dentro de "procurement") antes de cambiar a matching por token — encontrado por el propio test `classifyContactPointType`.
4. **Test propio con `taxonomyKey` inventada**: un test de F7.3 (`mission-executor.test.ts`) usaba `taxonomyKey: "hotel"` (nunca existió en la taxonomía real, la key real es `"hospitality"`) — el validador de F7.3 lo ignoraba en silencio (permisivo con keys desconocidas); el de F7.4 lo rechaza explícitamente (más estricto, correcto) — corregido el fixture del test, no el validador.
5. **Fuga de red real en tests preexistentes**: los tests de F7.3 (`mission-executor.test.ts`) no inyectaban un `WebsiteIntelligencePort`, así que al conectar el enriquecimiento real en F7.4 empezaron a intentar red real (bloqueada por el guardia de `global.fetch` del propio test, así que nunca rompió nada, pero violaba "cero llamadas externas en tests") — corregido inyectando un port no-op.

### 16.12 Limitaciones conocidas (documentadas, no resueltas — fuera de alcance de F7.4)

- `providerTypes`/`description` en Business Validation quedan siempre vacíos — ningún proveedor conectado hoy los popula (mismo motivo que `originalProviderTypes` en F7.3 §15.11: requeriría tocar `google-places.ts`).
- `knownAlternateDomains`/`isCatchAll` en Email Trust existen en el contrato pero ningún proveedor los popula todavía — forward-compatible, no wireado.
- El bug histórico de `contact-intelligence-tools.impl.ts` (flujo clásico F4.6/F4.7, `useExternalDiscovery=false`) sigue sin corregir — fuera de alcance de F7.4 (que solo toca el flujo nuevo de `mission-executor.ts`). Backfill/fix de ese flujo es trabajo separado, recomendado para una fase futura si el PO lo autoriza.
- Ningún backfill retroactivo de `CompanyContactPoint` para Companies ya descubiertas antes de F7.4 (Illinois, etc.) — quedan sin ningún punto de contacto en este modelo hasta que se re-enriquezcan manualmente o en una fase futura.
- `RISKY` se persiste como `CompanyContactPoint` (decisión de producto tomada: "si el producto decide conservarlos", el plan lo permitía explícitamente) — si el PO prefiere lo contrario, es un cambio de una línea en `company-enrichment.ts`.

### 16.13 Commit

`feat: F7.4 — validate businesses and organizational emails` — únicamente los archivos de esta fase (`ceo-intelligence/business-validation.ts(+test)`, `ceo-intelligence/email-trust.ts(+test)`, `ceo-intelligence/taxonomy.ts`, `agents/company-enrichment.ts(+test)`, `agents/mission-executor.ts(+test)`, `agents/mission-orchestrator.ts`, `missions/missions-dynamic-discovery.test.ts`, `packages/shared/src/schemas/missions.ts`, `apps/web/src/pages/Missions.tsx`, este documento) — nunca mezclado con contactos personales/Hunter/PDL/hiring signals/campaigns/opportunities/outreach/F7.5+.

### 16.14 Confirmaciones finales de F7.4

1. **Cero Contact personal, Lead, Opportunity, Campaign creados automáticamente** por el flujo nuevo — verificado por tests dedicados (`company-enrichment.test.ts`, `mission-executor.test.ts`) y por conteo real antes/después contra `tenant-titan`.
2. **Cero llamadas reales en tests unitarios** — solo 1 llamada real controlada en todo F7.4 (16.7, la misma prueba de F7.3, extendida), documentada y limpiada.
3. Typecheck limpio (api/web/shared), lint limpio (mismos 2 warnings preexistentes de `apps/web`, no relacionados).
4. `CompanyContactPoint` solo contiene emails `VERIFIED`/`RISKY` — nunca `INVALID` — confirmado por test explícito y por la prueba real.
5. `Company.email` nunca degradado — un valor ya existente nunca se sobrescribe, sea cual sea su calidad.

**F7.4 completo. A la espera de aprobación del PO para iniciar F7.5.**
