# F11 — Analytics e Inteligencia de Negocio: Reporte Final

**Fecha**: 2026-07-18. **Alcance**: F11.1 → F11.11 completadas (F11.12 es este mismo reporte de cierre). Commit inicial `f3d3499`, 11 commits, uno por subfase, ninguno mezclado.

## 1. Arquitectura

F11 es una capa de agregación y presentación sobre datos ya persistidos por F0-F10 — no un nuevo dominio de datos. Backend: un módulo nuevo `apps/api/src/modules/analytics/` (4 endpoints JSON + 3 endpoints de export CSV) más una fundación compartida en `apps/api/src/core/analytics/` (`period.ts` para rangos/comparaciones, `csv.ts` para exportación). Frontend: 4 páginas nuevas bajo `/analytics/*` más 2 componentes compartidos (`AnalyticsPeriodFilter`, `ComparisonBadge`). Contratos Zod nuevos en `packages/shared/src/schemas/analytics.ts` (279 líneas). Cero modelos Prisma nuevos, cero migraciones nuevas, cero permisos nuevos — decisión tomada explícitamente en la auditoría de F11.1 tras revisar la superficie de reporting ya existente (`dashboard/service.ts`, `reports/service.ts`, `revenue/service.ts`, `ai-dashboard/service.ts`) y confirmar que toda la data cruda ya existía con `tenantId`/índices correctos.

## 2. Dashboards

- **Executive Dashboard** (`/analytics`): snapshot cross-dominio (recruiting + comercial + operaciones + financiero) en una sola vista, reutilizando el cálculo exacto de `dashboard/service.ts`/`reports/service.ts`/`revenue/service.ts` (nunca una query duplicada).
- **Recruiting** (`/analytics/recruiting`): funnel sourced→qualified→shortlisted→placed, time-to-fill, efectividad por fuente.
- **Commercial** (`/analytics/commercial`): win-rate, duración de ciclo de venta, conversión de leads.
- **Financial** (`/analytics/financial`): tendencia de margen día por día, antigüedad de facturas, costo de payroll.

Los 3 drill-downs comparten filtro de fecha (`AnalyticsPeriodFilter`) y botón de exportación CSV; todos muestran comparación contra el período anterior equivalente (`ComparisonBadge`) cuando el dato lo permite.

## 3. KPIs

| Dominio | KPI | Fuente real |
|---|---|---|
| Recruiting | Sourced/Qualified/Shortlisted/Placed | `Candidate`, `CandidateQualification`, `CandidateShortlistEntry`, `Placement` |
| Recruiting | Time-to-fill (días promedio) | `JobOrder.createdAt` → primera `Placement.createdAt` real |
| Recruiting | Efectividad por fuente | `Candidate.source` agrupado, cruzado con `Placement` |
| Commercial | Win-rate | `Opportunity.stage` (WON/LOST) |
| Commercial | Duración de ciclo de venta | `Opportunity.createdAt` → `updatedAt` (proxy documentado, sin `closedAt` dedicado) |
| Commercial | Conversión de leads | `Lead.status = CONVERTED` |
| Commercial | Lead→Opportunity (proxy) | companies con Lead que también tienen Opportunity (vía `companyId`, no hay `leadId` en Opportunity) |
| Financial | Margin trend | `TimeEntry` × `Assignment.billRate/payRate` (misma fórmula que dashboard, generalizada) |
| Financial | Invoice aging | `Invoice.total - sum(Payment.amount)`, buckets por `dueDate` |
| Financial | Payroll cost | `PayrollRun.totalGross/totalBill/totalMargin` |

Todos los KPIs son conteos/sumas reales y reproducibles — cero modelo predictivo, cero métrica inventada, consistente con el principio ya establecido en `reports/service.ts` desde F9.11.

## 4. Modelos

Ninguno nuevo. Se leyeron (nunca se escribieron) 13 modelos existentes: `Candidate`, `CandidateQualification`, `CandidateShortlistEntry`, `Placement`, `JobOrder`, `Lead`, `Opportunity`, `TimeEntry`, `Assignment`, `Invoice`, `Payment`, `PayrollRun`, más los ya usados por los servicios reutilizados (`Worker`, `Company`, `ComplianceAlert`, `OperationalIncident`, etc.).

## 5. Endpoints

7 rutas nuevas, todas bajo `/api/v1/analytics/*`, todas gateadas con `requireInternalIdentity()`:

| Método | Ruta | Filtros |
|---|---|---|
| GET | `/analytics/executive` | — |
| GET | `/analytics/recruiting` | `from`, `to` |
| GET | `/analytics/commercial` | `from`, `to` |
| GET | `/analytics/financial` | `from`, `to` |
| GET | `/analytics/recruiting/export` | `from`, `to` (CSV) |
| GET | `/analytics/commercial/export` | `from`, `to` (CSV) |
| GET | `/analytics/financial/export` | `from`, `to` (CSV) |

## 6. UI

4 páginas nuevas (`AnalyticsExecutive`, `AnalyticsRecruiting`, `AnalyticsCommercial`, `AnalyticsFinancial`), nueva entrada "Analytics" en el sidebar interno. Reutiliza `recharts` (ya dependencia), `StatCard`/`PageHeader`/`Card` (ya existentes). Verificado en un navegador real (no solo build/typecheck): las 4 páginas renderizan datos reales sembrados, cero errores de consola, el filtro de fecha re-consulta y reduce resultados correctamente, la exportación CSV dispara una descarga real con el nombre de archivo esperado, y un rol sin permiso ve el estado vacío explícito en vez de un crash.

## 7. Permisos

Cero permisos nuevos. Cada campo se gatea con el permiso de recurso real que ya lo gatea en su propio módulo (`workers.view`, `candidates.view`, `jobOrders.view`, `documents.view`, `assignments.view`, `incidents.view`, `leads.view`, `opportunities.view`, `payrollRuns.view`, `invoices.view`) — mismo patrón field-by-field ya establecido en F6.8/F9.11. Verificado con una matriz de 10 roles derivada directamente de `ROLE_PERMISSIONS` en `seed.ts`.

## 8. Tenancy

Todas las queries vía `scopedDb` (confirmado por grep: cero `prisma.` crudo en el módulo). Verificado en 3 niveles: (1) tests de servicio bajo `runWithTenancyContext` probando que un tenant real ve datos reales y un tenant sin datos ve exactamente cero/vacío, nunca los números de otro tenant; (2) `requireInternalIdentity()` en las 7 rutas, confirmado bloqueando 4 identidades de portal distintas; (3) curl en vivo contra el servidor de desarrollo real.

## 9. Migraciones

Ninguna. `prisma migrate status` confirma 34 migraciones (sin cambio desde el cierre de F10), "Database schema is up to date!".

## 10. Tests

Backend: 1351 tests (1346 pass, 0 fail, 5 skip) — 67 tests nuevos de F11 (period.test.ts, router.test.ts de executive, recruiting.test.ts, commercial.test.ts, financial.test.ts, export.test.ts, tenancy.test.ts). Typecheck y lint limpios en ambas apps.

## 11. E2E

`apps/web/e2e/analytics.spec.ts`, 6 tests nuevos, todos verdes: executive dashboard, filtro+export en Recruiting, estado vacío en Commercial para un rol sin permiso, Financial, redirect de identidad de portal, 403 real por fetch directo. Suite completa: 54/61 pass, 1 fail (pre-existente, `job-order-matching.spec.ts`, documentado desde F8 y no relacionado con F11), 6 skip en cascada del mismo fallo.

## 12. Bugs encontrados

- **F11-B1**: durante la validación final de F11.7, una `Daily Revenue Mission` (`AgentTask`) quedó atascada en `RUNNING` desde una corrida interrumpida anterior en esta misma sesión, bloqueando `missions.test.ts` con un 400 real ("ya hay una misión activa hoy"). Confirmado ajeno a F11 (el módulo de missions nunca se tocó) vía curl directo y una corrida aislada de `missions.test.ts`.

Ningún otro bug encontrado en el código nuevo de F11 durante desarrollo — cada subfase se validó con tests antes de continuar a la siguiente.

## 13. Bugs corregidos

- **F11-B1**: corregido marcando esa única fila de `AgentTask` como `FAILED` (refleja la realidad: nunca terminó) — una corrección de datos, no de código, documentada en el commit de F11.7.

## 14. Deuda técnica

- El filtro `companyId`/`jobCategoryId` mencionado en `docs/F11_PLAN.md` como posible extensión de F11.8 no se implementó — se priorizó `from`/`to` (el filtro realmente pedido explícitamente por el PO) y la exportación CSV. Ningún endpoint lo necesita hoy; se puede agregar de forma aditiva si se pide.
- `salesCycle.averageDays` es un proxy (`Opportunity.updatedAt`, no hay `closedAt` dedicado en el schema) — documentado explícitamente en el código y en este reporte, no oculto.

## 15. Limitaciones

- `conversion.leadToOpportunityRate` es un proxy a nivel de company (no existe `leadId` en `Opportunity`) — no mide conversión de un Lead individual específico a una Opportunity específica, solo si la company de ese Lead terminó teniendo alguna Opportunity.
- El "executive dashboard" no tiene filtro de fecha propio (es un snapshot "ahora") — el detalle histórico vive en los 3 drill-downs, que sí lo tienen.
- No se implementó paginación en `sourceEffectiveness` (lista de fuentes) — en la práctica son pocas fuentes distintas (`referral`, `indeed`, `web`, etc.), no un problema real hoy.

## 16. Estado real de F11

**F11 COMPLETE.**

## 17. Preparación para F12

F11 no tocó ningún código fuera de `apps/api/src/modules/analytics/`, `apps/api/src/core/analytics/`, `packages/shared/src/schemas/analytics.ts`, `apps/web/src/pages/Analytics*.tsx`, `apps/web/src/components/analytics/`, `apps/web/e2e/analytics.spec.ts`, y una línea de registro en `app.ts`/`router.tsx`/`Sidebar.tsx` cada uno — superficie de cambio acotada y aislada, sin ningún cambio a F7-F10. F12 puede empezar sobre una base limpia: git status limpio, 34 migraciones sin cambio, suite completa verde, sin deuda P0/P1 pendiente.

---

## Criterios de cierre (verificados explícitamente)

- ✅ Backend terminado (7 endpoints, 4 servicios + fundación compartida).
- ✅ Frontend terminado (4 páginas + 2 componentes compartidos).
- ✅ Dashboards funcionando (verificado en navegador real, no solo build).
- ✅ KPIs verificados (valores reales confirmados contra datos sembrados, matriz de permisos de 10 roles).
- ✅ Tests verdes (1346/1351 backend, 0 fail; 6/6 e2e nuevos).
- ✅ Build verde (ambas apps).
- ✅ Typecheck verde (ambas apps).
- ✅ Lint verde (ambas apps, mismos 5 warnings preexistentes, 0 errores).
- ✅ Tenant isolation verificado (tests de servicio + rutas + curl en vivo).
- ✅ RBAC verificado (matriz de 10 roles derivada de `ROLE_PERMISSIONS`).
- ✅ Documentación completa (`docs/F11_PLAN.md`, este reporte).

No se hizo push. No se desplegó. No se inició F12.
