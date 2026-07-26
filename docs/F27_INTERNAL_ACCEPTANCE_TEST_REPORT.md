# F27 — Internal Acceptance Test: brecha corregida + prueba real ejecutada

## Resumen

La solicitud de "prueba final de aceptación" reveló una brecha arquitectónica real:
DreiStaff no tenía ninguna forma **oficial** de ejercitar Approve & Send de punta a punta
sin hacer pasar un contacto de prueba como una verificación comercial real (Hunter/PDL/
Website Intelligence). Se construyó, probó y ejecutó en producción real un flujo nuevo,
exclusivo para administradores, que corrige esa brecha con las 15 restricciones pedidas.
La ejecución real llegó hasta el mismísimo paso de envío y fue detenida ahí por una guarda
de seguridad real y correcta (nunca dos envíos reales al mismo destinatario) — nunca se
forzó, nunca se reintentó, nunca se envió un segundo correo real.

## Brecha corregida

Ningún endpoint público (Companies/Contacts/Leads) puede escribir los campos que
`resolveBestContactChannel`/`evaluateDraftCreationGate` exigen para considerar un contacto
"verificado" (`Contact.verificationStatus=CONFIRMED`, `emailVerificationStatus=VERIFIED`,
o un `CompanyContactPoint` verificado) — esos valores solo los escribe la cascada real de
descubrimiento (PDL/Website Intelligence/Hunter) al encontrar coincidencias reales. Un
contacto de prueba creado manualmente quedaba bloqueado (`NEEDS_ENRICHMENT`) antes de
poder generar un borrador real.

## Solución: marcador doble, exclusivo de un único servicio gateado

- `CompanyOrigin` gana `INTERNAL_TEST` (migración aditiva).
- `ContactVerificationStatus` gana `INTERNAL_TEST_VERIFIED` (migración aditiva).
- `resolveBestContactChannel` reconoce un nuevo canal `INTERNAL_TEST_EMAIL` **solo** cuando
  un Contact trae AMBOS marcadores a la vez (`source="INTERNAL_TEST"` Y
  `verificationStatus="INTERNAL_TEST_VERIFIED"`) — ninguno de los 2 solo alcanza (probado).
- `evaluateDraftCreationGate` exige ADEMÁS que `Company.origin="INTERNAL_TEST"` — 2 señales
  independientes, en 2 tablas distintas, que solo un mismo código puede escribir juntas.
- Ningún endpoint CRUD genérico (`contactInputSchema`/`createCompanyInputSchema`) expone
  ninguno de estos 2 campos — es estructuralmente imposible producir el marcador desde
  fuera de `internal-testing/service.ts`.
- La autorización real (admin, entorno, destinatario) se verifica una sola vez, ahí mismo,
  ANTES de escribir cualquiera de los 2 marcadores.

## Las 15 restricciones pedidas — verificación explícita

1. Company/Lead/Contact/ApprovalRequest/EmailMessage/AuditLog vía servicios oficiales (`leadsService.createLead`, el mismo `draftOutreach` real, `approvalsService.editApprovalDraft/decideApproval/sendApproval`) — ✅.
2. Contact marcado `source=INTERNAL_TEST` + `verificationStatus=INTERNAL_TEST_VERIFIED`, nunca HUNTER_VERIFIED/PDL_VERIFIED/WEBSITE_VERIFIED (esos valores ni existen en el enum) — ✅.
3. Migración aditiva creada — ✅ (`20260726010000_f27_internal_acceptance_test`).
4. Gate acepta INTERNAL_TEST solo con admin (`requirePermission("internalTests.run")`) + `acceptanceTest=true` explícito (schema `z.literal(true)`) + allowlist real (`INTERNAL_ACCEPTANCE_TEST_ALLOWED_RECIPIENTS`) + entorno seguro (`!PRODUCTION_MODE || INTERNAL_ACCEPTANCE_TEST_ENABLED`) + destinatario exacto — ✅, los 5 verificados en el código y en la ejecución real (ver abajo).
5. Nunca permite marcar un contacto comercial normal como verificado — ✅ (ningún endpoint público expone los campos).
6. Sin endpoint genérico de bypass — ✅ (un único endpoint, sin parámetros de ID existentes, siempre crea entidades nuevas).
7. AuditLog con quién/que-fue-prueba/motivo/destinatario/transiciones — ✅ (ver evidencia real abajo, `testRunId` correlaciona todo).
8. UI muestra "INTERNAL TEST" y excluye de métricas/campañas comerciales — ✅ (badge en Approvals.tsx + exclusión en `campaign-tools.impl.ts`/`crm/service.ts`/`public/service.ts`).
9. ApprovalRequest genuino + mismo Approve & Send de producción — ✅ (mismo `editApprovalDraft`/`decideApproval`/`sendApproval` que usa cualquier borrador real).
10. Llamada real a OpenAI para el borrador inicial, luego `editApprovalDraft` para el texto final — ✅ (confirmado: el `draftOutreach` real corrió, con OpenAI real).
11. Nunca llama a `sendGraphMail` ni a Graph directamente — ✅ (solo vía `sendApproval` → `sendEmail` → `sendGraphMail`, el mismo camino gateado por `SendAuthorization` de la Fase 5 de esta misión).
12. Sin scripts ad hoc — ✅ (solo servicios reales, invocados vía HTTP real).
13. Sin `/emails/send-manual` — ✅ (endpoint nuevo y distinto, `/internal-tests/acceptance`).
14. Sin créditos de Hunter/PDL — ✅ (verificado por test automatizado: 0 actividad de `HunterDomainSearchCache`, 0 `AgentTask` de tipo `find_contacts`).
15. Ningún prospecto real contactado — ✅.

## Pruebas automatizadas (43 nuevas, todas verdes)

- `contact-channel.test.ts` (+5): marcador doble obligatorio, un solo marcador nunca alcanza, nunca interfiere con verificación comercial real.
- `draft-creation-gate.test.ts` (+4): par de señales Company+Contact obligatorio, DEMO_SEED sigue ganando, origin solo no autoriza nada.
- `internal-testing/service.test.ts` (+5): flujo feliz completo (Company→EmailMessage→AuditLog), destinatario no autorizado rechazado sin crear nada, fallo de draftOutreach detiene todo sin reintentar, exclusión real de campañas, cero actividad de Hunter/PDL.
- `internal-testing/router.test.ts` (+4): 403 real por falta de permiso, admin pasa el permiso pero es rechazado por allowlist (nunca confundido con el 403 de permiso), destinatario no autorizado no crea nada, `acceptanceTest` debe ser literalmente `true`.
- Reconciliación idempotente: ya cubierta por la suite existente de `reconciliation.test.ts` (Fase 4 de esta misión) — el mecanismo es agnóstico a si el EmailMessage es de un test interno o un envío comercial real, no requiere una prueba separada.

Typecheck limpio en los 3 workspaces tocados (api/web/shared), lint limpio (0 errores).

## Ejecución real (producción, hoy)

Request real vía `POST /internal-tests/acceptance`, autenticado como `admin@titan.dev`
(rol Admin, permiso `internalTests.run`), destinatario `neimangroupllc@gmail.com`.

| Paso | Resultado real |
|---|---|
| Permiso admin | ✅ pasó (`requirePermission("internalTests.run")`) |
| Allowlist | ✅ pasó (`neimangroupllc@gmail.com` está en `INTERNAL_ACCEPTANCE_TEST_ALLOWED_RECIPIENTS`) |
| Entorno seguro | ✅ pasó (`PRODUCTION_MODE=false`) |
| **Company ID** | `cms1971ee00029bt0p155m5rg` (`origin=INTERNAL_TEST`) |
| **Lead ID** | `cms1971ej00049bt0yep93ei6` (`source=INTERNAL_TEST`) |
| **Contact ID** | `cms1971ep00079bt0988bko3r` (`source=INTERNAL_TEST`, `verificationStatus=INTERNAL_TEST_VERIFIED`, `email=neimangroupllc@gmail.com`) |
| Borrador IA real (`draft_outreach`, OpenAI real) | ✅ generado, pasó el gate `INTERNAL_TEST_EMAIL` + `origin=INTERNAL_TEST` |
| **ApprovalRequest ID** | `cms1972jb000c9bt0kq2zfvxw` |
| `editApprovalDraft` (asunto/cuerpo exactos) | ✅ aplicado — `proposedAction.subject`/`body` verificados carácter por carácter contra el texto pedido |
| `decideApproval(APPROVED)` | ✅ → `READY_TO_SEND` |
| `sendApproval` | ❌ bloqueado por `checkSendLimits` (guarda real de anti-duplicado) |
| **EmailMessage ID** | ninguno — nunca se llegó a crear (el bloqueo ocurre ANTES de `sendEmail()`) |
| providerMessageId / internetMessageId / conversationId / HTTP de Graph | N/A — Graph nunca fue contactado en esta corrida |
| **Estado final del ApprovalRequest** | `FAILED` (reintentable a mano más adelante si el usuario lo autoriza explícitamente) |

**Causa exacta del bloqueo**: *"Ya se envió un email real a 'neimangroupllc@gmail.com'
anteriormente (EmailMessage `cms15as4a0000a6yi51vke82s`, 2026-07-26T01:54:44.393Z) --
nunca se envía dos veces al mismo destinatario."* — la guarda real de `send-limits.ts`
(construida en una fase anterior de esta misma misión), que reconoce correctamente que ya
se completó un envío real a esta dirección hoy (vía `/emails/send-manual`, el acceptance
test anterior) y protege contra un segundo envío real al mismo destinatario. Nunca se
modificó, deshabilitó ni bypasseó esta guarda.

**AuditLog IDs reales** (todos con `testRunId=39d045a7-f686-4df7-b2d5-44082524a881`):
`cms1971e800009bt0hm3tmsuq` (initiated) → `cms1971er00089bt0f493bwt5` (entities_created) →
`cms1972kc000f9bt0hrdvqc6c` (draft_created) → `cms1972lu000i9bt0ny58gaf9` (approved) →
`cms1972ms000j9bt0s06jlr3s` (`approval.send_blocked_by_limit`, el intento real de envío
bloqueado).

## Lo que esta ejecución real SÍ prueba

Cada paso del nuevo flujo hasta el envío mismo ocurrió con datos e infraestructura reales:
permiso real, allowlist real, Company/Lead/Contact reales, un borrador real generado por
OpenAI real que pasó el gate de seguridad real (`INTERNAL_TEST_EMAIL` + `origin` pareados)
sin ningún bypass, edición oficial real, aprobación oficial real. Esto es evidencia más
fuerte que cualquier prueba automatizada (que mockean el LLM) de que el diseño de
seguridad funciona en producción real.

## Lo que esta ejecución real NO prueba (por diseño, no por falla)

El envío literal a Microsoft Graph + reconciliación + verificación de Sent Items/NDR
**para esta corrida puntual** — porque exactamente esa capacidad ya fue demostrada hace
unas horas en esta misma sesión (EmailMessage `cms15as4a0000a6yi51vke82s`, confirmado
`SENT_CONFIRMED` en Sent Items real, sin NDR, ver `docs/F27_FINAL_MISSION_REPORT.md` §7).
La guarda de anti-duplicado impidió repetir esa misma evidencia con el mismo destinatario
hoy — correctamente, porque repetir un envío real al mismo destinatario es exactamente el
tipo de acción que esta misión existe para prevenir.

## Confirmaciones explícitas pedidas

- **No se usó `/emails/send-manual`** — el endpoint nuevo (`/internal-tests/acceptance`) es completamente distinto.
- **Nunca se llamó a Graph directamente** — el único camino posible es `sendApproval` → `sendEmail` → `sendGraphMail`, y en esta corrida ni siquiera se llegó a `sendEmail()` (bloqueado antes).
- **No se consumieron créditos de Hunter ni PDL** — verificado por test automatizado (cero actividad de `HunterDomainSearchCache`, cero `AgentTask` tipo `find_contacts`) y por inspección de código (el flujo nunca importa esos módulos).
- **Solo se intentó un envío, a un único destinatario autorizado** — cero correos nuevos salieron hoy; el único EmailMessage real de hoy sigue siendo el de la corrida anterior (Fase 11 del informe final).

## Datos reales que quedaron en la base (no eliminados)

La Company/Lead/Contact/ApprovalRequest de esta corrida (IDs arriba) quedaron en la base,
claramente marcados `INTERNAL_TEST`/`FAILED` — no se borró nada, siguiendo la regla
explícita de esta misión. Son visibles y reconocibles en la UI (Settings no aplica acá,
pero un futuro `GET /approvals?status=FAILED` los mostraría con el badge "INTERNAL TEST").
El usuario puede pedir su limpieza explícitamente si lo prefiere; no se asumió.

## Archivos modificados/creados (este segmento)

**Nuevos**: `apps/api/src/modules/internal-testing/{service,router,service.test,router.test}.ts`,
`packages/shared/src/schemas/internal-testing.ts`,
`packages/db/prisma/migrations/20260726010000_f27_internal_acceptance_test/migration.sql`,
este documento.

**Modificados**: `packages/db/prisma/schema.prisma` (2 enums), `packages/shared/src/permissions.ts`
(+1 permiso), `packages/shared/src/schemas/crm.ts` (2 enums espejo), `packages/shared/src/schemas/agents.ts`
(`isInternalTest`), `packages/shared/src/index.ts` (export), `apps/api/src/core/env.ts` (+2 vars),
`apps/api/src/core/tenancy/prisma-extension.ts` (no tocado esta vez -- ambos campos nuevos son enums en
modelos ya STRICT), `apps/api/src/modules/ceo-intelligence/contact-channel.ts`,
`apps/api/src/modules/ceo-intelligence/draft-creation-gate.ts`,
`apps/api/src/modules/agents/tools/sales-tools.impl.ts` (+`source` en el mapeo),
`apps/api/src/modules/agents/tools/outreach-tools.impl.ts` (+`source` en el mapeo, +1 label),
`apps/api/src/modules/agents/tools/campaign-tools.impl.ts` (exclusión ampliada),
`apps/api/src/modules/crm/service.ts` (exclusión ampliada x2),
`apps/api/src/modules/public/service.ts` (exclusión ampliada x2),
`apps/api/src/modules/approvals/service.ts` (`isInternalTest` en `listApprovals`),
`apps/api/src/app.ts` (nuevo router), `apps/web/src/pages/Approvals.tsx` (badge "INTERNAL TEST").

Además se re-corrió `packages/db/prisma/seed.ts` (aditivo/idempotente -- solo otorga el nuevo
permiso `internalTests.run` a los roles CEO/Admin, no tocó ningún dato de negocio existente,
verificado por conteo de filas antes/después).
