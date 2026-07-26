# F27 — Informe final: corrección integral de correo y enriquecimiento de contactos

Rama: `fix/email-integration-hardening`, ninguno pusheado — el usuario decide cuándo y a
dónde. Ningún merge a `main` fue hecho ni intentado.

> **Nota (post-informe)**: este documento describe el estado de la misión de 12 fases tal
> como se cerró originalmente (8 commits, hasta `b6ba0d7`). Después de entregado, el
> usuario pidió una prueba final de aceptación que reveló una brecha real (sin forma
> oficial de crear un `ApprovalRequest` de prueba sin falsificar una verificación
> comercial) — corregida en commits posteriores (`390ea93` en adelante). Ver
> `docs/F27_INTERNAL_ACCEPTANCE_TEST_REPORT.md` para ese trabajo y
> `RELEASE_READINESS.md` para el estado consolidado y final de toda la rama.

## 1. Resumen ejecutivo

Los 5 correos reales "fantasma" (sin EmailMessage/ApprovalRequest/AuditLog) que motivaron
esta misión, más 5 adicionales del mismo tipo descubiertos en el camino, quedaron
explicados con evidencia real: los 10 son consistentes con scripts de diagnóstico
puntuales creados y borrados durante este mismo proyecto (llamaban a `sendGraphMail`
directamente, sin pasar por `sendEmail()`). El sistema ya no puede reproducir ese patrón
-- `sendGraphMail` ahora exige una autorización real respaldada por una fila `EmailMessage`
ya existente antes de tocar la red (Fase 5). Además: Graph 202 dejó de interpretarse como
"enviado" (ahora es `ACCEPTED_BY_PROVIDER`, un estado explícitamente provisional); un
reconciliador real detecta y confirma contra Sent Items/NDRs; People Data Labs y Hunter.io
tienen techos de gasto reales; y se ejecutó un envío de prueba controlado real de punta a
punta con éxito. La entregabilidad del dominio sigue **degradada** por SPF/DKIM rotos --
no se puede declarar resuelto, requiere acción externa en GoDaddy/M365.

## 2. Causa raíz

`sendGraphMail` (microsoft-graph.ts) era una función exportada normal, invocable desde
cualquier script con datos inventados -- nada distinguía una llamada real de
`email-service.ts` (que sí crea EmailMessage/AuditLog) de una llamada directa. Los 10
envíos reales sin rastro son evidencia de que exactamente eso ocurrió, en 2 fechas
distintas (2026-07-21 y 2026-07-24), documentadas ahora en `EmailReconciliationAlert`
(ver punto 17). Causa secundaria: ningún código distinguía "Graph aceptó el /send" de
"el mensaje existe confirmado en Sent Items" -- ambos hechos se colapsaban en un solo
estado `SENT`, optimista por diseño.

## 3. Cambios realizados (por fase)

- **Fase 1** — Inventario: rama creada, procesos huérfanos verificados (ninguno real),
  fingerprints seguros de credenciales capturados, mapa completo de puntos de envío real.
- **Fase 2** — Máquina de estados: `EmailMessageStatus` gana `ACCEPTED_BY_PROVIDER`,
  `SENT_CONFIRMED`, `DELIVERED`, `BOUNCED`, `DELIVERY_UNKNOWN` (SENT queda legado, nunca
  se re-escribe). `email-service.ts` nunca vuelve a escribir `SENT`.
- **Fase 3** — Trazabilidad obligatoria: `AuditLog` antes Y después de cada intento real
  de Graph; `correlationId` único por intento; `send-limits.ts` reconoce todos los estados
  reales de "ya se envió", no solo el legado.
- **Fase 4** — Reconciliación real: `reconciliation.ts` lee Sent Items/NDRs reales,
  confirma/rebota/marca vencido EmailMessage, y detecta envíos externos no rastreados
  (`EmailReconciliationAlert`) -- nunca inventa un ApprovalRequest retroactivo.
- **Fase 5** — `sendGraphMail` exige `SendAuthorization` real (EmailMessage/tenant/
  correlationId ya existentes) antes de tocar la red; riesgo de credenciales documentado
  (no corregible por código) en `F27_EMAIL_SEND_CREDENTIAL_RISK.md`.
- **Fase 6** — Presupuestos reales de PDL (mensual/por misión/por empresa), calculados
  contra el gasto real, nunca contra un número inventado.
- **Fase 7** — Caché real de Hunter.io Domain Search por dominio (protege el free tier de
  25 búsquedas/mes).
- **Fase 8** — Re-verificación real de DNS (SPF/DKIM/DMARC) con remediación exacta
  documentada, sin tocar ningún registro.
- **Fase 9** — UI: estado real (no optimista) en Approvals, panel de administración de
  reconciliación/alertas/presupuestos en Settings.
- **Fase 10** — Cobertura de pruebas + verificación completa del monorepo.
- **Fase 11** — Envío real controlado, exitoso, documentado abajo.

## 4. Migraciones creadas

1. `20260725010000_f27_email_traceability_hardening` — nuevos valores de enum, columnas
   de `EmailMessage`, tabla `EmailReconciliationAlert`. Aditiva, cero pérdida de datos
   (verificado).
2. `20260725020000_f27_hunter_domain_search_cache` — tabla `HunterDomainSearchCache`.
   Aditiva.

## 5. Archivos modificados/creados

32 archivos, +2368/-115 líneas. Los de mayor relevancia:
`packages/db/prisma/schema.prisma`, `apps/api/src/modules/email/{email-service,
microsoft-graph,router,send-limits,reconciliation}.ts` (+2 archivos de test),
`apps/api/src/modules/agents/{pdl-budget,hunter-domain-cache,contact-enrichment,
mission-executor}.ts` (+3 archivos de test), `apps/api/src/core/tenancy/prisma-extension.ts`,
`apps/api/src/core/env.ts`, `apps/web/src/pages/{Approvals,Settings}.tsx`,
`apps/web/src/components/settings/EmailReconciliationPanel.tsx`,
`packages/shared/src/schemas/agents.ts`, y 3 documentos en `docs/`.

## 6. Pruebas ejecutadas y resultados

- 182 tests pasando en una corrida combinada de todos los módulos tocados (email,
  approvals, reconciliation, PDL budget, Hunter cache, mission-executor,
  discovery-conversion, pilot e2e) — 0 fallos.
- `pnpm --recursive run typecheck`: limpio en los 7 workspaces.
- `pnpm --recursive run lint`: 0 errores (quedan solo warnings preexistentes, no
  relacionados a esta rama, en archivos que esta misión no tocó).
- `pnpm --recursive run build`: exitoso (apps/web, apps/marketing compilan; el resto de
  paquetes no tiene paso de build propio).
- Verificación visual real en navegador (Playwright contra los dev servers reales,
  dev-bypass) de `/settings` y `/approvals` — cero errores de consola, panel de
  reconciliación renderizando datos reales.
- Nota honesta sobre un archivo (`mission-discovery-fallback.test.ts`) que mostró
  variación entre corridas por dependencia de datos reales externos (PDL devolvió 404
  real para una empresa puntual) -- confirmado por análisis de logs que el nuevo techo de
  tamaño de esta misión nunca fue la causa (PDL devolvió menos resultados de los que el
  techo permitía).

## 7. Resultado del envío real controlado (Fase 11)

**Exitoso, un único envío, ningún reintento necesario.**

- Endpoint oficial usado: `POST /emails/send-manual` (mismo código que usaría la UI,
  autenticado como `sales@titan.dev`, permiso `approvals.decide` — mismo nivel de
  confianza que aprobar un envío real).
- **EmailMessage ID**: `cms15as4a0000a6yi51vke82s`
- **AuditLog relacionado**: 3 filas — `email.send_requested` → `email.accepted_by_provider`
  → `email.sent_confirmed` (esta última la escribió el reconciliador, no el envío en sí).
- **ApprovalRequest**: no aplica a este endpoint por diseño — `/emails/send-manual` es el
  camino oficial existente para un envío humano directo fuera del flujo de aprobación de
  un borrador de IA (mismo permiso `approvals.decide`, mismo nivel de confianza real, ver
  comentario en `router.ts`). El EmailMessage y el AuditLog completo sí existen.
- **providerMessageId**: `AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0AX-VE3mlabEuId_WNY-gIcAAAAuxPDgAA`
- **internetMessageId**: `<PH7PR02MB890509FBB1F350BE9B5AE560A1CD2@PH7PR02MB8905.namprd02.prod.outlook.com>`
- **conversationId**: `AAQkAGI1YzRiZTlkLTFkMDItNDZkOS1iZjJmLWMwODg2YTgxNmQwYwAQAD3_wpko3u5CmgvTiwH5hsM=`
- **Código HTTP de Graph**: 202 (aceptado)
- **Buzón remitente real**: `sales@dreistaff.com`
- **Destinatario**: `neimangroupllc@gmail.com` (único autorizado para esta misión)
- **Asunto**: "DreiStaff — Verificación controlada de trazabilidad"
- **Estado inicial**: `ACCEPTED_BY_PROVIDER` (2026-07-26T01:54:44Z)
- **Estado final**: `SENT_CONFIRMED` (2026-07-26T01:55:26Z, ~42s después) — confirmado
  contra Sent Items real vía `providerMessageId`, nunca inferido.
- **Evidencia de Sent Items**: confirmada — el mensaje real fue encontrado por el
  reconciliador en la carpeta Sent Items del buzón `sales@dreistaff.com`.
- **Resultado de búsqueda de NDR**: ninguno — se buscó en el Inbox real desde 24h antes
  del envío (`listPossibleNdrsSince`), 0 candidatos. La corrida de reconciliación (ventana
  de 7 días) encontró 4 candidatos de NDR de fechas anteriores, ninguno relacionado con
  este envío.
- Nunca se declaró `DELIVERED` (solo hay evidencia de Sent Items, no de la bandeja de
  entrada real del destinatario — correcto, honesto).
- El histórico bloqueo `550 5.7.708` **no se reprodujo** en este envío puntual — un solo
  envío exitoso no prueba que esté resuelto de forma permanente, pero no bloqueó esta
  prueba real.

## 8. Estado de Hunter.io

`HUNTER_API_KEY` confirmada presente (huella segura: 40 caracteres, sufijo `39e8`, prefijo
SHA-256 `5d61ed19` — nunca el valor completo). Endpoint real en uso: Domain Search
(`GET /v2/domain-search`), free tier aprobado (25 búsquedas/mes). Nueva caché real por
(tenant, dominio) con ventana de 30 días — ninguna consulta real nueva de Hunter fue
necesaria para verificar esto (se confirmó por lectura de código + la key ya
configurada). 0 dominios cacheados este mes al momento de este informe (ver panel real en
Settings).

## 9. Estado de PDL y presupuesto configurado

`PDL_MONTHLY_CREDIT_BUDGET=40`, `PDL_PER_MISSION_CREDIT_BUDGET=15`,
`PDL_PER_COMPANY_MAX_RESULTS=5` (defaults conservadores, configurables por env, muy por
debajo del plan real de 100 créditos/mes reportado en el panel de PDL). 0 créditos
consumidos este mes calendario en el tenant real verificado. Ningún request real nuevo a
PDL fue necesario durante esta misión salvo los ya ejecutados en pruebas mockeadas.

## 10. Estado actual de SPF/DKIM/DMARC

**Degradado.** Re-verificado por `dig` real el 2026-07-25: SPF sigue sin
`include:spf.protection.outlook.com`; ambos CNAME de DKIM (`selector1`/`selector2`)
siguen apuntando a un host que no resuelve (falta `.com`, confirmado con `dig +trace`).
DMARC en `p=quarantine` (correcto, no tocar todavía). Ver
`docs/F27_EMAIL_DNS_REMEDIATION.md` para los bloques exactos de registro recomendados,
pasos de habilitación de DKIM en M365, y comandos de verificación.

## 11. Acciones manuales pendientes (GoDaddy / M365 / Azure)

1. **GoDaddy**: corregir el `TXT` de SPF y ambos `CNAME` de DKIM — valores exactos en
   `docs/F27_EMAIL_DNS_REMEDIATION.md` §1-2.
2. **M365 Admin Center / Exchange**: habilitar la firma DKIM una vez el CNAME resuelva.
3. **Azure AD / Exchange Online**: crear una Application Access Policy que restrinja la
   app registrada a enviar únicamente como `sales@dreistaff.com` — instrucciones exactas
   (comando de PowerShell incluido) en `docs/F27_EMAIL_SEND_CREDENTIAL_RISK.md`. Revisar
   si ya existe (`Get-ApplicationAccessPolicy`) — no se pudo verificar desde este entorno.
   Recomendado rotar `AZURE_CLIENT_SECRET` después de esta misión.
4. Revisar los 10 `EmailReconciliationAlert` (`OPEN`) desde el panel de Settings — todos
   quedaron explicados como scripts de diagnóstico de este mismo proyecto (ver §12), pero
   la decisión de reconocerlos/archivarlos es del usuario, nunca automática.

## 12. Riesgos residuales

- Entregabilidad degradada mientras SPF/DKIM no pasen (impacto real: correos reales
  probablemente cayendo en spam/cuarentena, no rebotando duro gracias a
  `p=quarantine`).
- El endurecimiento de `sendGraphMail` (Fase 5) protege contra scripts *dentro* de este
  repo; no puede proteger contra el uso del `client_secret` si se filtra o se usa fuera
  de este código — mitigación real pendiente es la Application Access Policy de M365.
- `mission-discovery-fallback.test.ts` depende de datos reales externos (PDL/Hunter) para
  2 empresas reales fijas — puede fallar en días donde esas empresas puntuales no tengan
  datos, independientemente de este trabajo.

## 13. Confirmación expresa

**No se enviaron correos a ningún prospecto ni empresa real durante esta misión.** El
único envío real ejecutado fue el de la Fase 11, al único destinatario autorizado
(`neimangroupllc@gmail.com`). Los 5 mensajes reales previamente investigados nunca se
reenviaron. No se ejecutó `prisma migrate reset`, no se vació ni borró ningún dato
existente, no se usó la base principal como shadow database, no se cambiaron secretos ni
variables de entorno sin necesidad comprobada (solo se agregaron nuevas, nunca se
modificó ni removió una existente), y nunca se mostró una API key/secreto/token completo.

## 14. Commits creados (rama `fix/email-integration-hardening`, ninguno pusheado)

1. `3b0f7b6` — Fases 1-4: máquina de estados, trazabilidad obligatoria, reconciliación.
2. `ae3af5a` — Fase 5: `SendAuthorization` real antes de tocar Graph + documentación de riesgo de credenciales.
3. `1724d32` — Fase 6: presupuestos reales de PDL.
4. `0d4fe39` — Fase 7: caché real de Hunter.io.
5. `f73a3fb` — Fase 8: re-verificación DNS + remediación exacta.
6. `68cbf67` — Fase 9: UI real de estado + panel de reconciliación.
7. `54e87f8` — Fase 10: cobertura de pruebas restante + verificación completa del monorepo.
8. `b6ba0d7` — fix menor: schema de envío manual desactualizado.

## 15. Pasos exactos para que el usuario verifique todo desde la interfaz

1. Iniciar los dev servers si no están corriendo (`pnpm dev` desde la raíz) — en esta
   sesión ya estaban corriendo (API :4000, Web :5173).
2. Entrar a `http://localhost:5173`, iniciar sesión con la cuenta de prueba temporal
   (ver `MockLogin.tsx`), ir a **Settings** → sección "Trazabilidad de correo saliente":
   ver el estado real de Microsoft Graph/PDL/Hunter, la advertencia de entregabilidad
   degradada, y los 10 envíos reales no rastreados detectados (ya explicados en §12 de
   este informe) — probar el botón "Reconciliar con Outlook" (vuelve a correr la
   reconciliación real, es idempotente).
3. Ir a **Approvals** → pestaña "Sent" para ver cómo se vería un envío real confirmado
   (ninguno existe todavía en el tenant de desarrollo — el envío de la Fase 11 se hizo vía
   el endpoint manual, no vía un ApprovalRequest, ver §7).
4. Revisar los 2 documentos de remediación externa: `docs/F27_EMAIL_DNS_REMEDIATION.md` y
   `docs/F27_EMAIL_SEND_CREDENTIAL_RISK.md`.

## 16. Criterio "Listo" — evaluación final

| Condición | Estado |
|---|---|
| Build/lint/typecheck/tests pasan | ✅ |
| Migración segura | ✅ (aditiva, verificado cero pérdida de datos) |
| Envío controlado con trazabilidad completa | ✅ |
| Aparece en Sent Items | ✅ |
| CRM muestra ACCEPTED_BY_PROVIDER → SENT_CONFIRMED | ✅ |
| Reconciliación detecta envíos externos no rastreados | ✅ (10 detectados y explicados) |
| Hunter operativo | ✅ (key confirmada, caché real agregada) |
| PDL con límites conservadores | ✅ |
| Sin envíos a prospectos durante la misión | ✅ |
| Sin errores críticos de código/DB restantes | ✅ |
| SPF/DKIM | ❌ — **degradado**, requiere acción externa (GoDaddy/M365) |

**El sistema NO se declara "listo para producción" sin reservas** — todo lo que el código
puede resolver está resuelto y verificado con evidencia real; la entregabilidad de email
sigue bloqueada por 2 registros DNS que requieren acceso a paneles externos que este
entorno no tiene. Ver §11 para las acciones exactas pendientes.
