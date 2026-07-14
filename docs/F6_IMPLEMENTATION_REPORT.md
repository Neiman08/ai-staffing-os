# Reporte de implementación — sesión autónoma F5.4→F5.8 (F6 no iniciado)

**Fecha:** 2026-07-14
**Alcance mandatado:** continuar F5 (F5.4→F5.8) en orden, y solo si F5 queda completamente cerrado y verificado, comenzar F6 siguiendo su documento aprobado. **Límite absoluto: nunca F7.**

**Resultado de esta sesión: F5 quedó completamente cerrado y verificado (F5.1–F5.8). F6 NO se inició** — no existe ningún documento de planificación aprobado para F6 (ver §5 de este reporte). Esto no es un olvido: es el punto de detención correcto según el propio mandato ("comenzar F6 siguiendo el documento aprobado"), aplicando el mismo criterio de "no improvisar ante una decisión de arquitectura sin resolver" que ya se usó para la decisión de Billing (§10.1 del plan F5).

---

## 1. Fases completadas esta sesión

| Fase | Alcance | Estado |
|---|---|---|
| F5.4 | Assignments — ciclo completo | ✅ Cerrado (commit `df172ab`) |
| F5.5 | Compliance & Documents | ✅ Cerrado (commit `ed0a582`) |
| F5.6 | Timesheets | ✅ Cerrado (commit `1dcc8b0`) |
| F5.7 | Payroll (PayrollRun) | ✅ Cerrado (commit `3f8e3d2`) |
| F5.8 | Billing (Invoice + Payment) | ✅ Cerrado (commit `cae6d31`) |
| F6 | Marketing + Integraciones | ⬜ No iniciado — sin documento de planificación aprobado |

Al inicio de esta sesión, F5.1 (Job Orders), F5.2 (Candidates) y F5.3 (Workers) ya estaban cerrados de una sesión anterior. Con el cierre de F5.8, **F5 — Staffing Operations queda 100% implementado y verificado (F5.1–F5.8)**.

---

## 2. Decisión de arquitectura resuelta (bloqueante, con aprobación explícita)

**F5.8 — Modelo de pago de Invoice (plan §10.1).** El propio documento de planificación de F5 dejó esta decisión explícitamente sin resolver, sometiendo dos opciones:

- **Opción A:** campos `paidAmount`/`paidAt` planos en `Invoice`.
- **Opción B (recomendada por el plan):** modelo `Payment` nuevo, con historial completo de pagos parciales.

Se presentó la decisión al usuario vía `AskUserQuestion` antes de tocar schema. **El usuario aprobó la Opción B.** Se implementó exactamente como se aprobó: `balance` siempre derivado (`total - sum(Payment.amount)`), nunca una columna propia.

No hubo ninguna otra decisión de arquitectura que requiriera detenerse a esperar aprobación durante F5.4–F5.7 — cada fase se auditó primero y no encontró vacíos que exigieran una decisión del PO.

---

## 3. Bugs encontrados y corregidos (con causa raíz, impacto y solución)

| # | Bug | Causa raíz | Impacto | Solución | Fase |
|---|---|---|---|---|---|
| 1 | `react-hooks/purity` ESLint error en `CreatePayrollRunForm` | `Date.now()` llamado directamente dentro del objeto inicializador de `useState` | Ninguno en producción (solo lint) — pero indicaba un patrón impuro que podía causar inconsistencias de render | Inicializador perezoso: `useState(() => ({...}))` | F5.7 |
| 2 | Aserción de test incorrecta en el CSV de export | `assert.match(csv, /Worker,Job Order/)` no consideraba que el CSV real cita cada campo (`"Worker","Job Order"`) | Ninguno — el código de producción era correcto; el test estaba mal escrito | Corregida la regex del test, no el código | F5.7 |
| 3 | `page.goto(workerUrl)` fallaba en un script de Playwright | `workerUrl` se capturaba como href relativo (`/workers/xxx`), y `page.goto()` exige URL absoluta | Ninguno en producción — solo afectaba al script de verificación | Prefijo `http://localhost:5173` antes de navegar | F5.4 |
| 4 | Riesgo real de doble facturación (no un bug todavía manifestado, prevenido antes de que ocurriera) | `PayrollItem` no tenía forma de marcar qué `billAmount` ya se facturó | Generar un segundo Invoice para el mismo período habría duplicado el cobro al cliente | Columna `PayrollItem.invoiced` (booleano), migración aditiva, verificada con un test explícito de "no doble facturación" | F5.8 |

Ningún bug real de producción (fuera de tests/lint) llegó a manifestarse sin ser corregido antes de cerrar su fase.

---

## 4. Evidencia técnica por fase

### F5.4 — Assignments
- Contratos: `packages/shared/src/schemas/assignments.ts` (matriz de transición `SCHEDULED→ACTIVE/TERMINATED`, `ACTIVE→COMPLETED/TERMINATED`).
- Backend: `apps/api/src/modules/assignments/{service,router}.ts` — gates de creación (Worker COMPLIANT + AVAILABLE, JobOrder con cupo), recompute derivado de `JobOrder.workersFilled/status` y `Worker.status`.
- Tests: 24 nuevos.
- Frontend: `Assignments.tsx`, `AssignmentDetail.tsx`, integración read-only en `JobOrderDetail.tsx`/`WorkerDetail.tsx`.

### F5.5 — Compliance & Documents
- Backend: `apps/api/src/modules/compliance/{service,router,scheduler}.ts` — sweep periódico (60 min) que deriva `Worker.complianceStatus` de alertas reales no resueltas.
- Tests: 20 nuevos, incluyendo verificación de que el sweep no contamina datos de seed.
- Frontend: `Compliance.tsx` con upload/verify/reject/resolve reales.

### F5.6 — Timesheets
- Backend: extensión de `apps/api/src/modules/payroll/{service,router}.ts` — CRUD de `TimeEntry` + `bulk-approve`.
- Tests: 15 nuevos.
- Frontend: extensión de `Payroll.tsx` con drawer de carga de horas + aprobación en lote.

### F5.7 — Payroll (PayrollRun)
- Permisos: recurso `payrollRuns` agregado a `PERMISSION_RESOURCES` (gap real de RBAC, ya identificado en la auditoría previa).
- Backend: ciclo `DRAFT→PENDING_APPROVAL→APPROVED→PAID→EXPORTED`, separación de funciones (creador ≠ aprobador) verificada con un test real (403 confirmado), export CSV sin storage real.
- Tests: 9 nuevos.
- Frontend: `PayrollRunDetail.tsx` (nueva), pestañas en `Payroll.tsx`.
- Limitación real documentada (no oculta): `TimeEntry.doubleHours` se suma dentro de `otHours` al agregar (aplica 1.5x en vez de 2x) — `PayrollItem` no tiene columna propia para horas dobles desde F0; resolverlo requeriría un cambio de schema no aprobado.

### F5.8 — Billing (Invoice + Payment)
- **Decisión resuelta:** Opción B aprobada (ver §2).
- Migraciones (2, ambas aditivas, aplicadas y verificadas):
  - `20260714180000_f5_8_add_payment_model` — tabla `Payment`, índice, FK a `Invoice`.
  - `20260714183000_f5_8_payroll_item_invoiced` — columna `PayrollItem.invoiced`.
- Permisos: recurso `invoices` + especial `invoices.send` (sujeto a MFA — gap ya documentado desde F4.9 §6, cerrado ahora).
- Backend: `apps/api/src/modules/billing/{service,router,scheduler}.ts` — generación de Invoice desde `PayrollItem` no facturado (PayrollRun `APPROVED`+), `Payment` con balance derivado, PAID/OVERDUE siempre derivados (nunca manuales), sweep de OVERDUE (60 min).
- Tests: 14 nuevos.
- Frontend: `Invoices.tsx`, `InvoiceDetail.tsx`.

---

## 5. Por qué F6 no se inició

El mandato de esta sesión es explícito: *"Solo si F5 está completamente terminado y verificado: comenzar con F6 siguiendo el documento aprobado."*

Se buscó un documento de planificación para F6 en `docs/` y no existe ninguno. `docs/MASTER_PROJECT_STATUS.md` lo confirma directamente: *"F6 (original): Marketing Agent sigue como stub desde F0 (`tools: []`), **sin plan documentado**."*

F6 (Marketing + Integraciones) involucra decisiones reales que no se pueden improvisar: integración con APIs externas (Indeed/LinkedIn), SMS con cumplimiento legal TCPA, y el diseño real del Marketing Agent — exactamente el tipo de decisión de arquitectura que el mandato de esta sesión exige **no** improvisar, sino documentar y esperar aprobación explícita antes de escribir código.

**Conclusión: F6 requiere primero un documento de planificación (mismo patrón que `F5_STAFFING_OPERATIONS_PLAN.md`, `F4_9_PRODUCTION_AUTH_PLAN.md`, etc.), aprobado explícitamente por el usuario, antes de que se pueda comenzar cualquier línea de código de F6.** Esta sesión se detiene aquí, en el cierre de F5, en vez de improvisar ese documento o el código sin aprobación.

---

## 6. Commits de la sesión (29, en orden cronológico)

```
5d662f3 F5.4-0: recurso de permisos "assignments" + grants de rol (seed)
dc9a6e5 F5.4-1: contratos compartidos de Assignments
9ad00d1 F5.4-2/3: CRUD completo de Assignments (service + router)
b2d94ee F5.4-4: tests backend de Assignments CRUD completo (24 tests)
7a980f5 F5.4: agregar filtro de búsqueda a GET /assignments
453439e F5.4-5: interfaz real de Assignments + integración en JobOrderDetail/WorkerDetail
df172ab F5.4: cierre — verificación final y documentación de resultado
74b7095 F5.5-1: contratos compartidos de Documents/Compliance (escritura)
6a77749 F5.5-2/3: escritura real de Documents/Compliance + sweep periódico
e0d0f31 F5.5-4: tests backend de Documents/Compliance (20 tests)
f98f457 F5.5-5: interfaz real de Compliance (upload/verify/reject/resolve)
ed0a582 F5.5: cierre — verificación final y documentación de resultado
9c8da50 F5.6-1: contratos compartidos de Timesheets (escritura)
f6ae173 F5.6-2/3: escritura real de Timesheets (create/edit/bulk-approve)
c7b1fdf F5.6-4: tests backend de Timesheets (15 tests)
96c7e6e F5.6-5: interfaz real de Timesheets (carga + aprobación en lote)
1dcc8b0 F5.6: cierre — verificación final y documentación de resultado
d66ed51 F5.7-0: recurso de permisos "payrollRuns" + grants de rol (seed)
c2b7654 F5.7-1: contratos compartidos de PayrollRun
581dbfc F5.7-2/3: CRUD completo de PayrollRun + ciclo de aprobación + export CSV
a838e38 F5.7-4: tests backend de PayrollRun (9 tests)
c0ad095 F5.7-5: interfaz real de Payroll Runs (creación + ciclo completo + export)
3f8e3d2 F5.7: cierre — verificación final y documentación de resultado
56df64b F5.8-0: modelo Payment (Opción B aprobada por PO) + migración + tenancy
0a1437b F5.8-0b: PayrollItem.invoiced — evita doble facturación
56275f2 F5.8-0c: recurso de permisos invoices + invoices.send + grants de rol
c7327ac F5.8-1: contratos compartidos de Billing (Invoice + Payment)
84b8219 F5.8-2/3: CRUD de Invoice + Payment + ciclo de estado + sweep OVERDUE
13d1241 F5.8-4: tests backend de Billing (14 tests)
d9ec9a5 F5.8-5: frontend de Billing (Invoices.tsx + InvoiceDetail.tsx)
cae6d31 F5.8: cierre — documentación de resultado real (§23), F5 completo
```

---

## 7. Migraciones aplicadas (2, ambas aditivas)

| Migración | Cambio | Reversible sin pérdida de datos |
|---|---|---|
| `20260714180000_f5_8_add_payment_model` | `CREATE TABLE "Payment"` + índice + FK a `Invoice` | Sí — tabla nueva, sin tocar datos existentes |
| `20260714183000_f5_8_payroll_item_invoiced` | `ALTER TABLE "PayrollItem" ADD COLUMN "invoiced" BOOLEAN NOT NULL DEFAULT false` | Sí — columna nueva con default, sin afectar filas existentes |

Ambas verificadas con `prisma migrate status` ("up to date"), `prisma validate` ("valid"), `prisma generate` (cliente regenerado), y typecheck inmediato tras cada una. Ningún `migrate reset`, ningún dato eliminado.

---

## 8. Archivos creados/modificados

- **19 archivos nuevos** (contratos compartidos: `assignments.ts`, `billing.ts`; módulos backend: `assignments/`, `billing/` completos con service/router/scheduler/tests; frontend: `Assignments.tsx`, `AssignmentDetail.tsx`, `PayrollRunDetail.tsx`, `Invoices.tsx`, `InvoiceDetail.tsx`; 2 migraciones).
- **25 archivos modificados** (`permissions.ts`, `seed.ts`, `payroll.ts`/`compliance.ts` (contratos), `schema.prisma`, `prisma-extension.ts`, `router.tsx`, `Sidebar.tsx`, `status.ts`, `app.ts`, `index.ts`, y las páginas de detalle existentes extendidas con secciones read-only nuevas).
- **41 archivos totales cambiados, +6846/-91 líneas** (diff completo de la sesión).

---

## 9. Tests ejecutados y resultado

| Fase | Tests nuevos | Suite completa acumulada al cierre |
|---|---|---|
| F5.4 | 24 | — |
| F5.5 | 20 | — |
| F5.6 | 15 | — |
| F5.7 | 9 | 306/306 |
| F5.8 | 14 | **320/320** |

Suite completa ejecutada repetidamente durante toda la sesión (después de cada cambio de schema, permisos, servicio y router) — **cero fallos, cero regresiones** en ningún punto de la sesión.

---

## 10. Verificación Playwright (navegador real)

Ejecutada para cada fase con datos reales (nunca mockeados), desktop (1440×900) y mobile (iPhone 13, 390×844):

- **F5.4:** ciclo completo Assignment, integración con JobOrderDetail/WorkerDetail.
- **F5.5:** upload/verify/reject/resolve reales; flip observado de `worker-08` de `PENDING` decorativo a `COMPLIANT` derivado (documentado como comportamiento correcto, no revertido).
- **F5.6:** carga y aprobación en lote de horas.
- **F5.7:** ciclo completo hasta `PENDING_APPROVAL`; confirmado que el botón "Aprobar" no aparece para `admin@titan.dev` (separación de funciones visible en la UI, no solo en backend).
- **F5.8:** generación real de Invoice desde un PayrollRun `APPROVED` sembrado ($350) → detalle → envío → pago parcial ($100, balance $250 verificado) → pago final (balance $0, auto-transición a `PAID`, botones de acción correctamente ocultos). Cero errores de consola, cero requests fallidos, en ambos viewports.

Todos los fixtures de verificación se limpiaron después de cada corrida — confirmado que los conteos de datos de seed (`candidates=40`, `workers=10`, `jobOrders=6`) permanecieron sin cambios durante toda la sesión.

---

## 11. Cobertura y regresiones

- **Regresiones verificadas:** ninguna. Cada fase re-ejecutó la suite completa antes de cerrar, confirmando F0–F(n-1) intactos en cada paso.
- **Cobertura:** no se mide con una herramienta de coverage dedicada en este proyecto (no hay `nyc`/`c8` configurado) — la evidencia de cobertura funcional es la suite de tests de integración real contra Postgres (sin mocks de base de datos), consistente con el criterio ya establecido en sesiones anteriores.

---

## 12. Limitaciones conocidas (documentadas, no ocultas)

1. **F5.7:** horas dobles se pagan a 1.5x en vez de 2x (falta columna dedicada en `PayrollItem`).
2. **F5.7:** sin storage real de archivos — export de PayrollRun es CSV directo en la respuesta HTTP.
3. **F5.8:** `dueDate` net-30 hardcodeado (sin campo de términos de pago por Company todavía).
4. **F5.8:** una línea de Invoice por Assignment/worker (no por Job Order) — decisión de implementación, no bloqueante.
5. **F5.3:** disponibilidad de Worker por rango de fechas (`isWorkerAvailable`) sigue sin implementarse — F5.4 solo automatizó el flag binario AVAILABLE/ASSIGNED.
6. **Matching por IA y Dashboards por rol** (parte del checklist original de F5 en el plan) quedaron fuera del alcance mandatado para esta sesión — no se tocaron.

---

## 13. Pendiente para la siguiente sesión

1. **Bloqueante para F6:** redactar y someter a aprobación un documento de planificación para F6 (Marketing + Integraciones), mismo patrón que los planes de F1–F5.
2. Si se desea, cerrar los ítems restantes del checklist original de F5 (§Matching por IA, §Dashboards) — no mandatados explícitamente esta sesión, pero mencionados en el plan original.
3. **Nunca iniciar F7** — mandato explícito y absoluto de esta sesión, que sigue vigente para la próxima.
