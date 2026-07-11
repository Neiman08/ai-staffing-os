# F4.7 — Email Intelligence & Verified Outreach — Propuesta Técnica

**Estado:** **implementación parcial real, verificada** — §1 (Website Intelligence), §2 (email discovery: website + Hunter.io) y §3 (email verification: Hunter.io) implementados y verificados con datos reales. §6–§9 (Gmail OAuth, envío controlado, deliverability, inbox) **siguen sin implementar**. **Branding y dominio ya decididos (2026-07-11): marca `DreiStaff`, dominio `dreistaff.com`, portal privado `app.dreistaff.com`, entidad legal `Data More LLC`** — ver "Addendum 2 — branding y dominio decididos" al final. Esto NO destraba Gmail/envío: siguen bloqueados hasta cuenta de Workspace real, correo de envío, dirección postal, SPF/DKIM/DMARC y OAuth Client ID/Secret. Ver también "Addendum 1 — implementación real (2026-07-10)".
**Precedente:** F0–F4.6 completos y verificados con datos reales (commit `a7e770c`, F4.6 — Contact Intelligence Agent). Este plan **extiende** lo que F4.5/F4.6 ya construyeron — no reemplaza nada.
**Naturaleza de esta fase:** es la primera fase que envía correo real fuera del tenant, la primera que toca una cuenta de Google Workspace real, y la primera que introduce cifrado de credenciales en reposo. El riesgo (reputación de dominio, CAN-SPAM, spam real) es mayor que cualquier fase anterior — de ahí el énfasis explícito del pedido en "no debe convertirse en una máquina de spam" y en control humano estricto en cada paso que toque el mundo exterior. **Esta sección de riesgo sigue aplicando integralmente a §6–§9 (Gmail/envío/deliverability/inbox), que no se implementaron en este corte.**

---

## 0. Revisión del estado real del repositorio (antes de proponer nada)

### 0.1 Qué ya existe y F4.7 reutiliza sin cambios

| Pieza | Dónde | Por qué aplica a F4.7 |
|---|---|---|
| Patrón de proveedor intercambiable | `apps/api/src/modules/agents/tools/discovery-providers/` (F4.5), `contact-providers/` (F4.6) — `types.ts` con contrato común + un archivo por proveedor + orquestador que decide cuál usar | F4.7 replica el mismo patrón exacto para `email-providers/` y `email-verification-providers/` (pedido explícito del usuario, §2/§3) |
| `DiscoveredField`/`FieldStatus` (`CONFIRMED`/`INFERRED`/`NOT_FOUND`) | `packages/agents/src/tools/discovery-tools.ts` | Mismo vocabulario cerrado se reutiliza para cada dato de email — nunca un cuarto valor inventado |
| Presupuesto de proveedores de datos separado del de IA | `apps/api/src/modules/agents/data-provider-budget.ts` (`DATA_PROVIDER_TASK_TYPES`, hoy `["discover_companies", "find_contacts"]`) | Se extiende con `"find_email"`/`"verify_email"` — mismo guardia, mismo mecanismo, sin duplicar código |
| `ApprovalRequest` como frontera de todo lo externo | `packages/db/prisma/schema.prisma:1098`, `apps/api/src/modules/approvals/service.ts` | Sigue siendo la frontera para outreach — F4.7 la extiende con un segundo gate (envío real), no la reemplaza |
| `Contact` con procedencia (`source`, `confidenceScore`, `discoveredAt`, `discoveredByAgentTaskId`, `verificationStatus`) | `schema.prisma:484` (F4.6) | Se amplía de forma aditiva (§4) — mismo principio que ya se siguió para pasar de F4.5 a F4.6 |
| `Contact Intelligence Agent` (`contact_intelligence`) | `apps/api/src/modules/agents/tools/contact-intelligence-tools.impl.ts` | Se **amplía** (no se crea un cuarto agente) para que además busque/verifique email — pedido explícito §5 |
| Pipeline de la Daily Revenue Mission | `apps/api/src/modules/agents/mission-orchestrator.ts` — hoy: `create_campaign → discover_companies → (find_contacts por cada Company nueva) → select_target_companies` | Email Intelligence se inserta **inmediatamente después de cada `find_contacts`**, antes de `select_target_companies` — mismo punto de inserción que F4.6 usó para insertarse después de `discover_companies` |
| `AuditLog`/`Activity`/`AgentTask` | `schema.prisma:1054/558/1118` | Reutilizados sin cambios — cada acción de Email Intelligence audita igual que Discovery/Contact Intelligence |
| RBAC (`agents.execute`/`agents.view`/`approvals.decide`) | `packages/shared/src/permissions.ts` | Cubre todo lo de lectura/verificación/aprobación de esta fase — no se necesita ninguna `SPECIAL_PERMISSION_KEY` nueva para eso |

### 0.2 Qué NO existe todavía (gaps reales, no supuestos)

Confirmado leyendo el repo, no asumido:

1. **Ningún draft/mensaje de outreach está atado a un `Contact` real.** `personalizeMessage` (F4, `outreach-tools.impl.ts:185`) arma `proposedAction = { campaignId, campaignCompanyId, sequenceStep, channel, subject, body }` — nunca incluye un destinatario con email real. Hoy el borrador es "para la empresa", no "para Jane Doe, HR Manager, jane@empresa.com". **Esto es el gap arquitectónico más importante que F4.7 debe resolver** (§5, §6): para enviar un email real hace falta un `to:` real, que solo puede venir de un `Contact.email` con `emailVerificationStatus = VERIFIED`.
2. **`decideApproval` (`apps/api/src/modules/approvals/service.ts:40`) no dispara ningún efecto secundario hoy** — solo cambia `status`/marca el `AgentTask` `DONE`. No existe ningún gancho de "al aprobar, hacé algo externo". F4.7 necesita definir ese gancho sin romper el comportamiento actual para `ApprovalRequest` de campañas (F4) que no son de email.
3. **No existe ningún cliente HTTP para páginas web arbitrarias** (Discovery/Contact Intelligence solo llaman APIs JSON, nunca hacen scraping de HTML). Website Intelligence (§1) es la primera pieza del proyecto que parsea HTML de un tercero — no hay parser HTML instalado (`cheerio` no está en `package.json`), no hay manejo de `robots.txt`.
4. **No existe ninguna integración OAuth en todo el repo.** `AUTH_MODE` (`env.ts`) solo soporta `dev-bypass`/`clerk` para autenticar *usuarios del sistema* — no tiene relación con OAuth de un proveedor externo (Google). No hay ningún mecanismo de cifrado en reposo (`grep -r "crypto\|encrypt"` sobre `apps/api/src` no devuelve nada) — hay que construirlo desde cero, con cuidado.
5. **`Tenant` no tiene dirección postal ni configuración de remitente.** `Tenant.settings` (Json, ya usado para `aiMonthlyBudgetUsd`/`dataProviderBudgetUsd`) es el lugar correcto para esto — no hace falta una columna nueva.
6. **No hay ninguna página de "Conexiones"/OAuth en el frontend.**

### 0.3 Documentos previos revisados

- `docs/F4_5_EXTERNAL_DISCOVERY_AND_EMAIL_PLAN.md` — §6/§7/§8/§9/§12/§13/§14 ya anticipan casi exactamente el alcance de F4.7 (verificación de email, Gmail API, envío controlado, lectura de respuestas, SPF/DKIM/DMARC, CAN-SPAM) desde una fase de planificación anticipada de julio 2026, antes de que F4.5A/F4.6 se implementaran. F4.7 es la implementación real de esas secciones, ahora con el contexto real de F4.5A/F4.6 ya construido (proveedores intercambiables, `ApprovalRequest`, presupuesto separado) en vez de ser pura especulación.
- Adenda de F4.5 ("Google Places como proveedor primario") confirma el patrón de aprobación real ya seguido dos veces (Google Places, People Data Labs): el PO aprueba el proveedor y el gasto *antes* de escribir el código que lo usa, nunca después. F4.7 sigue exactamente ese mismo patrón (§ Regla de implementación, al final).
- `docs/F4_AUTONOMOUS_OUTREACH_PLAN.md` — arquitectura de `Campaign`/`CampaignCompany`/Outreach Agent, confirmado el gap del punto 0.2.1 leyendo `outreach-tools.impl.ts` directamente.

---

## 1. Website Intelligence

Nuevo módulo de solo-lectura, **sin proveedor pago** — es HTTP + parseo de HTML del propio sitio de cada `Company`, mismo espíritu que "fuente pública autorizada" ya aplicado a Overpass en F4.5A.

### 1.1 Alcance por Company

Solo si `Company.website` existe (si es `null`, Website Intelligence se salta esa empresa — nunca adivina una URL). Se visita únicamente el dominio de `Company.website` (nunca un dominio distinto, nunca un subdominio no enlazado desde la página raíz) y se buscan, **solo si están enlazadas desde una página ya visitada**, rutas cuyo texto de enlace o `href` matchee (case-insensitive, sin necesidad de URL exacta):

```
/contact, /contact-us, /about, /about-us, /team, /leadership,
/careers, /jobs, /staff, /our-team, /people
```

### 1.2 Límites duros (obligatorios, no configurables por la IA)

| Límite | Valor | Motivo |
|---|---|---|
| Profundidad máxima | 2 (home → página enlazada; nunca una página enlazada desde una página enlazada) | Evita rastrear un sitio entero |
| Páginas máximas por Company | 6 (home + hasta 5 de la lista §1.1) | Tope duro de costo de tiempo/red por empresa |
| Timeout por request | 10s (`AbortSignal.timeout`, mismo patrón que `discovery-providers`/`contact-providers`) | Un sitio caído no debe colgar la misión |
| Tamaño máximo de respuesta | 2 MB por página (se corta la lectura del stream, no se descarta la empresa) | Evita cargar un PDF de 40MB linkeado como "Contact" |
| Reintentos | 1 (no 3 — a diferencia de una API paga, un sitio caído una vez probablemente sigue caído; no vale la pena gastar más tiempo) | Sitios de PyME reales caen seguido, no hay SLA |
| `robots.txt` | Se descarga y se respeta **siempre**, antes de la primera request a cualquier ruta que no sea la home. Si `robots.txt` no existe o falla la descarga → se asume permitido (comportamiento estándar), pero se loguea. Si `Disallow: /` bloquea todo → Website Intelligence no visita nada de ese dominio, resultado `NOT_FOUND` honesto, nunca se ignora la política. | Cumplimiento explícito pedido por el usuario |
| Rate limit por dominio | 1 request concurrente, 500ms mínimo entre requests al mismo dominio dentro de una misma corrida | Buena ciudadanía — nunca varias misiones en paralelo golpeando el mismo sitio a la vez |
| User-Agent | `AIStaffingOS-WebsiteIntelligence/1.0 (+https://<dominio del tenant>/bot-info; contacto: <email configurado en Tenant.settings>)` — identificable, con contacto real, exactamente lo que pide el punto §1 | Transparencia — nunca se enmascara como un navegador real |

### 1.3 Qué se extrae (siempre con `DiscoveredField`, nunca inventado)

De cada página visitada:
- **Emails públicos**: regex sobre el HTML renderizado como texto + atributos `href="mailto:..."` (prioridad a `mailto:`, más confiable que un email suelto en texto). Se descartan patrones claramente genéricos de spam-trap/placeholder (`example.com`, `yourname@`, imágenes ofuscadas no se decodifican — si el email está ofuscado con JS/imagen, queda `NOT_FOUND`, nunca se intenta "desofuscar" agresivamente).
- **Teléfonos**: regex de formato NANP (mismo `+1 XXX-XXX-XXXX` ya usado en Google Places).
- **Formularios de contacto**: se detecta la presencia de un `<form>` en `/contact*` — se guarda como booleano + la URL, nunca se interactúa con el formulario (no se hace POST, no se "envía" nada — esto sería scraping activo no autorizado por el pedido).
- **Página de careers**: se detecta si `/careers`/`/jobs` existe y responde 200 — señal binaria, se persiste como `Company.notes`-style metadata dentro del output del `AgentTask` (no un campo nuevo de `Company`, ver §4: "mantener los cambios de schema al mínimo").
- **Nombres y cargos públicos**: solo si aparecen en una estructura reconocible junto (mismo bloque/tarjeta) — ej. una página de `/team` con "Jane Doe — HR Manager". Nunca se infiere un cargo de un nombre suelto sin cargo explícito al lado.
- **Fuente exacta**: cada dato guarda la URL exacta de la página donde se encontró (`sourceUrl`), igual que `Company.sourceUrl`/`Contact.source` ya hacen desde F4.5/F4.6 — no "el sitio web", sino la URL puntual de esa página.

### 1.4 A dónde va cada dato encontrado

| Dato encontrado | Destino | Por qué |
|---|---|---|
| Email genérico (`info@`, `contact@`, sin nombre de persona asociado) | `Company.email` (columna ya existente, hoy casi siempre `null` porque Google Places no la provee) | Ya existe, cero cambio de schema — es exactamente el campo que F4.5 dejó documentado como "correo público general de la empresa" |
| Email + nombre + cargo (ej. "Jane Doe, HR Manager — jane@empresa.com" en `/team`) | Coincide con un `Contact` ya creado por Contact Intelligence (dedup por nombre+empresa, mismo mecanismo de F4.6) → actualiza ese `Contact.email` (nunca sobrescribe uno de mayor confianza, ver §4). Si no coincide con ningún `Contact` existente → **crea uno nuevo** con `decisionRole` clasificado igual que F4.6 (`mapTitleToDecisionRole`, reutilizado sin cambios), `source: "Website (about/team page)"` | Mismo principio "nunca inventar" — el nombre y el cargo vinieron literales de una página pública real, igual de válido que un dato de People Data Labs |
| Teléfono, formulario, careers | Metadata del `AgentTask.output` de `find_email` (no un campo nuevo) | No hay un caso de uso todavía que justifique persistirlos en columnas — se muestran en la UI vía el output del task, mismo patrón que `discover_companies` ya expone `hiringSignals`/`visiblePositions` sin columnas dedicadas |

### 1.5 Nueva dependencia (gratuita, a documentar — no a "aprobar como gasto")

- **`cheerio`** (parser HTML tipo jQuery, MIT license, sin costo, sin llamadas de red propias) — se agrega a `apps/api/package.json`. Es una librería, no un proveedor: no requiere aprobación de gasto, solo se documenta acá por transparencia (mismo criterio que ya se aplicó a `xlsx` en F3).
- **`robots-parser`** (parser de `robots.txt`, MIT license, ~2kb) — mismo criterio.

---

## 2. Email Discovery Provider

Arquitectura calcada del patrón ya construido en F4.5/F4.6 — mismos nombres de archivo pedidos explícitamente por el usuario:

```
apps/api/src/modules/agents/tools/email-providers/
  types.ts                   — EmailCandidate, EmailProviderSearchResult, EmailProviderSearchParams (mismo shape que contact-providers/types.ts)
  website-public-email.ts    — no es un "proveedor pago": envuelve el resultado de Website Intelligence (§1) con el mismo contrato, prioridad #1
  hunter.ts                  — proveedor comercial (a aprobar, ver §Bloqueantes)
  README.md                  — mismo documento de contrato que contact-providers/README.md, adaptado
```

### 2.1 Orden de prioridad (determinista, nunca decidido por el LLM)

1. **Email público del website oficial** (`website-public-email.ts`, §1) — gratis, ya verificado por venir del sitio de la propia empresa.
2. **Proveedor autorizado de descubrimiento** (`hunter.ts` o el que se apruebe) — solo si (1) no encontró nada Y el presupuesto de proveedores de datos no está agotado.
3. **`NOT_FOUND`** — si ninguna fuente devolvió un email verificable, el `Contact`/`Company` queda sin email, nunca se completa con un patrón inferido.

### 2.2 Regla explícita contra patrones inferidos

**Nunca se genera `{nombre}.{apellido}@{dominio}` (ni ninguna otra heurística de patrón de email corporativo) como si fuera un dato confirmado.** Esta clase de heurística (común en herramientas de "email finder" baratas) es exactamente lo que el pedido prohíbe explícitamente con el ejemplo `john.smith@company.com`. Si en el futuro se quiere ofrecer esto como *sugerencia* visible para un humano, debe:
- guardarse con `emailVerificationStatus: NOT_VERIFIED` y un campo/flag explícito de "patrón inferido, no confirmado por ninguna fuente" (a nivel de UI, no de outreach),
- **nunca** quedar disponible para `personalizeMessage`/envío (§6 exige `VERIFIED` para eso, sin excepción),
- no forma parte del alcance inicial de F4.7 — se documenta acá solo para dejar constancia de que se consideró y se descartó del pipeline automático por defecto.

### 2.3 Proveedor comercial candidato — investigado, no contratado

| Proveedor | Qué da | Free tier | Costo pago (2026, a verificar contra precio vigente antes de escalar) | Encaje |
|---|---|---|---|---|
| **Hunter.io** | Domain Search (emails públicos indexados por dominio, con nombre/cargo cuando lo tienen) + Email Verifier integrado en la misma cuenta/API key | 25 búsquedas de dominio/mes + 50 verificaciones/mes, sin tarjeta de crédito | Plan "Starter" desde ~$34–49/mes (500 búsquedas) | Cubre discovery **y** verification con un solo proveedor/API key — reduce superficie de credenciales nuevas a una sola, en vez de dos vendors distintos |
| **Apollo.io** | Igual que Hunter + datos de empresa/contacto más ricos (ya evaluado en F4.5 §1, seguía documentado ahí como opción de contactos) | Plan gratis muy limitado (créditos mensuales bajos) | ~$49–99/mes | Redundante con People Data Labs (ya contratado en F4.6) para el descubrimiento de contactos — no aporta algo que PDL no dé ya; se mantiene fuera de alcance de F4.7 salvo que PDL resulte insuficiente para email específicamente |
| **Clearbit/Prospeo/Snov.io** | Alternativas equivalentes a Hunter | Variable, en general free tiers pequeños | Similar rango | No investigadas en profundidad — se documentan como alternativas intercambiables detrás del mismo contrato si Hunter no rinde |

**Recomendación de este documento:** **Hunter.io** como proveedor #2 de discovery — free tier (25 búsquedas + 50 verificaciones/mes) alcanza cómodamente el DoD del piloto (§14: "al menos 3 contactos con emails reales", "prueba piloto máxima de 3 correos") sin gastar un dólar. Se documenta la ruta a un plan pago si el volumen crece, pero **no se contrata nada todavía** — ver Bloqueantes.

---

## 3. Email Verification

Mismo patrón de contrato intercambiable, carpeta separada (nombre pedido explícitamente por el usuario):

```
apps/api/src/modules/agents/tools/email-verification-providers/
  types.ts       — EmailVerificationResult { status, confidenceScore, provider, sourceUrl?, checkedAt }
  hunter.ts       — si se aprueba usar el verifier de Hunter (mismo vendor que discovery, §2.3)
  neverbounce.ts  — alternativa evaluada, no contratada
  README.md
```

### 3.1 Vocabulario cerrado (Zod `z.enum`, igual que `ContactVerificationStatus`/`CompanyVerificationStatus`)

| Estado | Significado | ¿Disponible para outreach automático? |
|---|---|---|
| `VERIFIED` | El proveedor confirma que la dirección existe y acepta correo (deliverable) | **Sí, único estado habilitado** |
| `RISKY` | Existe pero con señales de riesgo (catch-all, buzón lleno, dominio con reputación dudosa) | No — requiere revisión humana explícita antes de usarse |
| `INVALID` | El proveedor confirma que no existe / rebota | No, nunca — se agrega a la suppression list automáticamente (§ heredado de F4.5 §12) |
| `UNKNOWN` | El proveedor no pudo determinar el estado (timeout, dominio no verificable, greylisting) | No — requiere revisión humana |
| `NOT_VERIFIED` | Todavía no se corrió ninguna verificación sobre este email (default) | No — es el estado inicial de todo email recién encontrado, antes de llamar al provider |

### 3.2 Proveedores evaluados

| Proveedor | Costo aprox. (a verificar antes de escalar) | Nota |
|---|---|---|
| **Hunter.io Email Verifier** | Incluido en el mismo free tier/plan de §2.3 (50 verificaciones/mes gratis) | Recomendado por consolidar credencial con discovery — un solo vendor nuevo, no dos |
| **NeverBounce** | ~$0.008/verificación, sin mínimo mensual en el plan pay-as-you-go | Ya documentado en F4.5 §6 como candidato — sigue siendo válido si Hunter no alcanza |
| **ZeroBounce** | ~$0.007–0.01/verificación | Similar a NeverBounce, incluye score de "sendability" |

**Recomendación:** empezar con el verifier de Hunter (mismo vendor, mismo free tier, cero credencial nueva además de la ya necesaria para discovery). Si el volumen supera el free tier o la calidad no alcanza, NeverBounce/ZeroBounce quedan documentados como reemplazo intercambiable detrás del mismo contrato — no una decisión a tomar ahora.

### 3.3 Cuándo se verifica

Una sola vez por email, en el momento en que se confirma (no en cada intento de envío) — mismo criterio ya documentado en F4.5 §6. Si un `Contact.email` cambia (una fuente nueva trae un email distinto), se re-verifica el nuevo valor antes de reemplazar el anterior (ver regla de no-downgrade, §4).

---

## 4. Modelo de datos

### 4.1 Extensión aditiva de `Contact` (única tabla que cambia)

```prisma
enum EmailVerificationStatus {
  NOT_VERIFIED
  VERIFIED
  RISKY
  INVALID
  UNKNOWN
}

model Contact {
  // ...campos existentes de F1/F4.6 sin cambios...

  // F4.7: procedencia del EMAIL específicamente — distinto de
  // `source`/`confidenceScore`/`discoveredAt` (F4.6), que describen la
  // procedencia del CONTACTO como registro completo (nombre/cargo). Un
  // Contact puede venir de People Data Labs (source) pero tener el email
  // encontrado después, por una fuente distinta (Website Intelligence o
  // Hunter) — de ahí campos de procedencia separados para el email.
  emailSource               String?                   // "Website (about/team page)" | "Hunter.io" | null
  emailSourceUrl            String?                   // URL exacta de la página o referencia del proveedor
  emailDiscoveryProvider    String?                   // nombre del proveedor real, igual que Company.origin distingue fuente
  emailVerificationProvider String?
  emailVerificationStatus   EmailVerificationStatus   @default(NOT_VERIFIED)
  emailConfidenceScore      Float?                    // 0–1, del proveedor de verificación (no confundir con Contact.confidenceScore, que es del descubrimiento del contacto)
  emailDiscoveredAt         DateTime?
  emailVerifiedAt           DateTime?

  // F4.7: control de envío — vive en Contact porque el opt-out/bounce
  // es por dirección de correo/persona, no por Company.
  doNotContact               Boolean                  @default(false)
  bouncedAt                  DateTime?
  unsubscribedAt              DateTime?

  @@index([tenantId, emailVerificationStatus])
}
```

Exactamente los campos pedidos, ni uno más. **No se agrega ningún modelo nuevo** (`EmailSuppressionList` se resuelve como una consulta sobre `Contact` con `doNotContact = true OR bouncedAt IS NOT NULL OR emailVerificationStatus = 'INVALID'`, no una tabla nueva — mismo principio que F4 aplicó a `Campaign`/`CampaignCompany` de "no crear un modelo si se puede derivar").

### 4.2 Regla de no-downgrade (nueva invariante de negocio, a implementar en código — no en schema)

**Nunca sobrescribir un email con `emailVerificationStatus = VERIFIED` con uno de menor confianza.** Se implementa como una comprobación explícita antes de cualquier `UPDATE` de `Contact.email` en el Email Intelligence Agent:

```
si contact.emailVerificationStatus === "VERIFIED" y el nuevo email es distinto
  → no sobrescribir automáticamente; registrar el candidato nuevo en el
    output del AgentTask como "conflicto detectado, revisión humana
    sugerida" (Activity tipo SYSTEM), nunca reemplazar en silencio.
si contact.emailVerificationStatus !== "VERIFIED"
  → el nuevo dato reemplaza al anterior solo si su fuente es igual o
    mejor prioridad (§2.1): Website Intelligence > proveedor pago > nada.
```

### 4.3 Modelos nuevos para Gmail (evaluados, mínimos)

Dos modelos nuevos — cada uno justificado explícitamente (mismo estándar que F4 aplicó a `Campaign`/`CampaignCompany`):

**`GmailConnection`** — sí es necesario. No hay ningún modelo existente que pueda representar "una cuenta de Google Workspace conectada, con sus tokens, su estado y su historial de sync" sin inventar campos sueltos en `Tenant` (que es un modelo genérico, no debería cargar tokens cifrados de un proveedor específico).

```prisma
enum GmailConnectionStatus {
  CONNECTED
  DISCONNECTED
  ERROR
  REVOKED
}

model GmailConnection {
  id                String                @id @default(cuid())
  tenantId          String                @unique // una cuenta conectada por tenant en este primer corte — múltiples remitentes es una fase futura
  emailAddress      String                // cuenta de Workspace conectada en dreistaff.com — dirección exacta (¿outreach@? ¿sales@?) todavía sin confirmar por el PO, ver B5
  status            GmailConnectionStatus @default(CONNECTED)
  // Tokens SIEMPRE cifrados en reposo (AES-256-GCM, ver §Seguridad) —
  // nunca texto plano, nunca logueados. accessToken tiene TTL corto
  // (~1h) y se re-deriva del refreshToken; ambos viven cifrados acá.
  encryptedAccessToken  String?
  encryptedRefreshToken String
  scopes            Json                  @default("[]") // scopes concedidos realmente, auditable
  connectedByUserId String                // quién autorizó (User.id, sin @relation, mismo patrón que ownerId en Lead)
  lastSyncAt        DateTime?
  lastError         String?
  createdAt         DateTime              @default(now())
  updatedAt         DateTime              @updatedAt
}
```

**`EmailMessage`** — sí es necesario, y aquí F4.7 **sí** difiere del precedente de F4 (§5.2 de `F4_AUTONOMOUS_OUTREACH_PLAN.md`, que explícitamente decidió no crear un modelo de mensaje porque todo vivía en `AgentTask.output`/`ApprovalRequest.proposedAction`/`Activity`). La diferencia real: F4 nunca enviaba nada de verdad, así que no existía un "Message-ID" real de un sistema externo que rastrear, ni un estado de entrega/rebote que sincronizar con reintentos. F4.7 sí — hace falta un lugar único para el `Message-ID`/`threadId` real de Gmail, idempotencia de envío (§Seguridad), y el estado sincronizado del draft/envío, sin forzarlo dentro de `AgentTask.output` (que es de solo un `AgentTask`, no sobrevive a reintentos ni a la lectura de respuestas días después).

```prisma
enum EmailMessageStatus {
  DRAFT_CREATED     // draft creado en Gmail, no enviado
  PENDING_SEND      // aprobado para envío, en cola de guardias (límite diario/dominio)
  SENT
  FAILED
  BOUNCED
}

model EmailMessage {
  id                String             @id @default(cuid())
  tenantId          String
  contactId         String
  contact           Contact            @relation(fields: [contactId], references: [id])
  companyId         String
  company           Company            @relation(fields: [companyId], references: [id])
  campaignCompanyId String?            // si vino de una secuencia de campaña (F4) — nullable, no todo email es de campaña
  agentTaskId       String             // qué AgentTask lo redactó (personalizeMessage extendido, §5)
  approvalRequestId String             @unique // 1:1 — cada ApprovalRequest de tipo email tiene a lo sumo un EmailMessage
  approvalRequest   ApprovalRequest    @relation(fields: [approvalRequestId], references: [id])
  subject           String
  body              String
  status            EmailMessageStatus @default(DRAFT_CREATED)
  gmailDraftId      String?            // id del draft en la API de Gmail
  gmailMessageId    String?            // Message-ID real, una vez enviado
  gmailThreadId     String?            // para matchear respuestas (F4.5 §9), nunca leer toda la bandeja
  idempotencyKey    String             @unique // generado antes del primer intento de envío — evita duplicados en reintentos
  sentAt            DateTime?
  bouncedAt         DateTime?
  createdAt         DateTime           @default(now())

  @@index([tenantId, status])
  @@index([gmailThreadId])
}
```

`Contact`/`Company`/`ApprovalRequest` ganan el lado inverso de la relación (`emailMessages EmailMessage[]`) — mecánica de Prisma, no una capacidad nueva.

**Explícitamente NO se crea** un modelo `EmailReply`/`Conversation` separado: una respuesta leída se persiste como `Activity` (mismo patrón que F4 §15 ya estableció para `classifyConversation`, `EmailMessage.gmailThreadId` es suficiente para encontrar el hilo).

---

## 5. Contact Intelligence Agent — ampliación

**No se crea un cuarto agente** (`email_intelligence` como `agentKey` separado) — se amplía `contact_intelligence`, tal como pide el punto §5 del pedido ("Amplía el agente existente"). Nuevo tool, mismo agente:

```
packages/agents/src/tools/contact-intelligence-tools.ts
  + findEmailInputSchema  { companyId, contactId? }  // contactId opcional: si no se pasa, procesa todos los Contact sin email de esa Company
  + findEmailOutputSchema { emailsFound, emailsVerified, contactsUpdated, sourcesUsed, patternsFailed }
```

Flujo de `findEmail` (nuevo tool, ejecutado como `AgentTask` propio, `type: "find_email"`, igual patrón que `find_contacts`):

1. Recibe `companyId` (y opcionalmente `contactId` puntual).
2. Corre Website Intelligence (§1) sobre `Company.website` si no se corrió antes para esta Company en los últimos N días (cache simple por `Company.lastVerifiedAt`-style, evita re-scrapear el mismo sitio en cada misión).
3. Para cada `Contact` de esa Company sin `email` o con `emailVerificationStatus = NOT_VERIFIED`: intenta email público del website (match por nombre) → si no, consulta el proveedor aprobado (§2) → si no, `NOT_FOUND`.
4. Cualquier email encontrado (de cualquier fuente) se verifica (§3) antes de persistirse con un status distinto de `NOT_VERIFIED`.
5. Actualiza `Contact` respetando la regla de no-downgrade (§4.2).
6. Registra `AgentTask` (`find_email`) + `AuditLog` (`contact.email_found_by_agent`/`contact.email_verified_by_agent`) — mismo patrón exacto que `contact.discovered_by_agent` de F4.6.
7. El `AgentTask.output` explica fuente y confianza de cada email tocado — igual que F4.6 ya hace con `DiscoveredField` por campo.

**Nunca envía nada.** `findEmail` es una tool de solo enriquecimiento, exactamente igual de "read-only hacia afuera" que `findContacts` — la frontera de envío sigue siendo exclusivamente el Outreach Agent + `ApprovalRequest` (§6).

### 5.1 Integración en el pipeline de misión

```
CEO Agent → Discovery (discover_companies)
    → por cada Company nueva: Contact Intelligence (find_contacts)
        → por cada Company con contactos nuevos: Contact Intelligence (find_email)   ← NUEVO, F4.7
    → Sales Review (select_target_companies)
    → Outreach (planSequence → personalizeMessage, extendido para exigir Contact+email VERIFIED, §6)
```

Mismo punto de inserción que F4.6 usó (`mission-orchestrator.ts`, dentro del loop de `newCompanyIds`, ahora con un segundo `createAndRunTaskSync` encadenado tras `find_contacts`).

---

## 6. Gmail / Google Workspace

### 6.1 Arquitectura

`MailProvider` — interfaz genérica (análoga a `LLMProvider` de F2, ya anticipada en F4.5 §7), implementada primero solo por `GmailProvider` (Microsoft Graph queda documentado como alternativa intercambiable futura, fuera de alcance de F4.7 salvo que la agencia use Microsoft 365 en vez de Google Workspace — a confirmar, ver Bloqueantes).

```
apps/api/src/modules/mail/
  provider.ts          — interfaz MailProvider (createDraft, sendDraft, listRepliesInThread, ...)
  gmail.provider.ts     — implementación real vía googleapis (Gmail API)
  oauth.ts              — flujo OAuth 2.0: authUrl, exchangeCode, refreshAccessToken
  token-encryption.ts   — AES-256-GCM sobre encryptedAccessToken/encryptedRefreshToken
  router.ts             — GET /mail/connect (inicia OAuth), GET /mail/callback, POST /mail/disconnect, GET /mail/status
```

### 6.2 OAuth 2.0 — sin contraseñas, sin credenciales en código

- Scopes mínimos necesarios: `gmail.compose` (crear/enviar drafts — más acotado que `gmail.send` puro, ya que además permite gestionar el draft antes de enviarlo) + `gmail.readonly` (leer respuestas, §9). **Nunca** `gmail.modify` completo ni `https://mail.google.com/` (scope total) — principio de mínimo privilegio pedido explícitamente.
- **CSRF/state**: el `state` param de OAuth se genera con `crypto.randomBytes`, se persiste server-side (tabla de sesión temporal o firmado con HMAC + expiración corta) y se valida byte-a-byte en el callback antes de intercambiar el código — previene que un callback de OAuth ajeno sea aceptado.
- **PKCE** además del `state`, por defensa en profundidad (recomendado por Google incluso para server-side apps).
- **Nueva dependencia**: `googleapis` (paquete oficial de Google, MIT license, gratis — no es un "proveedor pago", es un cliente HTTP tipado).
- **Credencial requerida (bloqueante, ver sección final):** un proyecto de Google Cloud con una pantalla de consentimiento OAuth y un "OAuth 2.0 Client ID" (tipo *Web application*) — **esto no lo puedo crear yo**, requiere acceso a Google Cloud Console de la organización dueña del dominio de Workspace. Variables de entorno resultantes: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`.
- **Nota sobre modo "Testing" de Google Cloud:** mientras la app OAuth no pase por verificación de Google (proceso que puede tardar días/semanas si se piden scopes sensibles), solo funciona en modo "Testing" con una lista explícita de usuarios de prueba, y los `refresh_token` pueden expirar cada 7 días. Para el piloto (§14, volumen mínimo) esto **alcanza y es preferible** — evita someter la app a revisión de Google antes de validar que el flujo funciona con datos reales. Se documenta como limitación conocida del piloto, igual que Overpass lo fue en F4.5A.

### 6.3 Cifrado en reposo

- `TOKEN_ENCRYPTION_KEY` (nueva variable de entorno, 32 bytes en base64, generada una vez con `openssl rand -base64 32`) — clave simétrica AES-256-GCM. **Nunca se loguea, nunca se imprime** (mismo principio ya aplicado estrictamente a `PEOPLEDATALABS_API_KEY` durante F4.6).
- `token-encryption.ts` expone únicamente `encrypt(plaintext): string` / `decrypt(ciphertext): string` — ningún otro módulo del proyecto toca el token en claro salvo en el instante de la llamada real a la API de Gmail.

### 6.4 Draft ↔ CRM

Cada `EmailMessage` (§4.3) asocia el draft con `Contact`/`Company`/`campaignCompanyId` (si aplica)/`agentTaskId`/`approvalRequestId` — exactamente los 6 vínculos pedidos (Lead se deriva vía `Company` → `Lead`, no hace falta un campo extra: un `Lead` ya se relaciona con `Company`, y `EmailMessage` ya tiene `companyId`).

### 6.5 Flujo del primer corte (dos gates, no uno)

```
Outreach Agent: personalizeMessage (extendido, §6.6)
    → ApprovalRequest #1 ("aprobar el contenido del borrador")
    → Humano aprueba
    → Sistema crea el DRAFT real en Gmail (reversible — vive en la
      carpeta Drafts de la cuenta conectada, el humano puede seguir
      editándolo/borrándolo directamente en Gmail antes de que nada
      se envíe) — EmailMessage.status = DRAFT_CREATED
    → (separado, explícito) Humano decide enviar
    → ApprovalRequest #2 ("aprobar el ENVÍO real de este draft
      específico") — riskLevel HIGH, nunca agrupable en batch
      silencioso
    → Guardias de envío (§7) se evalúan recién acá: límite diario,
      límite por dominio, email VERIFIED, no en suppression list
    → Solo si todos los guardias pasan → sendDraft real vía Gmail API
    → EmailMessage.status = SENT, gmailMessageId/threadId persistidos
```

**Por qué dos gates y no uno:** el pedido dice explícitamente "el agente prepara el mensaje; crea ApprovalRequest; el humano aprueba; **solo después** puede crearse o enviarse el draft según la política aprobada" — la ambigüedad entre "crear" y "enviar" se resuelve separándolos: aprobar el *contenido* es reversible y de bajo riesgo (un draft en Gmail no le llega a nadie); aprobar el *envío* es irreversible y de alto riesgo. Colapsarlos en un solo clic violaría el espíritu de "sin envío autónomo masivo" y el límite de "3 correos reales enviados únicamente tras aprobación explícita del Product Owner" del DoD (§14) — con un solo gate, ese límite no tendría un punto de control distinto del gate de contenido.

### 6.6 `personalizeMessage` — extensión mínima (no una reescritura)

Hoy (`outreach-tools.impl.ts:126`) `personalizeMessage` opera sobre `campaignCompanyId` sin destinatario. Se extiende para:
1. Resolver el `Contact` destinatario: el de mayor `confidenceScore` con `emailVerificationStatus = VERIFIED` y `doNotContact = false` entre los `Contact` de esa `Company`, priorizando `decisionRole` según el mismo orden de F4.6 (`PRIORITY_TITLES`). **Si ningún `Contact` de la empresa tiene un email `VERIFIED`, la tool no crea `ApprovalRequest` de tipo email** — devuelve `blockedReason: "no hay contacto con email verificado"` (nunca se envía a un email `RISKY`/`UNKNOWN`/inferido).
2. `proposedAction` gana `contactId`, `contactName`, `recipientEmail` (además de los campos ya existentes) — cambio aditivo del Json, no requiere migración.
3. Al crear el `ApprovalRequest`, también crea el `EmailMessage` en estado `DRAFT_CREATED`-pendiente (aún sin llamar a Gmail — el draft real en Gmail se crea recién cuando se aprueba, §6.5).

---

## 7. Envío controlado

Guardias, todos evaluados **antes** de cualquier llamada real a `sendDraft` (nunca después):

| Guardia | Regla | Dónde vive (configurable) |
|---|---|---|
| Límite diario | Máx. 10 envíos/día (piloto) | `Tenant.settings.dailyEmailSendLimit`, default 10 — mismo patrón que `aiMonthlyBudgetUsd` |
| Límite por dominio | Máx. 1 envío inicial por dominio de destino por día | Calculado sobre `EmailMessage` enviados hoy agrupados por dominio del `Contact.email` — no configurable por ahora (es una regla de higiene de reputación, no un límite de negocio) |
| Solo `VERIFIED` | Un email `RISKY`/`UNKNOWN`/`INVALID`/`NOT_VERIFIED` nunca puede ser destinatario de un envío real | Enforced en código, no solo en UI — el endpoint de envío revalida server-side aunque el frontend ya lo filtre |
| Aprobación explícita | Cada envío requiere su propio `ApprovalRequest` de tipo "enviar" decidido individualmente (§6.5) — "aprobación... individual o por lote pequeño" del pedido se resuelve como: el humano puede seleccionar varios `ApprovalRequest` de envío pendientes y decidirlos en una sola acción de UI, pero cada uno sigue siendo su propia fila auditada, nunca un "aprobar todo" ciego | UI: checkbox múltiple + un solo botón "Aprobar seleccionados", backend: N llamadas a `decideApproval`, no una nueva ruta de aprobación masiva |
| Sin adjuntos | El schema de `EmailMessage`/`proposedAction` no tiene campo de adjunto — no se agrega la capacidad, ni siquiera oculta | Ausencia de campo = imposible, no una validación que se pueda saltear |
| Sin enlaces engañosos | Regla de prompt para `personalizeMessage` (igual que F2 §14 ya prohíbe prometer precios): el LLM no puede incluir URLs que no sean el sitio propio del tenant o el link de opt-out — validado con una regex simple post-generación que rechaza cualquier `http(s)://` que no matchee la allowlist (dominio del tenant + link de unsubscribe generado por el sistema) | Validación determinista en código, no solo instrucción al LLM |
| Identificación clara del remitente | El pie de cada mensaje generado incluye el nombre comercial que el PO configure (todavía sin decidir — ver Bloqueantes B5) — plantilla de firma fija, no generada por el LLM, 100% configurable por tenant, nunca hardcodeada en el código | `Tenant.settings.senderIdentity` |
| Opt-out | Cada mensaje incluye una línea de opt-out con instrucción clara ("responder BAJA/UNSUBSCRIBE") — plantilla fija, igual que la firma | Mismo mecanismo |
| Registro | `EmailMessage.gmailMessageId`, `sentAt`, `status` — ya cubierto por el modelo (§4.3) | — |

Toda política (`dailyEmailSendLimit`, `senderIdentity`, dirección postal, etc.) vive en `Tenant.settings` — configurable por tenant sin cambio de schema, mismo mecanismo que `aiMonthlyBudgetUsd`/`dataProviderBudgetUsd` ya establecieron.

---

## 8. Deliverability

Nueva página `apps/web/src/pages/EmailDeliverability.tsx` (o sección dentro de Settings) — **de verificación, no de configuración de DNS** (el sistema no puede modificar los registros DNS del dominio de la agencia, eso lo hace el PO en su proveedor de DNS):

| Chequeo | Cómo se verifica (real, no afirmado) |
|---|---|
| SPF | Query DNS real (`TXT` sobre el dominio del remitente) vía el resolver de Node (`dns.promises.resolveTxt`) — se busca un registro que empiece con `v=spf1` y se muestra tal cual, sin interpretarlo como "correcto" u "incorrecto" más allá de "existe" / "no existe" / "existe pero no incluye los servidores de Google" (chequeo simple: contiene `include:_spf.google.com`) |
| DKIM | Query DNS real del selector de DKIM de Google Workspace (`google._domainkey.<dominio>`, `TXT`) — igual criterio, solo reporta lo que existe |
| DMARC | Query DNS real (`_dmarc.<dominio>`, `TXT`) — reporta la política (`p=none`/`quarantine`/`reject`) tal cual está, **nunca la cambia** |
| Dominio de envío / From Name / Reply-To | Leídos de `Tenant.settings`, editables por un humano con `settings.manage` |
| Límites diarios / rebotes / suppression list | Agregaciones reales sobre `EmailMessage`/`Contact` (conteo de `SENT` hoy, `BOUNCED`, `doNotContact = true`) |
| Salud de la cuenta | Estado de `GmailConnection` (`CONNECTED`/`ERROR`/`REVOKED`) + `lastSyncAt`/`lastError` |

**Nunca se afirma "SPF/DKIM/DMARC están correctos" sin haber hecho la query DNS real en el momento de mostrarlo** — mismo principio "nunca inventar" aplicado a infraestructura de dominio en vez de a datos de negocio. Si la query falla (timeout, dominio mal configurado), se muestra el error real, no un check verde por defecto.

---

## 9. Respuestas e inbox

`listRepliesInThread(gmailThreadId)` (parte de `MailProvider`, §6.1) — usa `gmail.readonly`, filtra por `threadId` de un `EmailMessage` ya enviado (nunca lee la bandeja completa, mismo alcance limitado ya documentado en F4.5 §9).

Job periódico (mismo scheduler in-process ya extendido en F3/F4, un sub-paso más): cada corrida revisa `EmailMessage` con `status = SENT` sin respuesta clasificada todavía, busca mensajes nuevos en su `gmailThreadId`, y si encuentra uno:

1. Persiste el texto como `Activity` (`type: EMAIL`, `entityType: "contact"`, `performedByAgentId`: el `AgentInstance` del Conversation Agent — a diferencia de F4 §15, acá `performedById` humano no aplica porque nadie lo pegó a mano).
2. Llama a `classifyConversation` (Conversation Agent, F4, **sin cambios de lógica**) con el vocabulario **ampliado** (pedido explícito del usuario, 10 categorías en vez de las 7 de F4):

   `VERY_INTERESTED · INTERESTED · CALL_LATER · HAS_PROVIDER · NO_BUDGET · NOT_INTERESTED · OUT_OF_MARKET · UNSUBSCRIBE · AUTO_REPLY · BOUNCE`

   `ConversationIntent` (enum de F4) se extiende de forma aditiva con `UNSUBSCRIBE`/`AUTO_REPLY`/`BOUNCE` — mismo mecanismo Postgres (`ALTER TYPE ... ADD VALUE`) ya usado dos veces (F4.5→F4.6 en `ContactDecisionRole`).
3. Acciones por categoría (reutilizando el árbol de decisión de `suggestNextStep`, F4 §16, extendido):
   - `UNSUBSCRIBE` → `Contact.doNotContact = true` inmediato (no espera el plazo de 10 días hábiles de CAN-SPAM — se aplica en el momento de detectarlo, igual de conservador que F4.5 §14 ya documentaba) + se agrega a la lista de supresión (derivada, §4.1) + `Activity`.
   - `BOUNCE` → `Contact.bouncedAt = now()`, `EmailMessage.status = BOUNCED`, el email de ese `Contact` nunca vuelve a ser candidato de envío automático (`emailVerificationStatus` no cambia — el rebote no significa que el verifier se equivocó, puede ser un rebote temporal de buzón lleno, pero por seguridad se trata iigual de estricto).
   - `AUTO_REPLY` → se registra la `Activity`, no se actualiza `lastIntent`/estado de campaña (un autoresponder de vacaciones no es una señal de interés real).
   - Resto de categorías → mismo árbol ya existente de `suggestNextStep` (F4 §16), sin cambios.
4. **No responde automáticamente.** Si la clasificación sugiere una respuesta (ej. `CALL_LATER` con una pregunta), el Conversation Agent puede *proponer* un texto de respuesta (mismo patrón híbrido D8 que `personalizeMessage`) pero **siempre termina en un nuevo `ApprovalRequest`**, nunca en un envío automático — pedido explícito del usuario ("proponer una respuesta mediante ApprovalRequest").

---

## 10. Interfaz

| Pantalla | Contenido nuevo |
|---|---|
| **Contact Detail** (hoy no existe una página dedicada — `Contact` solo aparece embebido en `CompanyDetail`/`Contacts.tsx`; se agrega el detalle expandido dentro de la fila/drawer ya existente, no una ruta nueva) | Email, `emailSource`/`emailSourceUrl` (link a la fuente real), `emailVerificationStatus` (badge, mismo patrón `cva` que `verificationStatus` de F4.6 ya usa), `emailConfidenceScore`, `emailVerifiedAt`, toggle de `doNotContact` (solo lectura para la mayoría de roles, editable con `contacts.update`) |
| **Email Intelligence Dashboard** (nueva sección, dentro de `AIDashboard.tsx` extendido — mismo criterio que F4 §17 aplicó a Campaigns: "se extiende, no se crea un dashboard nuevo") | Contactos consultados, emails encontrados, emails verificados (por estado: VERIFIED/RISKY/INVALID/UNKNOWN), cobertura por proveedor (% de Website Intelligence vs. Hunter), costo por email `VERIFIED` (= gasto total de `find_email`+`verify_email` ÷ cantidad de `VERIFIED` — mismo criterio de "costo real, no estimado" ya aplicado al costo por lead en F3.5), créditos consumidos del proveedor de verificación |
| **Approvals** (`apps/web/src/pages/Approvals.tsx`, existente — extendido) | Para `ApprovalRequest` de tipo email: preview completo (asunto + cuerpo formateado, no JSON crudo), destinatario (nombre + `recipientEmail`), empresa, fuente del correo (`emailSource`), `emailVerificationStatus` (badge visible antes de aprobar — un aprobador nunca debería aprobar a ciegas un email `RISKY`), botones Aprobar/Editar/Rechazar (Editar ya existe conceptualmente en F2 — el humano puede modificar `proposedAction.body` antes de aprobar) |
| **Gmail Connection** (nueva página, `apps/web/src/pages/MailConnection.tsx`, bajo Settings) | Estado OAuth (`GmailConnectionStatus`), cuenta conectada (`emailAddress`), último sync (`lastSyncAt`), errores (`lastError`), botón "Conectar cuenta de Google Workspace" (inicia el flujo OAuth) / "Desconectar" (revoca, ver §Seguridad) |

---

## 11. Presupuesto y créditos

Se extiende `data-provider-budget.ts` (ya separa Google Places + People Data Labs del presupuesto de IA) con dos `type` nuevos de `AgentTask`:

```ts
const DATA_PROVIDER_TASK_TYPES = [
  "discover_companies",
  "find_contacts",
  "find_email",     // F4.7: Website Intelligence + proveedor de discovery de email
  "verify_email",   // F4.7: proveedor de verificación
] as const;
```

**Mismo presupuesto único de "gasto de proveedores de datos"** (`Tenant.settings.dataProviderBudgetUsd`, ya existente) — no se propone un cuarto guardia separado; el criterio ya documentado en F4.6 ("un solo presupuesto para todo lo que no es LLM, no vale la pena un guardia por proveedor individual todavía") sigue aplicando. Se revisará si hace falta separar cuando el volumen real lo justifique.

Costo real (no estimado) mostrado en el Email Intelligence Dashboard (§10), igual que Discovery/Contact Intelligence ya hacen — `costUsd` real de cada `AgentTask`, nunca una proyección presentada como hecho.

El costo de **envío** (Gmail API) es $0 adicional — ya incluido en la licencia de Workspace que la agencia ya paga (mismo dato que F4.5 §15 ya documentaba).

---

## 12. Seguridad

| Punto del pedido | Cómo se cumple |
|---|---|
| No exponer API keys ni OAuth tokens | Mismo patrón ya probado en F4.6 (`PEOPLEDATALABS_API_KEY` nunca impreso/logueado) — se extiende literalmente a `HUNTER_API_KEY`, `GOOGLE_OAUTH_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY` |
| Tokens cifrados en reposo | AES-256-GCM, `token-encryption.ts` (§6.3) — `GmailConnection.encryptedAccessToken`/`encryptedRefreshToken` nunca en texto plano en la base |
| Nunca imprimir secretos | Regla de proceso, igual que F4.6 — ningún `console.log`/log estructurado incluye el valor de un token o API key, solo su presencia/longitud cuando haga falta diagnosticar |
| OAuth con scopes mínimos | `gmail.compose` + `gmail.readonly` únicamente (§6.2) — nunca el scope completo de Gmail |
| Protección CSRF/state en OAuth | `state` aleatorio + validado + PKCE (§6.2) |
| Revocación de conexión | `POST /mail/disconnect` — revoca el token vía la API de Google (`https://oauth2.googleapis.com/revoke`) y marca `GmailConnection.status = REVOKED`, no solo borra la fila local (un token revocado localmente pero no en Google seguiría siendo válido si se filtrara) |
| Idempotencia en envío | `EmailMessage.idempotencyKey` (`@unique`) generado antes del primer intento — un reintento de red usa la misma key; el endpoint de envío hace `upsert`/chequea existencia antes de llamar a `sendDraft` de nuevo |
| Evitar envíos duplicados por reintentos | Consecuencia directa de la idempotencia — nunca se llama `sendDraft` dos veces para el mismo `EmailMessage.id` |
| Suppression list obligatoria | Derivada de `Contact` (§4.1), consultada en el guardia de envío (§7) sin excepción, antes de cada llamada real |

---

## 13. Cumplimiento (CAN-SPAM)

Los 6 puntos de F4.5 §14 (ya documentados en la fase de planificación anticipada) se implementan literalmente acá, con la pieza real que faltaba (dirección postal):

1. **Identificación veraz** — estructural (se envía desde la cuenta real conectada vía OAuth, nunca un header falsificado).
2. **Asunto no engañoso** — regla de prompt + validación determinista (mismo criterio que enlaces engañosos, §7).
3. **Dirección postal real** — `Tenant.settings.businessAddress` (nuevo campo dentro del Json existente, no una columna) — **bloqueante de dato real, ver sección final**: hace falta que el PO provea la dirección comercial real y el nombre comercial definitivo, todavía no decidido.
4. **Opt-out claro, honrado en el momento** — §9 (`UNSUBSCRIBE` se aplica de inmediato, no espera los 10 días hábiles del mínimo legal).
5. **Cuenta que recibe respuestas** — estructural (Gmail real, no un remitente no-reply).
6. **Registro de opt-outs** — `Contact.doNotContact`/`unsubscribedAt`, consultable, es el registro legal.

Adicional, específico del pedido de esta fase:
- **No automatizar LinkedIn** — F4.7 no toca LinkedIn en ningún punto (Website Intelligence solo lee el sitio propio de cada empresa; ningún proveedor de esta fase interactúa con LinkedIn más allá de leer una URL de perfil ya guardada por F4.6, que ya era de solo lectura).
- **No usar datos inventados** — cubierto transversalmente por §2.2, §4.2, y el vocabulario cerrado de §3.1.
- **No volver a contactar a quien se excluyó** — suppression list (§4.1) consultada sin excepción antes de cualquier envío o incluso antes de que `personalizeMessage` cree un `ApprovalRequest` (evita que un humano apruebe por error un borrador que nunca debería haberse generado).
- **Retención de evidencia** — `EmailMessage`, `Activity`, `AuditLog` ya persisten todo de forma permanente (ninguna fase anterior implementó borrado automático de estos registros).

---

## 14. Definition of Done

- [ ] Al menos 5 empresas reales procesadas por Website Intelligence (`find_email`)
- [ ] Al menos 3 `Contact` con `email` real encontrado (`emailVerificationStatus != NOT_VERIFIED`), con `emailSource`/`emailSourceUrl` exactos
- [ ] Verificación real de esos emails contra el proveedor elegido (§3), estados reales (`VERIFIED`/`RISKY`/`INVALID`/`UNKNOWN`), nunca fabricados
- [ ] Ningún email inventado por patrón (§2.2) — auditable revisando que todo `Contact.email` tenga `emailSource` no nulo
- [ ] `GmailConnection` conectado mediante OAuth 2.0 real, con una cuenta de Google Workspace real
- [ ] Al menos un draft real creado y visible en la carpeta Drafts de esa cuenta (verificable manualmente en Gmail, no solo en la base de datos)
- [ ] `ApprovalRequest` de contenido Y `ApprovalRequest` de envío (dos gates, §6.5), ambos decididos explícitamente por un humano
- [ ] Piloto de máximo 3 correos reales enviados, únicamente tras aprobación explícita del Product Owner (mensaje/decisión registrada, no solo un clic en la UI — se documentará la conversación de aprobación igual que se documentó la elección de proveedor en F4.6)
- [ ] Respuestas o estados sincronizados cuando existan (al menos una prueba de lectura de hilo real, aunque sea una respuesta de prueba del propio PO)
- [ ] `doNotContact`/suppression list probado con al menos un caso real (opt-out de prueba) que efectivamente bloquee un envío posterior
- [ ] Ningún envío duplicado — probado forzando un reintento sobre un `EmailMessage` ya `SENT` y confirmando que no se llama `sendDraft` de nuevo
- [ ] Costos y créditos reales registrados y visibles en el Email Intelligence Dashboard (nunca una estimación presentada como hecho)
- [ ] `pnpm typecheck` limpio en todo el monorepo
- [ ] `pnpm lint` limpio
- [ ] Suite de tests completa pasando (incluye los tests nuevos de F4.7, sin mocks para las llamadas reales, mismo estándar que F4.5/F4.6)
- [ ] Verificación en navegador real vía Playwright, sin errores de consola
- [ ] F0–F4.6 intactos — ningún test existente se modifica ni se rompe (mismo estándar ya sostenido en cada fase previa)

---

## Bloqueantes reales — detenido, a la espera de resolución antes de escribir código funcional

Seis bloqueantes concretos, cada uno con la información pedida explícitamente (proveedor, endpoint, precio, free tier, datos entregados, limitaciones, variable de entorno):

### B1 — Proveedor de email discovery — ✅ RESUELTO (aprobado por el PO)
- **Decisión:** Hunter.io, free tier (25 búsquedas de dominio/mes, sin tarjeta de crédito) — $0 para el piloto. Escalar a plan pago requiere una aprobación explícita nueva, separada de esta, si el free tier no alcanza.
- **Endpoint:** `GET https://api.hunter.io/v2/domain-search?domain=<dominio>&api_key=<key>`
- **Precio (si se escala):** plan pago desde ~$34–49/mes (a verificar contra `hunter.io/pricing` antes de contratar, mismo criterio ya aplicado a Google Places/PDL)
- **Datos entregados:** emails indexados públicamente por dominio, con nombre/cargo/confianza cuando el proveedor los tiene, tipo de patrón detectado (informativo, no se persiste como email inferido, ver §2.2)
- **Limitaciones:** cobertura depende de qué tan indexado esté el dominio; puede no tener nada para una PyME chica (resultado honesto `NOT_FOUND`, no un error)
- **Variable de entorno requerida:** `HUNTER_API_KEY`

### B2 — Proveedor de email verification — ✅ RESUELTO (aprobado por el PO)
- **Decisión:** verifier de Hunter.io (mismo vendor que B1) — **no requiere una segunda credencial**, mismo `HUNTER_API_KEY`, incluido en el mismo free tier (50 verificaciones/mes).
- **Endpoint:** `GET https://api.hunter.io/v2/email-verifier?email=<email>&api_key=<key>`
- Alternativas (NeverBounce/ZeroBounce) quedan documentadas en §3.2 como reemplazo intercambiable futuro si Hunter no alcanza, detrás del mismo contrato (`email-verification-providers/`) — no se contratan ahora.

### B3 — Credencial OAuth de Google Cloud (bloqueante duro, no puedo resolverlo yo)
- **Proveedor:** Google Cloud Console (gratis crear el proyecto y el OAuth Client — no es un "proveedor pago", es infraestructura de identidad)
- **Qué hace falta que el PO haga:** crear (o confirmar que ya existe) un proyecto de Google Cloud vinculado al dominio de Workspace de la agencia, habilitar la Gmail API, configurar la pantalla de consentimiento OAuth (modo "Testing" alcanza para el piloto, §6.2), y crear un "OAuth 2.0 Client ID" tipo *Web application* con el redirect URI que le indique (`http://localhost:4000/api/v1/mail/callback` en dev).
- **Variables de entorno resultantes:** `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`
- **Limitación conocida:** en modo "Testing", el usuario que autoriza debe estar en la lista de "test users" del proyecto, y el `refresh_token` puede expirar cada 7 días — aceptable para el piloto, documentado como limitación real (mismo criterio que Overpass en F4.5A).

### B4 — Clave de cifrado de tokens
- No es un proveedor — es un valor que yo puedo generar (`openssl rand -base64 32`), pero **el PO debe confirmar dónde se almacena de forma segura** (mismo `.env` local que ya usa `PEOPLEDATALABS_API_KEY`, con el mismo cuidado de nunca commitearlo — a confirmar que ese es el criterio aceptado también para esta clave, dado que cifra datos más sensibles que una API key de terceros).
- **Variable de entorno:** `TOKEN_ENCRYPTION_KEY`

### B5 — Dirección postal comercial y nombre comercial (CAN-SPAM, §13.3) — parcialmente resuelto (2026-07-11)
- **Nombre comercial: ✅ RESUELTO.** Marca `DreiStaff`, dominio `dreistaff.com`, entidad legal propietaria `Data More LLC` — decisión definitiva del PO (2026-07-11). Configurado en `BUSINESS_BRAND_NAME`/`BUSINESS_LEGAL_NAME`/`BUSINESS_DOMAIN`/`APP_DOMAIN` (ver `apps/api/src/core/env.ts` + `apps/api/src/core/branding.ts`, única fuente de verdad — nunca hardcodeado en otro archivo, overridable por `Tenant.settings.branding` para el caso multi-tenant).
- **Dirección postal comercial: ⏳ SIGUE PENDIENTE.** El PO fue explícito: no inventarla todavía — `BUSINESS_POSTAL_ADDRESS` queda sin default, `null` hasta que la configure.
- **`OUTREACH_FROM_EMAIL`/`OUTREACH_REPLY_TO`: ⏳ SIGUEN PENDIENTES**, mismo motivo — sin default, `null` hasta configurar. Correos sugeridos (documentados, ninguno creado ni habilitado): `admin@dreistaff.com`, `sales@dreistaff.com`, `recruiting@dreistaff.com`, `support@dreistaff.com`, `outreach@dreistaff.com` — preferencia del PO para el piloto: `outreach@dreistaff.com`, pendiente de que confirme la cuenta real y la configuración DNS antes de habilitarlo.
- Sigue bloqueando CAN-SPAM §13.3 y cualquier envío real (no bloquea Website Intelligence/discovery/verification, que no envían nada — por eso esas tres piezas ya están implementadas).

### B6 — Acceso/confirmación de DNS del dominio de envío (§8) — parcialmente resuelto (2026-07-11)
- **Dominio de marca: ✅ RESUELTO.** `dreistaff.com` — nunca `data-more.com` (la entidad legal `Data More LLC` no es ni el dominio público ni el dominio de envío, ver addendum de branding).
- **Subdominio de envío dedicado: ⏳ SIGUE PENDIENTE**, decisión explícita del PO: para el piloto inicial (máximo 3 correos reales de prueba, aprobación individual, solo `VERIFIED`) se usaría `dreistaff.com` directamente, **sin** subdominio — evaluar `mail.dreistaff.com` u `outreach.dreistaff.com` recién antes de escalar volumen, y no implementarlo sin aprobación explícita nueva.
- **SPF/DKIM/DMARC/OAuth Client ID/Secret: ⏳ SIGUEN PENDIENTES** — nada de esto se verifica ni se configura todavía. No se conecta ninguna cuenta de Gmail ni se envía ningún correo real hasta que estén: cuenta de Google Workspace en `dreistaff.com`, correo de envío confirmado, dirección postal, SPF, DKIM, DMARC, OAuth Client ID/Secret, Reply-To.

---

## Regla de implementación (recordatorio, tal como la dio el usuario)

No se selecciona ningún proveedor pago ni se genera ningún gasto sin aprobación explícita. No se escribe código funcional de F4.7 hasta que:
1. Este documento reciba aprobación explícita, y
2. Los bloqueantes B1–B6 tengan una respuesta (aunque sea "usar el free tier, sin costo" para B1/B2, y los datos reales para B3–B6).

**Este documento es de planificación. No se contrata Hunter.io, no se conecta ninguna cuenta de Gmail, y no se escribe código de esta fase hasta recibir esa aprobación.**

---

## Addendum 1 — implementación real (2026-07-10)

**Alcance de este corte:** el PO aprobó B1/B2 (Hunter.io free tier para discovery y verification) y pidió avanzar **únicamente** con §1 (Website Intelligence), §2 (email discovery: website + Hunter.io) y §3 (email verification: Hunter.io) — explícitamente **sin** tocar dominio, marca, Gmail OAuth ni envío (B3/B5/B6 siguen abiertos; el nombre comercial del staffing todavía no está decidido). §6–§14 de este documento (Gmail, envío controlado, deliverability, inbox, cumplimiento de envío) **siguen siendo planificación, no implementación** — nada de esa parte se construyó en este corte.

### Qué se implementó (real, sin mocks)

- **Website Intelligence** (`apps/api/src/modules/agents/tools/website-intelligence/`) — crawler propio (`cheerio` + `robots-parser`, ambas dependencias nuevas gratuitas/MIT), límites duros tal como se documentó en §1.2 (profundidad 2, máx. 6 páginas, timeout 10s, 1 reintento, tope 2MB/página, robots.txt siempre respetado, rate limit 500ms/dominio, User-Agent identificable y **configurable** vía `WEBSITE_INTELLIGENCE_CONTACT_EMAIL` — sin marca hardcodeada).
- **`email-providers/`** (`types.ts`, `website-public-email.ts`, `hunter.ts`) y **`email-verification-providers/`** (`types.ts`, `hunter.ts`) — mismo patrón exacto que `discovery-providers/`/`contact-providers/` de F4.5/F4.6, con sus `README.md`.
- **Contact Intelligence Agent ampliado** con un tool nuevo, `findEmail` (`type: "find_email"` en `AgentTask`) — Website Intelligence primero (gratis), Hunter.io Domain Search como respaldo (solo si hace falta, cuidando el free tier), verificación real de cada email encontrado antes de persistir cualquier estado distinto de `NOT_VERIFIED`, regla de no-downgrade (nunca sobrescribe un email `VERIFIED`).
- **Schema** — migración `20260710235855_f4_7_email_intelligence`, 100% aditiva: `EmailVerificationStatus` (enum nuevo) + 11 columnas nuevas en `Contact` (`emailSource`, `emailSourceUrl`, `emailDiscoveryProvider`, `emailVerificationProvider`, `emailVerificationStatus`, `emailConfidenceScore`, `emailDiscoveredAt`, `emailVerifiedAt`, `doNotContact`, `bouncedAt`, `unsubscribedAt`). Sin `GmailConnection`/`EmailMessage` todavía (§4.3 — corresponden a §6, fuera de este corte).
- **Pipeline de misión** (`mission-orchestrator.ts`) — `find_email` corre automáticamente justo después de `find_contacts`, por cada Company nueva, antes de `select_target_companies` — mismo punto exacto que documenta §5.1.
- **Presupuesto** — `find_email` sumado a `DATA_PROVIDER_TASK_TYPES` (mismo guardia único que Google Places/PDL).
- **UI** — `Contacts.tsx` gana filtro "Email verificado" y columna con badge de color (`VERIFIED` verde, `RISKY`/`UNKNOWN` ámbar, `INVALID` rojo, más badge "No contactar" si `doNotContact`); `CompanyDetail` ya mostraba `Company.email` en la card de Procedencia, ahora se puebla con datos reales de Website Intelligence.

### Bug real encontrado y corregido durante la verificación

Hunter.io Email Verifier marca el campo `result` (`deliverable`/`risky`/`undeliverable`) como **deprecated** en la respuesta real (`"_deprecation_notice": "Using result is deprecated, use status instead"`) — confirmado con una llamada real. Se corrigió `email-verification-providers/hunter.ts` para mapear desde `status` (`valid`/`invalid`/`disposable`/`accept_all`/`webmail`/`unknown`), el campo vigente, antes de que esto llegara a producción con un mapeo basado en un campo que Hunter ya avisa que va a dejar de funcionar.

### Verificación con datos reales (2026-07-10)

- **Llamadas reales confirmadas**: `GET /v2/domain-search` y `GET /v2/email-verifier` de Hunter.io, HTTP 200, respuesta real inspeccionada campo por campo antes de dar el mapeo por bueno (mismo método que F4.6 con People Data Labs).
- **Créditos reales consumidos**: confirmado contra el propio endpoint `GET /v2/account` de Hunter — 3/50 búsquedas de dominio, 7/100 verificaciones usadas, **$0 gastados** (free tier tal como aprobó el PO). Amplio margen restante.
- **Contactos reales enriquecidos**: sobre `Principal Manufacturing Corporation` (empresa real, ya en el CRM desde F4.6), 3 de 5 `Contact` ya existentes (Kevin Fox, Richard Barnett, Edward Farrer — originalmente descubiertos por People Data Labs) recibieron un email real, verificado `VERIFIED` por Hunter, con `emailSource`/`emailVerificationProvider`/`emailConfidenceScore` completos. Los otros 2 (Ben Barnett, Jean Vanata) quedaron honestamente sin match — Hunter no tenía un registro con ese nombre exacto, no se inventó nada.
- **Website Intelligence con datos reales**: corrida contra 6+ sitios reales distintos (`principalmfg.com`, `jessupmfg.com`, `yforcelogistics.com`, `axiswarehouse.com`, `challenge-mfg.com`, `aztecmfgcorp.com`, `lmcindustries.com`) — visitó entre 2 y 6 páginas reales por sitio (home + contact/about/careers/leadership según lo que cada sitio realmente enlazaba), respetando robots.txt en todos los casos. Encontró un email genérico real y lo persistió en `Company.email` en 2 de esos sitios (`info@yforcelogistics.com`, `sales@lmcindustries.com`) — confirmado visible en la UI real (`CompanyDetail` → card "Procedencia"). En el resto, `NOT_FOUND` honesto (esos sitios no publican un email en las páginas visitadas).
- **Misión real end-to-end vía `/missions`** (Missouri, instrucción con "búsqueda externa"): `discover_companies` → `find_contacts` → `find_email` corrió automáticamente en cadena para una Company nueva (`Lmc Industries Inc`), sin contactos encontrados por People Data Labs pero con `Company.email` igual enriquecido por Website Intelligence — confirma que el enriquecimiento de empresa no depende de que haya contactos.
- **UI real (Playwright, sin errores de consola)**: `Contacts.tsx` filtrado por "Email verificado = Verified" muestra exactamente los 3 contactos reales de Principal Manufacturing con su email, fuente "Hunter.io" y badge verde "Verified" — capturas tomadas contra el navegador real, no simuladas.
- **Calidad**: `pnpm typecheck`/`lint` limpios en las 5 packages del monorepo, suite completa de `apps/api` en verde (61/61, incluye 2 tests de integración reales nuevos contra Hunter.io sin mocks, más 6 tests unitarios puros de extracción HTML/mapeo de estados).

### Pendiente explícito (no implementado en este corte)

Todo lo que este documento ya marcaba como bloqueado por B3 (Google Cloud OAuth), B5 (dirección postal/correo de envío) y B6 (SPF/DKIM/DMARC/subdominio): `GmailConnection`, `EmailMessage`, envío real, deliverability (SPF/DKIM/DMARC), lectura de inbox, y el Email Intelligence Dashboard de §10 (dashboard agregado — hoy los datos ya están completos y consultables vía `Contacts.tsx`/`CompanyDetail`, pero no hay una vista agregada de "cobertura por proveedor"/"costo por email válido" todavía). El nombre comercial ya se decidió (ver Addendum 2) — lo que falta ahora es exclusivamente B3/B5/B6 técnicos, ya no una decisión de marca.

---

## Addendum 2 — branding y dominio decididos (2026-07-11)

**Decisión definitiva del Product Owner**, separando tres conceptos que hasta acá se mencionaban juntos:

| Concepto | Valor | Dónde vive |
|---|---|---|
| Entidad legal (dueña del software y del negocio) | **Data More LLC** | `BUSINESS_LEGAL_NAME` |
| Marca comercial pública del staffing | **DreiStaff** | `BUSINESS_BRAND_NAME` |
| Software interno | AI Staffing OS, operando como plataforma privada de DreiStaff (nombre técnico, no se renombra — ver más abajo) | sin variable, es el nombre del repo/producto interno |

Estructura de dominios objetivo (a implementar progresivamente, no todo en este corte):

| Dominio | Uso | Estado |
|---|---|---|
| `dreistaff.com` | Sitio público de la agencia | Documentado en `docs/F4_8_PUBLIC_WEBSITE_AND_PRODUCTION_AUTH_PLAN.md` — no implementado todavía |
| `app.dreistaff.com` | Portal privado (este software) | Objetivo de despliegue — hoy sigue corriendo en `localhost` (dev) |
| `careers.dreistaff.com` | Futuro portal de candidatos, si se implementa | No implementado |
| `clients.dreistaff.com` | Futuro portal de clientes, si se implementa | No implementado |

**`data-more.com` nunca se usa** como dominio público, dominio de envío, marca comercial ni URL de producción del staffing — Data More LLC es la entidad legal, no una marca ni un dominio de cara al usuario.

### Configuración agregada (aditiva, `apps/api/src/core/env.ts` + `apps/api/src/core/branding.ts`)

```
BUSINESS_LEGAL_NAME=Data More LLC        # default real, ya decidido
BUSINESS_BRAND_NAME=DreiStaff            # default real, ya decidido
BUSINESS_DOMAIN=dreistaff.com            # default real, ya decidido
APP_DOMAIN=app.dreistaff.com             # default real, ya decidido
OUTREACH_FROM_NAME=DreiStaff             # default real, ya decidido
OUTREACH_FROM_EMAIL=                     # SIN default — null hasta que el PO lo configure
OUTREACH_REPLY_TO=                       # SIN default — null hasta que el PO lo configure
BUSINESS_POSTAL_ADDRESS=                 # SIN default — null hasta que el PO lo configure
```

`getBrandingConfig(tenantId)` resuelve estos valores con el mismo patrón que `getMissionSettings`/`getDataProviderBudgetStatus`: default de `env.ts`, overridable por `Tenant.settings.branding` (para el caso multi-tenant/white-label futuro, sin costo de schema — `Tenant.settings` ya es `Json`). Expuesto vía `GET /api/v1/branding` (cualquier usuario autenticado del tenant, sin permiso especial — no expone nada del CRM). El frontend (`apps/web/src/lib/branding.ts`, `useBranding()`) nunca hardcodea "DreiStaff"/"dreistaff.com" — siempre los pide a este endpoint. Sidebar y `<title>` ya muestran la marca real (`Sidebar.tsx`, `AppShell.tsx`).

### Qué NO se tocó (deliberado, instrucción explícita del PO)

- **Ningún renombre interno** de paquetes/namespaces (`@ai-staffing-os/*` sigue igual en `package.json` de las 5 workspaces) — el software interno sigue siendo "AI Staffing OS" técnicamente, opera como plataforma privada de DreiStaff, pero no se hizo una refactorización masiva de nombres de paquete/import.
- **Ningún correo corporativo creado.** Documentados como sugerencia (`admin@dreistaff.com`, `sales@dreistaff.com`, `recruiting@dreistaff.com`, `support@dreistaff.com`, `outreach@dreistaff.com`, preferencia del PO: `outreach@dreistaff.com` para el piloto) — ninguno existe todavía, ninguno se habilita hasta que el PO confirme la cuenta real y el DNS.
- **Ningún envío real, ninguna conexión de Gmail** — B3 (OAuth), B5 (correo de envío/dirección postal) y B6 (SPF/DKIM/DMARC/subdominio) siguen abiertos, ahora sin la incertidumbre de marca/dominio pero igual de bloqueados técnicamente.
- **Ningún subdominio de envío implementado** — el piloto (máx. 3 correos reales, aprobación individual, solo `VERIFIED`) usaría `dreistaff.com` directamente cuando se apruebe; `mail.dreistaff.com`/`outreach.dreistaff.com` quedan documentados como evaluación futura, no implementación.

### F4.7 sigue sin poder marcarse completada

Confirmado explícitamente por el PO: F4.7 no cierra hasta resolver Gmail OAuth, deliverability (SPF/DKIM/DMARC) y envío controlado — el branding decidido en este addendum es un desbloqueo de **decisión de producto**, no un desbloqueo técnico de esas tres piezas.
