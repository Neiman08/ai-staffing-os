# F11 — Analytics e Inteligencia de Negocio: Plan

**Autorización**: F11 completo (F11.1→F11.12), autónomo, sin autorización entre subfases, per instrucción del PO tras el cierre de la auditoría pre-F11 (`docs/PRE_F11_FULL_AUDIT_FINAL_REPORT.md`, READY_FOR_F11). Commit base: `9412bb4`.

## 0. Auditoría previa (F11.1)

### 0.1 Superficie de reporting/analytics ya existente

Cuatro endpoints reales ya calculan agregados deterministas sobre datos reales, cada uno con su propio criterio de qué domina:

| Módulo | Endpoint | Qué cubre | Patrón de permisos |
|---|---|---|---|
| `dashboard` | `GET /dashboard/summary` | Workers activos, candidatos por status, fill rate de Job Orders, alertas de compliance, workers por compliance status, assignments por status, serie de 14 días (horas/margen/revenue facturable) | F6.8: omisión de campo por campo según permiso de recurso ya existente (`workers.view`, `candidates.view`, `jobOrders.view`, `documents.view`, `assignments.view`, `payrollRuns.view`\|`invoices.view`) |
| `reports` | `GET /reports/operational` | Onboarding/checklist/compliance evaluations/placements/assignments/timeEntries por status, flags de overtime/discrepancy, shift count, incidents por status/tipo | Mismo patrón F6.8, vía `workers.view`/`documents.view`/`assignments.view`/`timeEntries.view`/`shifts.view`/`incidents.view` |
| `revenue` | `GET /revenue/summary`, `GET /revenue/intelligence` | Leads nuevos, companies contactadas, follow-ups pendientes, pipeline (valor + por stage ponderado), meetings agendadas, companies por industria/estado, top industrias/estados por revenue ganado, oportunidades más grandes abiertas, leads sin follow-up, clientes dormidos | Sin permission check propio (pre-F11: corregido con `requireInternalIdentity()` en la auditoría anterior) |
| `ai-dashboard` | `GET /ai-dashboard/summary` | Actividad y costo/ROI de agentes de IA (companies analizadas, leads/oportunidades creadas por IA, campañas, costo por lead/oportunidad, tiempo estimado ahorrado) | `agents.view` |

**Conclusión de la auditoría**: la infraestructura de agregados deterministas ya existe y es sólida — el patrón field-by-field de F6.8/F9.11 (nunca un permiso "reports.*" inventado, siempre el permiso real que ya gatea ese recurso) es el estándar del proyecto y F11 lo continúa, no lo reemplaza. Lo que **no existe todavía** y es el objeto real de F11:

1. **Vista ejecutiva unificada** — ningún endpoint combina recruiting + comercial + operaciones + financiero en una sola respuesta consumible por un dashboard ejecutivo.
2. **Métricas de reclutamiento (funnel)** — `dashboard/summary` solo tiene `candidatesByStatus`; no existe tasa de conversión del funnel (sourced → qualified → shortlisted → placed), time-to-fill por Job Order, ni efectividad por fuente.
3. **Comparativas temporales** — ningún endpoint compara un período contra el anterior (semana vs. semana anterior, mes vs. mes anterior). `dashboard/summary` tiene una serie de 14 días pero sin comparación agregada.
4. **Filtros** — ningún endpoint acepta query params de rango de fechas, company o categoría; todos devuelven un snapshot fijo ("ahora" o "los últimos N días" hardcodeado).
5. **Exportación** — no existe en ningún endpoint de analítica (sí existe un patrón real de CSV en `payroll/service.ts:exportPayrollRun`, a reutilizar).
6. **Sección de UI dedicada** — no existe una sección "Analytics"/"BI" en el sidebar; las vistas existentes (Dashboard, Revenue, AI Dashboard) están dispersas y no comparten filtros ni exportación.

### 0.2 Modelos de datos

Revisados los 57 modelos de `schema.prisma`. **Ningún modelo nuevo es necesario** — todo dato requerido por los KPIs de F11 (recruiting: `Candidate`, `CandidateQualification`, `CandidateShortlistEntry`, `Placement`, `JobOrder`; comercial: `Lead`, `Opportunity`, `Company`; financiero: `TimeEntry`, `Invoice`, `Payment`, `PayrollRun`, `PayrollItem`, `Assignment`) ya existe y ya tiene `tenantId`/índices correctos (verificado en la auditoría pre-F11 §6/§10). F11 es una capa de agregación y presentación, no un nuevo dominio de datos — consistente con el mandato explícito de reutilizar antes de crear.

### 0.3 Permisos

**Ningún permiso nuevo es necesario.** Cada bloque de cada endpoint de F11 se gatea con el permiso de recurso que YA existe y YA gatea ese dato en su módulo propio (mismo criterio F6.8/F9.11): `candidates.view`/`jobOrders.view` para recruiting, `leads.view`/`opportunities.view` para comercial, `invoices.view`/`payrollRuns.view`/`assignments.view`/`timeEntries.view` para financiero. Todas las rutas nuevas usan además `requireInternalIdentity()` (agregado en la auditoría pre-F11) como segunda capa — son endpoints agregados de alcance interno, nunca deben ser alcanzables por una identidad de portal.

### 0.4 Patrón de exportación a reutilizar

`apps/api/src/modules/payroll/service.ts:exportPayrollRun` + `payroll/router.ts` (`res.header("Content-Disposition", ...).type("text/csv").send(csv)`) — CSV generado server-side, sin librería externa. F11.8 reutiliza exactamente este patrón.

### 0.5 Charting

`recharts` (^2.12.7) ya es una dependencia real, usada en `Dashboard.tsx`/`AIDashboard.tsx`/`Revenue.tsx`. F11.9 reutiliza los mismos componentes (`ResponsiveContainer`, `BarChart`, etc.), sin agregar una librería nueva.

## 1. Subfases

1. **F11.1** — Esta auditoría + este plan.
2. **F11.2** — Fundación backend compartida: helper de rango de fechas/comparación de períodos (`apps/api/src/core/analytics/period.ts` o similar), reutilizable por F11.3-F11.7. Contratos Zod base en `packages/shared/src/schemas/analytics.ts`.
3. **F11.3** — `GET /analytics/executive`: dashboard ejecutivo cross-domain (snapshot actual, sin filtros todavía).
4. **F11.4** — `GET /analytics/recruiting`: funnel real (sourced→qualified→shortlisted→placed), time-to-fill por Job Order, distribución por fuente/categoría.
5. **F11.5** — `GET /analytics/commercial`: extiende revenue con win-rate, duración de ciclo de venta, conversión lead→oportunidad→ganada.
6. **F11.6** — `GET /analytics/financial`: margen/horas facturables/costo de payroll sobre rango configurable, antigüedad de facturas (invoice aging).
7. **F11.7** — Comparativas temporales aplicadas a los 3 endpoints de dominio (F11.4/F11.5/F11.6): período actual vs. período anterior equivalente, delta absoluto y porcentual, siempre determinista (conteo real de dos rangos, nunca una proyección).
8. **F11.8** — Filtros (`from`/`to`/`companyId`/`jobCategoryId` según aplique, Zod-validados) + exportación CSV en los 4 endpoints de analítica.
9. **F11.9** — Frontend: sección "Analytics" en el sidebar, página ejecutiva + 3 páginas de drill-down (Recruiting/Commercial/Financial), filtros UI, botón de exportación.
10. **F11.10** — Pase de endurecimiento RBAC/tenancy/ownership/audit sobre toda la superficie nueva.
11. **F11.11** — E2E (Playwright) de la nueva sección.
12. **F11.12** — Hardening final + `docs/F11_FINAL_REPORT.md`.

## 2. Principios de diseño (recordatorio, ya exigidos por el PO)

- Cero modelos predictivos opacos, cero métricas inventadas — todo número es un conteo/agregado real y reproducible sobre datos ya persistidos, exactamente el mismo criterio ya documentado explícitamente en `reports/service.ts` desde F9.11.
- Toda agregación tenant-scoped vía `scopedDb` — nunca `prisma` crudo.
- Todo endpoint gateado por `requireInternalIdentity()` + permisos de recurso reales (nunca un permiso "analytics.*" inventado).
- Todo cálculo de comparación temporal es una resta entre dos conteos reales de dos rangos de fechas reales — nunca una regresión, nunca un forecast.
- Ninguna migración nueva (no hay modelos nuevos que crear).
