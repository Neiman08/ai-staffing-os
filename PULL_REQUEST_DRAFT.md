# Pull Request (borrador — no abierto, no pusheado, no marcado como listo para merge)

`fix/email-integration-hardening` → `main`

## Título propuesto

```
fix(email): traceability hardening, reconciliation, PDL/Hunter budgets, and a gated Internal Acceptance Test flow
```

## Descripción completa

```markdown
## Resumen

Corrección integral de la integración de correo (Microsoft Graph) y del enriquecimiento
de contactos (People Data Labs / Hunter.io), a partir de la investigación real de 5
correos que llegaron a Microsoft Graph sin ningún rastro interno (EmailMessage/
ApprovalRequest/AuditLog). La causa raíz: `sendGraphMail` era invocable desde cualquier
script sin pasar por el servicio oficial de envío. Se corrigió estructuralmente, no con
un parche puntual.

## Qué cambia

- **Máquina de estados de email endurecida**: un HTTP 202 de Microsoft Graph ya nunca se
  interpreta como "enviado" — el nuevo estado `ACCEPTED_BY_PROVIDER` refleja exactamente
  eso ("aceptado, pendiente de confirmación real"). Solo un reconciliador real, que lee
  Sent Items/NDRs reales de Graph, puede promover un mensaje a `SENT_CONFIRMED`/
  `BOUNCED`/`DELIVERY_UNKNOWN`.
- **Trazabilidad obligatoria**: `sendGraphMail` ahora exige una autorización real
  (`SendAuthorization`) respaldada por una fila `EmailMessage` `PENDING` ya existente —
  no puede volver a ocurrir un envío real sin rastro interno.
- **Reconciliación real**: detecta mensajes reales en Sent Items sin ningún `EmailMessage`
  correspondiente (`EmailReconciliationAlert`) — nunca inventa un `ApprovalRequest`
  retroactivo, nunca modifica el mensaje real de Outlook.
- **Presupuestos reales de People Data Labs** (mensual/por misión/por empresa) y **caché
  real de Hunter.io Domain Search** — ninguno de los dos se reordenó respecto al otro
  (ver "Riesgos residuales" — Hunter sigue siendo el último recurso de la cascada, no el
  principal; esto es una decisión F15 preexistente, sin cambios en este PR).
- **UI**: Approvals muestra el estado real de envío (nunca "Enviado" optimista para un
  202); nuevo panel de administración en Settings para reconciliación manual y estado de
  proveedores.
- **Internal Acceptance Test**: nuevo flujo admin-only para probar Approve & Send de
  punta a punta sin fabricar una verificación comercial falsa para un contacto de prueba
  — marcador doble (`Contact.source="INTERNAL_TEST"` + `verificationStatus=
  "INTERNAL_TEST_VERIFIED"`), más un chequeo independiente de `Company.origin=
  "INTERNAL_TEST"`, ninguno de los 3 escribible desde ningún endpoint público.
- **DNS re-verificado dos veces** (2026-07-25 y 2026-07-26): SPF fue corregido (confirmado
  con evidencia reproducible) entre ambas fechas; DKIM sigue roto en el DNS público en
  ambas verificaciones — ver `docs/F27_EMAIL_DNS_REMEDIATION.md`.

## Qué NO cambia

- `ApprovalRequest.status` mantiene exactamente su significado histórico.
- El orden de la cascada de proveedores de contactos (PDL → Website Intelligence →
  Hunter) — decisión F15 preexistente, no tocada.
- Ningún dato comercial real fue borrado, modificado, ni un prospecto real fue contactado.

## Envío real ejecutado durante este trabajo

Un (1) envío de prueba controlado, real, completó el ciclo completo
`PENDING → ACCEPTED_BY_PROVIDER → SENT_CONFIRMED`, confirmado en Sent Items real, sin
NDR, entregado a `neimangroupllc@gmail.com` (único destinatario autorizado). Detalle
completo, incluidos todos los IDs reales, en `docs/F27_FINAL_MISSION_REPORT.md` §7 y
`RELEASE_READINESS.md` §3. Un segundo intento (vía el nuevo Internal Acceptance Test)
fue correctamente bloqueado por el guardia de anti-duplicado antes de tocar Graph —
nunca se realizó un segundo envío real.

## Test plan

- [x] `npm test` (apps/api, script oficial con `--test-concurrency=1`): 1838 tests,
      1831 pass, 2 fail (confirmados pre-existentes en `main`, ver abajo), 5 skip
      (gateados detrás de `RUN_REAL_PROVIDER_TESTS=1` por diseño, no relacionados).
- [x] Los 2 fallos fueron reproducidos EN VIVO contra `main` real, en un `git worktree`
      aislado, con la misma base de datos de desarrollo — confirmados idénticos
      (mismo archivo, mismo test, mismo tipo de fallo). Detalle exacto con evidencia en
      `RELEASE_READINESS.md` §1.
- [x] typecheck/lint/build limpios en los 7 workspaces, desde caché completamente limpia.
- [x] Migraciones (3) verificadas aditivas línea por línea, aplicadas contra la base real
      de desarrollo sin pérdida de datos.
- [ ] Externo: confirmar `spf=pass`/`dkim=pass` en el encabezado real de un mensaje
      recibido (SPF ya corregido en DNS; DKIM sigue roto en DNS — ver
      `docs/F27_EMAIL_DNS_REMEDIATION.md`).
- [ ] Externo: corregir el CNAME de DKIM en GoDaddy.

## Migraciones (3, todas aditivas — ver revisión línea por línea en `RELEASE_READINESS.md` §5)

1. `20260725010000_f27_email_traceability_hardening` — nuevos valores de
   `EmailMessageStatus`, nuevas columnas nullable en `EmailMessage`, nueva tabla
   `EmailReconciliationAlert`.
2. `20260725020000_f27_hunter_domain_search_cache` — nueva tabla
   `HunterDomainSearchCache`.
3. `20260726010000_f27_internal_acceptance_test` — nuevos valores de `CompanyOrigin` y
   `ContactVerificationStatus`.

Ningún `DROP`/`RENAME`/`ALTER COLUMN ... SET NOT NULL` sobre datos existentes.

## Riesgos residuales

1. DKIM roto en DNS público (GoDaddy) — acción externa pendiente.
2. Validación definitiva de DKIM en el encabezado real recibido — pendiente de que el
   usuario comparta el encabezado completo o el reporte de Mail Tester.
3. Application Access Policy de Exchange no confirmada desde este entorno.
4. Orden de proveedores Hunter/PDL: Hunter sigue siendo el último recurso, no el
   principal — decisión de negocio pendiente, fuera del alcance de este PR.
5. 2 tests preexistentes en `main`, no relacionados, dependientes de un LLM real y de la
   antigüedad de la base de datos compartida de desarrollo.
6. Datos reales de prueba interna (`INTERNAL_TEST`) sin eliminar de la base de
   desarrollo, por decisión explícita de no borrar datos sin pedido expreso.

## Pasos manuales posteriores al merge

1. Corregir el CNAME de DKIM en GoDaddy (agregar `.com` al final de `selector1`/`selector2`).
2. Habilitar/confirmar la firma DKIM en M365 Admin Center una vez el DNS resuelva.
3. Confirmar o crear la Application Access Policy de Exchange restringiendo la app de
   Graph a `sales@dreistaff.com`.
4. Rotar `AZURE_CLIENT_SECRET` después del período de pruebas activo.
5. Configurar `INTERNAL_ACCEPTANCE_TEST_ALLOWED_RECIPIENTS`/`INTERNAL_ACCEPTANCE_TEST_ENABLED`
   según el entorno real de despliegue (los defaults son seguros: allowlist con un solo
   destinatario de prueba, bandera de habilitación en `false`).
6. Revisar y reconocer/archivar las 10 `EmailReconciliationAlert` históricas desde
   Settings.
7. Decidir si limpiar la Company/Lead/Contact/ApprovalRequest de prueba interna que
   quedó en la base real de desarrollo.
8. Decisión de negocio: ¿Hunter.io pasa a ser el proveedor primario de contactos?

## Estrategia de rollback

- **Código**: revertir el merge commit (`git revert -m 1 <merge-commit>`) — todos los
  cambios de código son aditivos o encapsulados en módulos nuevos (`internal-testing/`,
  `reconciliation.ts`, `pdl-budget.ts`, `hunter-domain-cache.ts`); ningún código
  preexistente fue eliminado, solo extendido.
- **Migraciones**: **no revertir** las migraciones de base de datos junto con el código.
  Las 3 son puramente aditivas (nuevos valores de enum, nuevas columnas nullable, nuevas
  tablas) — revertir el código de aplicación mientras estos cambios de esquema
  permanecen es seguro (el código viejo simplemente ignora las columnas/tablas nuevas).
  Un `ALTER TYPE ... DROP VALUE` no es una operación soportada de forma segura en
  Postgres una vez que el valor pudo haberse usado — no hay necesidad real de revertir
  el esquema, y hacerlo sería más riesgoso que dejarlo como está.
- **Feature flags reales**: `INTERNAL_ACCEPTANCE_TEST_ENABLED` (default `false`) permite
  desactivar el flujo nuevo sin revertir código, si apareciera un problema específico
  solo de esa funcionalidad. No existe un flag equivalente para la reconciliación o el
  endurecimiento de `sendGraphMail` porque son correcciones de un defecto real (el envío
  sin rastro), no funcionalidades opcionales — desactivarlas reintroduciría el problema
  original que motivó todo este trabajo.

## Lista exacta de commits (12, en orden)

1. `3b0f7b6` — fix(email): stop conflating Graph 202 with a confirmed send, add reconciliation
2. `ae3af5a` — fix(email): require a real EmailMessage before sendGraphMail will touch Graph
3. `1724d32` — fix(contacts): cap People Data Labs credit spend per mission/company/month
4. `0d4fe39` — feat(contacts): cache Hunter.io domain search results to protect the free tier
5. `f73a3fb` — docs(email): re-verify SPF/DKIM/DMARC and document exact remediation
6. `68cbf67` — feat(ui): surface real send/delivery state instead of a flat "Enviado"
7. `54e87f8` — test(email): close remaining Fase 10 coverage gaps, full monorepo verification
8. `b6ba0d7` — fix(shared): sendManualEmailResultSchema still typed to the pre-F27 status enum
9. `730ab5a` — docs(email): final mission report -- F27 email/contact integration hardening
10. `390ea93` — feat(internal-testing): add a gated Internal Acceptance Test flow
11. `f382485` — test(public): fix stats test to match the widened INTERNAL_TEST exclusion
12. `d525526` — docs: final release audit -- RELEASE_READINESS.md, GO with documented caveats

(Este PR se preparó antes de un 13er commit que corrige la documentación de DNS/SPF y
agrega este mismo borrador — se agregará a la lista cuando se cree.)

## Lista exacta de archivos modificados (55 hasta el commit `d525526`)

**Nuevos (24)**:
```
RELEASE_READINESS.md
apps/api/src/modules/agents/hunter-domain-cache.test.ts
apps/api/src/modules/agents/hunter-domain-cache.ts
apps/api/src/modules/agents/pdl-budget.test.ts
apps/api/src/modules/agents/pdl-budget.ts
apps/api/src/modules/agents/tools/contact-providers/people-data-labs.test.ts
apps/api/src/modules/email/reconciliation.test.ts
apps/api/src/modules/email/reconciliation.ts
apps/api/src/modules/internal-testing/router.test.ts
apps/api/src/modules/internal-testing/router.ts
apps/api/src/modules/internal-testing/service.test.ts
apps/api/src/modules/internal-testing/service.ts
apps/web/src/components/settings/EmailReconciliationPanel.tsx
docs/F27_EMAIL_DNS_REMEDIATION.md
docs/F27_EMAIL_SEND_CREDENTIAL_RISK.md
docs/F27_FINAL_MISSION_REPORT.md
docs/F27_INTERNAL_ACCEPTANCE_TEST_REPORT.md
packages/db/prisma/migrations/20260725010000_f27_email_traceability_hardening/migration.sql
packages/db/prisma/migrations/20260725020000_f27_hunter_domain_search_cache/migration.sql
packages/db/prisma/migrations/20260726010000_f27_internal_acceptance_test/migration.sql
packages/shared/src/schemas/internal-testing.ts
```

**Modificados (31)**:
```
apps/api/src/app.ts
apps/api/src/core/env.ts
apps/api/src/core/tenancy/prisma-extension.ts
apps/api/src/modules/agents/contact-enrichment.ts
apps/api/src/modules/agents/mission-executor.ts
apps/api/src/modules/agents/mission-producer.ts
apps/api/src/modules/agents/tools/campaign-tools.impl.ts
apps/api/src/modules/agents/tools/contact-providers/people-data-labs.ts
apps/api/src/modules/agents/tools/contact-providers/types.ts
apps/api/src/modules/agents/tools/outreach-tools.impl.ts
apps/api/src/modules/agents/tools/sales-tools.impl.ts
apps/api/src/modules/approvals/decide-approval-email.test.ts
apps/api/src/modules/approvals/edit-approval-draft.test.ts
apps/api/src/modules/approvals/service.ts
apps/api/src/modules/ceo-intelligence/contact-channel.test.ts
apps/api/src/modules/ceo-intelligence/contact-channel.ts
apps/api/src/modules/ceo-intelligence/draft-creation-gate.test.ts
apps/api/src/modules/ceo-intelligence/draft-creation-gate.ts
apps/api/src/modules/crm/service.ts
apps/api/src/modules/email/email-service.test.ts
apps/api/src/modules/email/email-service.ts
apps/api/src/modules/email/microsoft-graph.test.ts
apps/api/src/modules/email/microsoft-graph.ts
apps/api/src/modules/email/router.ts
apps/api/src/modules/email/send-limits.ts
apps/api/src/modules/public/public.test.ts
apps/api/src/modules/public/service.ts
apps/web/src/pages/Approvals.tsx
apps/web/src/pages/Settings.tsx
packages/db/prisma/schema.prisma
packages/shared/src/index.ts
packages/shared/src/permissions.ts
packages/shared/src/schemas/agents.ts
packages/shared/src/schemas/crm.ts
```

## Estado de preparación

- [x] Borrador de título/descripción completo
- [x] Commits listados exactamente
- [x] Archivos listados exactamente
- [x] Riesgos, pasos posteriores y rollback documentados
- [ ] **No abierto** — pendiente de tu decisión
- [ ] **No pusheado** — pendiente de tu decisión
- [ ] **No marcado como listo para merge** — pendiente de tu decisión
```
