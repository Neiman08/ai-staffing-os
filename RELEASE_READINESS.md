# RELEASE_READINESS.md — `fix/email-integration-hardening`

Auditoría final de release, ejecutada el 2026-07-26 antes de cualquier push/PR. Ningún
push, merge, ni apertura de Pull Request fue realizado — se documentan solo abajo.

## Recomendación objetiva: **GO**, con salvedades documentadas

El código de esta rama es seguro de mergear. No se encontró ningún bloqueador crítico
introducido por este trabajo. Se encontró y corrigió un (1) regresión real durante esta
misma auditoría, dos (2) fallos de test pre-existentes y no relacionados quedaron
documentados con causa raíz (no son bloqueadores), y se identificó una (1) discrepancia
real de arquitectura (orden de proveedores Hunter/PDL) que requiere una decisión de
producto separada, no un fix de código de esta rama.

---

## 1–4: Higiene de código

| Chequeo | Resultado |
|---|---|
| TODO/FIXME/HACK/XXX | **Ninguno** en código nuevo (grep completo del diff, 0 coincidencias reales — 4 falsos positivos eran la palabra "todo" en español) |
| `console.log`/`console.debug`/`debugger` nuevos | **Ninguno** agregado (los `log()` helpers existentes que internamente usan `console.log` para logs estructurados JSON son el patrón ya establecido en todo el repo, sin cambios) |
| `.only()`/`.skip()` en tests nuevos | **Ninguno** |
| Scripts temporales / `.tmp.ts` / archivos de scratch | **Ninguno** trackeado en la rama. `docs/FIRST_REAL_COMPANY_TEST_CHECKLIST.md` es un archivo *no trackeado* preexistente (fecha 2026-07-21, anterior a esta rama) — no forma parte de este diff, no requiere acción |
| Credenciales/secretos expuestos | **Ninguno real.** Grep de patrones de secreto (sk-, AKIA, `-----BEGIN`, etc.) sin coincidencias. Toda mención de `clientSecret`/`apiKey` en el diff es una variable pasada por referencia o el fingerprint seguro ya documentado (longitud/sufijo/hash, nunca el valor). `.env` nunca tocado por git |

## 5: Migraciones — todas puramente aditivas

Revisadas las 3 migraciones nuevas de esta rama línea por línea:

- `20260725010000_f27_email_traceability_hardening`: solo `ALTER TYPE ... ADD VALUE`, `ALTER TABLE ... ADD COLUMN` (todas nullable), `CREATE TABLE`, `CREATE INDEX`.
- `20260725020000_f27_hunter_domain_search_cache`: solo `CREATE TABLE`/`CREATE INDEX` (tabla nueva).
- `20260726010000_f27_internal_acceptance_test`: solo `ALTER TYPE ... ADD VALUE` (2 enums).

Ningún `DROP`, `RENAME`, `ALTER COLUMN ... SET NOT NULL` sobre columnas existentes, ni
sentencia que reescriba/borre datos existentes. Verificado además con las 3 migraciones
ya aplicadas contra la base real de desarrollo sin pérdida de datos (conteos de filas
verificados antes/después en cada fase).

## 6: Referencias rotas / imports sin usar

`tsc --noEmit` limpio en los 7 workspaces (incluida una corrida desde caché
completamente limpia — ver §9). `eslint --max-warnings=0` limpio en los archivos nuevos
más sensibles (`internal-testing/`, `reconciliation.ts`, `pdl-budget.ts`,
`hunter-domain-cache.ts`). Lint completo del monorepo: 0 errores (solo warnings
preexistentes, no relacionados, en archivos que esta rama nunca tocó).

## 7–8: Documentación y correspondencia con el código real

Se encontraron y corrigieron 2 inconsistencias reales durante esta auditoría:

1. **`F27_FINAL_MISSION_REPORT.md`** listaba 8 commits como el estado final de la rama,
   pero 2 commits posteriores (la funcionalidad de Internal Acceptance Test) ya existían
   y no estaban reflejados. Se agregó una nota post-informe apuntando al documento
   correcto y a este mismo `RELEASE_READINESS.md`.
2. **`F27_INTERNAL_ACCEPTANCE_TEST_REPORT.md`** decía "43 pruebas nuevas" (y el mensaje
   del commit `390ea93` decía "47") — el conteo real verificado es **18** (5+4+5+4 en
   los 4 archivos de test de esa funcionalidad puntual). Corregido en el documento, con
   nota explícita del error anterior (el mensaje de commit no se reescribió — reescribir
   historia de git no estaba autorizado para esto y el error es cosmético, no afecta el
   contenido real del cambio).

El resto de la documentación (`F27_EMAIL_DNS_REMEDIATION.md`,
`F27_EMAIL_SEND_CREDENTIAL_RISK.md`) sigue siendo exacta — describen hallazgos con fecha
explícita ("verificado el 2026-07-25"), nunca afirman un estado "resuelto" sin evidencia,
y nada cambió desde su redacción.

## 9: Build limpio desde cero

- `pnpm install --frozen-lockfile`: lockfile consistente con todos los `package.json` del
  monorepo (equivalente real a "instalaría sin cambios en un entorno limpio/CI").
- Se borraron manualmente `apps/web/tsconfig.tsbuildinfo`, `apps/marketing/tsconfig.tsbuildinfo`,
  y ambos `dist/` antes de reconstruir — sin caché incremental que pudiera ocultar un error.
- `pnpm --recursive run build`: exitoso, sin errores, en `apps/web` y `apps/marketing`
  (los únicos 2 paquetes con paso de build propio — el resto son consumidos como TS
  fuente directamente, sin paso de bundling).
- `pnpm --recursive run typecheck`: limpio en los 7 workspaces, repetido después de
  limpiar caché.

## 10: Todos los tests — corrida completa y autoritativa

Se usó el script oficial del proyecto (`npm test` en `apps/api`, que fuerza
`--test-concurrency=1` para evitar el falso-positivo de condiciones de carrera entre
archivos de test que comparten la base de datos real de desarrollo — un problema de
infraestructura de testing ya conocido de sesiones anteriores, no de este código).

**Resultado: 1838 tests, 1831 pasan, 2 fallan, 5 skipped.**

Los 2 fallos, investigados hasta la causa raíz:

1. `mission-discovery-fallback.test.ts` — depende de una llamada real a OpenAI
   (`interpretDailyDirective`) para interpretar una instrucción en lenguaje natural; esta
   vez el LLM no identificó "Hospitality" como industria. Archivo **nunca tocado** por
   esta rama. No determinístico por diseño (usa un LLM real).
2. `mission-planning.test.ts` ("compatibilidad con misiones antiguas") — la propia base de
   datos de desarrollo compartida ya no tiene ninguna misión `daily_revenue_mission`
   "vieja" (anterior a F7.2, sin `ceoIntent`) porque la base lleva mucho tiempo viva y
   esa distinción histórica se perdió con el tiempo — el propio test documenta este caso
   límite ("entorno sin datos reales — no aplica"), pero la fila más antigua real que
   encuentra hoy ya tiene `ceoIntent` poblado. Archivo **nunca tocado** por esta rama.
   Confirmado reproducible incluso corriendo el archivo completamente solo (no es un
   problema de orden/paralelismo).

Se encontró y corrigió un **tercer fallo real, causado por esta rama**:
`public.test.ts`'s prueba de `GET /public/stats` recalculaba el conteo esperado con el
filtro VIEJO (`origin != DEMO_SEED`), mientras el endpoint real (modificado en esta rama)
ahora también excluye `INTERNAL_TEST` — divergieron en cuanto existió una Company
`INTERNAL_TEST` real en la base (la que dejó la propia ejecución real de la Fase 11).
Corregido para que el cálculo del test refleje el mismo filtro real. Verificado con una
segunda corrida completa: **1831 pasan, exactamente los mismos 2 fallos preexistentes
(no relacionados) permanecen, cero fallos nuevos.**

## 11: Cobertura nueva incluida

50 bloques `test(` nuevos agregados en todo el diff (2 de ellos son renombres de tests
ya existentes con el mismo propósito, no casos nuevos — 48 tests genuinamente nuevos).
Todos commiteados, ninguno con `.skip`/`.only`, todos verdes en la corrida completa de §10.

## 12: El flujo comercial normal no cambió de comportamiento

Verificado en 3 niveles:

- **Revisión línea por línea** de los 3 call sites reales de creación de outreach
  (`sales-tools.impl.ts`, `outreach-tools.impl.ts`, `campaign-tools.impl.ts`): los únicos
  cambios son (a) pasar un campo `source` ya existente que antes no se leía, y (b) ampliar
  un filtro de exclusión (nunca angostarlo) — ningún cambio de lógica de negocio real.
- **Toda la suite existente de aprobaciones/misiones/campañas/discovery sigue pasando**
  sin ningún cambio de aserciones necesario (confirmado en la corrida de §10 — ninguno de
  los archivos de test preexistentes de estos módulos requirió modificación para seguir
  pasando, salvo los cambios explícitos de la Fase 3 de la misión original documentados
  en `F27_FINAL_MISSION_REPORT.md`, todos ya revisados en esa auditoría original).
- **`ApprovalRequest.status` mantiene exactamente su significado histórico** ("la acción
  humana de envío se completó a nivel de aceptación del proveedor") — la verdad más fina
  de entrega vive únicamente en `EmailMessage`, decisión de diseño explícita y documentada.

## 13: `INTERNAL_TEST` no puede saltarse ninguna verificación comercial

Verificación exhaustiva, no solo de los 2 gates obvios:

- `resolveBestContactChannel` exige el marcador doble (`source="INTERNAL_TEST"` **y**
  `verificationStatus="INTERNAL_TEST_VERIFIED"` a la vez) — ninguno de los endpoints
  públicos de Contacts/Companies puede escribir ninguno de los 2 valores.
- `evaluateDraftCreationGate` exige ADEMÁS que `Company.origin="INTERNAL_TEST"` — un
  tercer chequeo independiente, en una tabla distinta.
- Grep exhaustivo de **todo** el código fuente que lee `Contact.verificationStatus` o
  `CompanyOrigin` (11 sitios reales, no solo los 2 gates ya conocidos): ninguno usa una
  comparación laxa tipo "distinto de UNVERIFIED" que pudiera tratar
  `INTERNAL_TEST_VERIFIED` como una verificación real — todos comparan contra
  `"CONFIRMED"` exactamente, o pertenecen a un enum completamente distinto
  (`CompanyVerificationStatus`, no tocado).
- Único hallazgo menor, no explotable: el clasificador de origen de datos de
  `production-readiness/origin-classifier.ts` (un reporte de calidad de datos, de solo
  lectura, sin relación con envío real ni con ningún gate de seguridad) no tiene un
  bucket dedicado para `INTERNAL_TEST`/`source="INTERNAL_TEST"` — cae de forma segura en
  su categoría `"UNKNOWN"` ya existente (comportamiento explícitamente diseñado para
  cualquier valor no reconocido, documentado en el propio archivo). No es un bypass de
  nada, solo una categorización imprecisa en un dashboard de observabilidad. No bloqueante.

## 14: Ningún camino puede enviar correo sin trazabilidad

Grep exhaustivo confirma **un único caller real** de `sendGraphMail` en todo el código:
`email-service.ts`. `internal-testing/service.ts` no importa `microsoft-graph.ts` en
absoluto. El guardia `SendAuthorization` (Fase 5 de la misión original) sigue vigente sin
modificaciones — cualquier llamada a `sendGraphMail` exige una fila `EmailMessage` `PENDING`
real ya existente antes de tocar la red. Ningún código de esta auditoría abrió una vía nueva.

## 15: Prioridad de proveedores Hunter vs. PDL — hallazgo real, no un bug de esta rama

**Hunter.io NO es hoy el proveedor principal.** El orden real de la cascada de
`contact-enrichment.ts` (decisión F15, documentada, aprobada por el PO en su momento, y
**sin cambios en esta rama**) es:

1. People Data Labs (pago, "la más completa cuando funciona").
2. Website Intelligence (gratis, ya crawleado).
3. Hunter.io (último recurso).

Esta rama SÍ cumplió la mitad de este ítem: **PDL permanece limitado por presupuesto**
(techos reales mensual/por misión/por empresa, Fase 6 de la misión original) — pero
**nunca reordenó la cascada** para poner a Hunter primero, porque hacerlo no era parte
del alcance original de esta rama y es un cambio de comportamiento comercial real
(afecta qué proveedor se intenta primero para cada contacto de cada empresa real) que
no debería decidirse unilateralmente dentro de una auditoría de solo verificación.

**Esto no es un bloqueador de esta rama** (nada se rompió, el comportamiento es el mismo
de antes de este trabajo) — es una discrepancia real entre lo pedido en el ítem 15 de
esta auditoría y el estado actual del producto, que requiere una decisión de negocio
explícita separada. Si se decide invertir la cascada, es un cambio real y acotado
(reordenar 3 bloques dentro de `enrichCompanyWithDecisionContacts`), pero con impacto
en costo/calidad real de contactos descubiertos que merece su propia autorización.

---

## Cambios realizados (resumen, ver `F27_FINAL_MISSION_REPORT.md` y
`F27_INTERNAL_ACCEPTANCE_TEST_REPORT.md` para el detalle completo)

- Máquina de estados de email endurecida (ACCEPTED_BY_PROVIDER/SENT_CONFIRMED/BOUNCED/DELIVERY_UNKNOWN), trazabilidad obligatoria (AuditLog antes y después de cada intento real), reconciliación real contra Sent Items/NDRs de Microsoft Graph.
- `sendGraphMail` ya no es invocable sin una fila `EmailMessage` real que lo autorice.
- Presupuestos reales de People Data Labs (mensual/misión/empresa) y caché real de Hunter.io Domain Search.
- Re-verificación de SPF/DKIM/DMARC con remediación exacta documentada (sin tocar DNS).
- UI: estado real de envío (nunca optimista) en Approvals, panel de administración de reconciliación en Settings.
- Envío real controlado ejecutado y confirmado end-to-end (`SENT_CONFIRMED` real en Sent Items).
- Flujo nuevo "Internal Acceptance Test" (admin-only, marcador doble, nunca confundible con verificación comercial real) para poder probar Approve & Send de punta a punta sin un prospecto real.
- Esta auditoría: 1 regresión real encontrada y corregida (`public.test.ts`), 2 inconsistencias de documentación corregidas.

## Riesgos residuales

1. **Entregabilidad de email degradada** — SPF/DKIM de `dreistaff.com` siguen rotos
   (verificado con `dig` real el 2026-07-25). Requiere acceso a GoDaddy + M365 Admin
   Center que este entorno no tiene. Ver `docs/F27_EMAIL_DNS_REMEDIATION.md` para los
   registros exactos a corregir.
2. **Application Access Policy de Exchange no confirmada** — no se pudo verificar desde
   este entorno si ya existe una política que restrinja la app de Graph a
   `sales@dreistaff.com` únicamente. Ver `docs/F27_EMAIL_SEND_CREDENTIAL_RISK.md`.
3. **Orden de proveedores Hunter/PDL** (ítem 15 de esta auditoría) — decisión de negocio
   pendiente, ver arriba.
4. **2 tests preexistentes, no relacionados, dependientes de estado externo** (LLM real /
   antigüedad de la base de desarrollo compartida) — no son bloqueadores, pero seguirán
   apareciendo como "fallo" en corridas futuras de la suite completa hasta que alguien
   los revise por separado; no están en el alcance de esta rama.
5. **Datos reales de prueba interna sin eliminar** — la Company/Lead/Contact/ApprovalRequest
   (`FAILED`) de la ejecución real de Internal Acceptance Test quedaron en la base,
   claramente marcadas `INTERNAL_TEST`, por decisión explícita de no borrar datos sin
   pedido expreso. IDs exactos en `docs/F27_INTERNAL_ACCEPTANCE_TEST_REPORT.md`.

## Acciones manuales pendientes (fuera del alcance de esta rama)

1. Corregir SPF (`TXT`) y ambos CNAME de DKIM en GoDaddy — valores exactos en `docs/F27_EMAIL_DNS_REMEDIATION.md`.
2. Habilitar la firma DKIM en M365 Admin Center una vez el DNS resuelva.
3. Crear (o confirmar que ya existe) una Application Access Policy de Exchange restringiendo la app a `sales@dreistaff.com`.
4. Rotar `AZURE_CLIENT_SECRET` después de que termine el período de pruebas activo.
5. Decidir si Hunter.io debe pasar a ser el proveedor primario de contactos (ítem 15).
6. Revisar y reconocer/archivar las 10 `EmailReconciliationAlert` (envíos externos no rastreados, históricos) desde el panel de Settings.
7. Decidir si limpiar la Company/Lead/Contact/ApprovalRequest de prueba interna que quedó en la base.

## Checklist de producción

- [x] Build limpio desde cero (cache borrado, reconstruido)
- [x] Typecheck limpio (7/7 workspaces)
- [x] Lint limpio (0 errores)
- [x] Suite completa de tests corrida con el script oficial (`--test-concurrency=1`)
- [x] Migraciones verificadas aditivas, aplicadas sin pérdida de datos
- [x] Sin secretos/credenciales expuestos
- [x] Sin código temporal/de depuración
- [x] Documentación corregida para reflejar el estado real
- [x] Envío real controlado verificado end-to-end al menos una vez
- [x] Flujo comercial real verificado sin cambios de comportamiento
- [ ] SPF/DKIM en estado `pass` (pendiente, acción externa)
- [ ] Application Access Policy de Exchange confirmada (pendiente, acción externa)
- [ ] Decisión de negocio sobre orden Hunter/PDL (pendiente, decisión del usuario)

## Recomendación final

**GO para mergear esta rama a `main`.** Ningún hallazgo de esta auditoría es un
bloqueador del código en sí — el código es correcto, seguro, probado, y no degrada
ningún comportamiento comercial existente. Los 3 puntos pendientes de la checklist son
decisiones/acciones externas al código (DNS/Azure/decisión de producto), ya documentadas
con instrucciones exactas, consistentes con la regla de esta misión de nunca declarar
algo "resuelto" sin evidencia externa que este entorno no puede producir por sí mismo.

Pull Request preparado (título y descripción) más abajo — **no abierto**, a la espera de
tu decisión.

---

## Pull Request preparado (no abierto)

**Título**: `fix(email): traceability hardening, reconciliation, PDL/Hunter budgets, and a gated Internal Acceptance Test flow`

**Descripción**:

```
## Summary
- Stops conflating a Microsoft Graph 202 with a confirmed send; adds a real
  reconciliation mechanism against Graph Sent Items/NDRs and untracked-send alerts.
- Closes the exact gap that produced 10 untracked real sends found during this work:
  sendGraphMail now refuses to run without a real EmailMessage already backing it.
- Adds real, conservative spend guards for People Data Labs and a real cache for
  Hunter.io Domain Search.
- Re-verifies SPF/DKIM/DMARC (still broken -- exact remediation documented, nothing
  auto-changed) and surfaces real send/reconciliation state in the UI.
- Adds a gated, admin-only Internal Acceptance Test flow so Approve & Send can be
  exercised end to end without fabricating a commercial verification for a test
  contact -- structurally incapable of bypassing real commercial verification
  (double marker across two tables, neither writable by any public endpoint).
- One real controlled send was completed and confirmed SENT_CONFIRMED in Sent Items
  during this work; no prospect was ever contacted.

## Test plan
- [x] Full suite via `npm test` (apps/api): 1838 tests, 1831 pass, 2 known
      pre-existing/unrelated failures (real LLM non-determinism; long-lived shared
      dev DB no longer having a "pre-feature" fixture row) -- both confirmed
      unrelated to this diff via root-cause analysis, see RELEASE_READINESS.md.
- [x] typecheck/lint/build clean across all 7 workspaces, from a cleared cache.
- [x] Migrations verified additive only, applied against real dev DB with zero data loss.
- [ ] External: SPF/DKIM fix in GoDaddy/M365 (see docs/F27_EMAIL_DNS_REMEDIATION.md).

See RELEASE_READINESS.md for the full release audit.
```
