# F7 — CEO Intelligence & Autonomous Client Acquisition — Plan Técnico

**Estado: F7.0 (auditoría + baseline) completo. Nada más está aprobado todavía.** Este documento entrega exactamente lo pedido por el PO para F7.0: auditoría, causas raíz, fallos reproducidos con datos reales, arquitectura propuesta, fases, cambios de schema candidatos, riesgos, proveedores, tests, decisiones necesarias. **Cero código funcional escrito. Cero llamada nueva a Google Places/PDL/Hunter/OpenAI/Gmail/Twilio/job boards. Cero commit** (se hace commit de este documento solamente si el PO lo autoriza explícitamente, igual que cualquier otro entregable de solo-documentación de este proyecto).

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

**F7.2 completo. A la espera de aprobación del PO para iniciar F7.3.**
