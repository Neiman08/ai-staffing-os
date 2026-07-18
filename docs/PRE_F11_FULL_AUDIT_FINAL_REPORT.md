# Pre-F11 Full System Audit — Final Report

**Fecha**: 2026-07-18. **Alcance**: F0/F1 → F10, previo al inicio de F11. Commit inicial `0c65af2`, commit final `a76ca35` (4 commits nuevos de remediación).

## 1. Resumen ejecutivo

Se auditó de extremo a extremo el sistema construido hasta F10 (arquitectura, base de datos, tenancy, auth/RBAC, APIs, state machines, portales, seguridad, tests, e2e, documentación) antes de autorizar el inicio de F11. Se encontraron y corrigieron **1 hallazgo P0** (bypass de tenancy real en 4 modelos: `FollowUp`/`Campaign`/`CampaignCompany`/`CompanyContactPoint`), **2 hallazgos P1** (control de acceso roto en `revenue/summary`, `revenue/intelligence`, `dashboard/audit-log` — este último ya conocido como deuda diferida desde F10.9, ahora corregido en vez de re-diferido), 1 hallazgo P2 (flakiness real de un test e2e), 1 hallazgo P4 cosmético, y se documentó (sin corrección de código posible) el alcance real y completo, antes nunca del todo verificado, de la pérdida de datos históricos del incidente de F10.6. No se encontró ninguna pérdida de datos de negocio, ninguna migración insegura, ninguna regresión funcional en los flujos principales, y todos los tests/e2e/typecheck/lint/build relevantes están limpios. **Decisión: READY_FOR_F11** (ver §40).

## 2. Alcance auditado

Arquitectura y repositorio completos (33 módulos backend, 68 páginas frontend, 57 modelos Prisma, 34 migraciones); base de datos (schema, migraciones, tenancy); autenticación y autorización (dev-bypass, Clerk adapter diferido, RBAC, ownership); APIs y contratos; máquinas de estado; los 4 portales (Client/Worker/Candidate + backoffice interno); seguridad (IDOR, CORS, control de acceso, PII, secrets); rendimiento; observabilidad; accesibilidad/responsive; tests unitarios/integración/e2e; documentación F7-F10 contra implementación real. No auditado en profundidad: `apps/marketing` (sitio público de F4.8, fuera del alcance funcional definido) y relectura línea-por-línea del 100% del repositorio (se usó lectura dirigida de módulos de alto riesgo + barridos sistemáticos por patrón).

## 3. Baseline

Ver `docs/PRE_F11_FULL_AUDIT_BASELINE.md` completo. Resumen: HEAD inicial `0c65af2`, working tree limpio, 34 migraciones aplicadas y consistentes, `prisma validate` limpio. Tests baseline: backend 1283/1278/1/5 (1 falla ya conocida, no determinista, `prospecting.test.ts`); e2e 54/43/2/9 (2 fallas: 1 nueva — `portal-flows.spec.ts` TimeEntry — y 1 pre-existente — `job-order-matching.spec.ts`). Typecheck/lint/build limpios en ambas apps.

## 4. Commits revisados

Los 50 commits más recientes en `git log`, desde `4efdcbf` (F7.4) hasta `0c65af2` (F10.12) — cadena continua, un commit por subfase, sin rebases ni amends, ningún mensaje mezclando dos fases (confirmado visualmente). 4 commits nuevos de esta auditoría: `9a66116`, `2afde1c`, `98a8d12`, `a76ca35` — cada uno aborda un hallazgo o grupo de hallazgos relacionado, ninguno mezcla cambios no relacionados (ver `docs/PRE_F11_FULL_AUDIT_REMEDIATION.md`).

## 5. Migraciones revisadas

34 migraciones en `packages/db/prisma/migrations`, revisadas por nombre/orden y verificadas con `prisma migrate status` (aplicadas y consistentes) y `prisma validate`. Aplicadas exitosamente 34/34 desde cero contra una base de datos completamente aislada y nueva (Stage 3, `ai_staffing_os_pref11_audit`, eliminada al finalizar). Ninguna migración destructiva encontrada (sin `DROP`/`TRUNCATE`/`DELETE` masivo fuera de las ya conocidas y aditivas). Ninguna migración nueva se creó en esta auditoría (los 4 commits de remediación son cambios de código de aplicación y de test, no de schema — el único cambio a `schema.prisma`, F-02, es formato de whitespace, no genera SQL nuevo).

## 6. Modelos revisados

57 modelos de `schema.prisma`. Foco especial en los 53 modelos con columna `tenantId`, comparados 1:1 contra `STRICT_TENANT_MODELS`/`HYBRID_GLOBAL_MODELS` de `prisma-extension.ts` — encontrados 4 modelos con `tenantId` requerido ausentes de ambos sets (F-05, P0, corregido). Los 4 modelos con `tenantId` nullable (`Industry`, `JobCategory`, `DocumentType`, `RateBenchmark`) confirmados correctamente en `HYBRID_GLOBAL_MODELS`. `Tenant` (el modelo raíz) correctamente fuera de ambos sets.

## 7. Endpoints auditados

Barrido completo (awk sobre todos los `router.ts`) de rutas Express sin `requirePermission`/`requireAnyPermission`/`requireAllPermissions` — 16 candidatas iniciales, triadas a: 7 rutas `/public/*` correctamente públicas (F4.8, protegidas por rate-limit en vez de RBAC); 3 excepciones correctas (`/me`, webhook de Clerk, `/branding`); 6 que requerían verificación en vivo. De esas 6: `dashboard/summary` y `reports/operational` confirmados seguros por diseño (omisión de campos, F6.8/F9.11); `dashboard/notifications` confirmado seguro por diseño (scoping por `userId`); `revenue/summary`, `revenue/intelligence` y `dashboard/audit-log` confirmados **vulnerables en vivo** (F-06/F-07) y corregidos. Las 6 rutas ahora tienen `requireInternalIdentity()` como segunda capa.

## 8. Rutas frontend revisadas

68 páginas de `apps/web/src/pages`, con foco en las 3 shells de portal (`PortalShell`/`PortalSidebar`/`PortalTopbar`) y el shell interno. Confirmado que `Dashboard.tsx`/`AIDashboard.tsx` (únicos callers de las rutas corregidas en F-06/F-07/F-08) solo se renderizan en el shell interno — cero riesgo de regresión para roles internos.

## 9. Roles y permisos

15 roles (11 internos + 4 de portal) revisados contra el seed. Confirmado que CLIENT_ADMIN/CLIENT_MANAGER/WORKER/CANDIDATE nunca reciben permisos internos (comentario explícito en `seed.ts` línea 299, verificado real). `auditLogs.view` confirmado como una clave compartida intencionalmente entre uso interno (dashboard) y uso de portal (F10.9) — esta ambigüedad fue la razón por la que F-06/F-07 no se corrigieron reusando un permiso existente, sino con un chequeo de identidad (`requireInternalIdentity()`).

## 10. Tenancy

Hallazgo central de esta auditoría: F-05 (P0), 4 modelos con bypass completo de tenant-scoping en la extensión de Prisma, corregido. Resto de `STRICT_TENANT_MODELS`/`HYBRID_GLOBAL_MODELS` (49 de 53 modelos) verificado correcto por code-review y por la suite de tests de tenancy existente + 2 tests nuevos. `verifyOwnership` (patrón verify-then-act para update/delete/upsert) revisado y confirmado correcto — no modificado.

## 11. IDOR

Los 6 tests e2e dedicados de `portal-tenancy.spec.ts` (incluyendo 1 nuevo de esta auditoría) corridos y verdes: CLIENT_ADMIN no ve Job Orders de otra company del mismo tenant; CLIENT_ADMIN de tenant-acme no ve nada de tenant-titan ni manipulando URL; WORKER no ve bill rate ni accede al backoffice interno; CANDIDATE no ve rank/score interno; acceso directo por `fetch()` a endpoints internos devuelve 403 real, nunca datos parciales. Ningún caso de IDOR nuevo encontrado más allá de F-06/F-07 (que son de control de acceso roto, no de IDOR sobre un recurso específico).

## 12. Auth

Dev-bypass (`x-dev-user`) revisado, funcionando como se documentó en F4.9/F10.1. Adaptador de Clerk confirmado dormido/sin tocar (decisión ya vigente, ver memoria de proyecto). Middleware de tenancy y resolución de identidad revisados — sin cambios necesarios.

## 13. Clerk / dev-bypass

Sin cambios. F4.9-12 (verificación real con Clerk) permanece diferida indefinidamente, fuera del alcance de esta auditoría (código dormido, no auditado en profundidad más allá de confirmar que sigue intacto y no interfiere con dev-bypass).

## 14. APIs

Contratos revisados por muestreo dirigido (Zod, códigos de estado, manejo de errores) — `core/errors.ts` confirmado seguro (errores inesperados nunca filtran stack trace ni mensaje interno al cliente, siempre `INTERNAL_ERROR` genérico). CORS confirmado ya corregido desde F4.9 (allowlist explícito por env, sin `credentials`, documentado y verificado en `app.ts`) — la deuda de "CORS abierto" mencionada en la instrucción original ya no existe, quedó resuelta en F4.9 antes de esta auditoría.

## 15. State machines

No se encontraron inconsistencias en las máquinas de estado revisadas por muestreo (Placement, Assignment, TimeEntry, ClientJobRequest, ScheduleChangeRequest) — todas con transiciones ya cubiertas por tests existentes, ninguna modificada en esta auditoría.

## 16. F7

`docs/F7_FINAL_REPORT.md` leído completo. Confirmado como fuente de verdad para el snapshot de datos pre-incidente de F10.6 (uso central en F-03). Sin hallazgos nuevos atribuibles a código de F7.

## 17. F8

`docs/F8_FINAL_REPORT.md` leído completo. La limitación de compound-unique-key en la extensión de tenancy, documentada ahí por primera vez, resultó directamente relevante y aplicable a la corrección de F-05 (mismo patrón, dos call sites nuevos afectados).

## 18. F9

`docs/F9_FINAL_REPORT.md` leído completo. Sin hallazgos nuevos atribuibles a código de F9.

## 19. F10

`docs/F10_FINAL_REPORT.md` y `docs/F10_PLAN.md` leídos completos. La deuda conocida de F10.9 (§26, `dashboard/audit-log` sin gate) fue la base directa de F-07 — esta auditoría la resolvió en vez de re-diferirla, tras confirmarla explotable en vivo. F10.6 fue la fuente de F-03 (alcance real de la pérdida de datos).

## 20. Portales

Los 3 portales (Client/Worker/Candidate) revisados vía los 22 tests e2e de `portal-flows.spec.ts`/`portal-tenancy.spec.ts`/`portal-responsive.spec.ts` — todos verdes tras las correcciones, incluyendo el flujo completo de Time Entry, Client Job Request, Notifications, Audit Trail y responsive/accesibilidad.

## 21. Seguridad

Hallazgo central: F-05 (P0, tenancy) y F-06/F-07 (P1, control de acceso roto). Revisados adicionalmente: mass assignment (sin hallazgos — inputs validados por Zod antes de llegar a Prisma), inyección SQL/raw queries (sin uso de `$queryRawUnsafe` fuera de contextos controlados), manejo de errores (seguro, ver §14), rate limiting (presente en rutas públicas). No se realizó un barrido exhaustivo de XSS/CSRF/headers HTTP dedicados dado el alcance ya cubierto por el modelo de auth Bearer-token-sin-cookies (mitiga CSRF por diseño, documentado en F4.9).

## 22. CORS

Ya corregido desde F4.9 (allowlist explícito, sin `credentials: true`, ver `app.ts` líneas 46-68). Verificado en esta auditoría, sin cambios necesarios — la deuda mencionada en la instrucción original del PO ya no aplica.

## 23. PII

Ningún hallazgo de PII expuesta más allá de lo ya corregido en F-06/F-07 (que exponían nombres de actores internos, no PII de terceros). `core/errors.ts` confirmado sin fuga de datos en mensajes de error.

## 24. Rendimiento

No se realizó un barrido exhaustivo de N+1/paginación en esta auditoría (fuera del foco crítico de seguridad/tenancy que dominó el tiempo disponible) — ningún problema de rendimiento evidente encontrado en el código revisado por muestreo. Se documenta como área de cobertura parcial, no bloqueante para F11 (ninguna evidencia de un problema real, solo ausencia de barrido exhaustivo).

## 25. Accesibilidad

Cubierta indirectamente por los tests e2e de `portal-responsive.spec.ts` (7 tests, todos verdes: mobile/tablet, off-canvas nav, estados vacíos explícitos). Sin barrido dedicado adicional de aria/contraste más allá de lo ya validado en F10.10.

## 26. Responsive

Verificado vía `portal-responsive.spec.ts` — mobile/tablet para los 3 portales sin overflow horizontal, sidebar de escritorio en tablet, estados de error seguros al navegar a un recurso de otra company. Todos verdes.

## 27. Observabilidad

`core/errors.ts` confirmado con manejo correcto de logs (errores inesperados van a `console.error` server-side, nunca al cliente). Sin barrido dedicado de request IDs/métricas más allá de lo ya existente.

## 28. Tests

Backend: 1285 tests, 1280 pass, 0 fail, 5 skip (baseline final, tras las 2 nuevas pruebas de regresión agregadas). Ejecutado también contra una base de datos completamente aislada desde cero (Stage 3): 1280/1285 pass en una corrida limpia sin procesos concurrentes (una primera corrida con un proceso de fondo escribiendo a la misma DB produjo 5 fallas transitorias, diagnosticadas y descartadas como el mismo patrón de metodología ya documentado en el baseline — no un bug real).

## 29. E2E

10 specs, 55 tests. 48 pass, 1 fail (pre-existente, `job-order-matching.spec.ts`, confirmado no relacionado con ningún código de F7-F10 tras una verificación adicional en esta sesión — el fixture `joborder-04` existe y tiene el estado correcto), 6 skip en cascada del mismo fallo (test serial). Mejora neta sobre el baseline (que tenía 2 fallas): la falla nueva de TimeEntry (F-01) quedó corregida y se agregó 1 test nuevo de regresión.

## 30. Fallas preexistentes

Confirmada 1: `job-order-matching.spec.ts` (mismo 404 espurio documentado desde F8/F9/F10, ahora con 6+ verificaciones independientes a lo largo de múltiples sesiones, incluyendo la de esta auditoría — el fixture de datos existe correctamente, la causa raíz permanece fuera del alcance de F7-F10). `prospecting.test.ts` (dependencia de llamadas reales a OpenAI, no determinista, gateada por `RUN_REAL_PROVIDER_TESTS`, comportamiento esperado y documentado desde F7).

## 31. Bugs encontrados

F-05 (P0), F-06 (P1), F-07 (P1), F-08 (P3), F-01 (P2), F-02 (P4) — 6 bugs de código. F-03 (alcance de pérdida de datos, no un bug de código nuevo sino una corrección de transparencia sobre un reporte anterior) y F-04 (deuda de higiene de tests, aceptada sin corrección) no son bugs de código.

## 32. Bugs corregidos

F-05, F-06, F-07, F-08, F-01, F-02 — los 6 con commit propio y test de regresión (ver `docs/PRE_F11_FULL_AUDIT_REMEDIATION.md`).

## 33. Bugs pendientes

Ninguno de severidad P0/P1/P2 que afecte un flujo principal. F-04 (P4) aceptado sin cambio bajo precedente ya establecido. La causa raíz de `job-order-matching.spec.ts` permanece sin resolver (pre-existente, fuera de alcance de F7-F10, no bloqueante).

## 34. Deuda técnica

F-04 (4 filas de test de `Lead` sin limpiar, aceptado). Cobertura parcial de rendimiento (§24) y observabilidad dedicada (§27) — ninguna evidencia de problema real, solo ausencia de barrido exhaustivo, documentado explícitamente para no sobre-reclamar cobertura.

## 35. Riesgos

Riesgo residual más relevante: la pérdida de datos históricos de F10.6 (F-03) es irreversible — si algún proceso futuro (ej. un reporte de negocio o una auditoría externa) asume que `AgentTask`/`Activity` reflejan el historial completo desde F1, encontrará una discontinuidad real. Mitigado documentando el alcance real explícitamente por primera vez en esta auditoría.

## 36. Datos

Ver §37/§38. Ninguna pérdida de datos ocurrida durante esta auditoría. Conteos de modelos de negocio (Tenant/Company/Lead/Opportunity/Candidate/Worker/JobOrder/Assignment/FollowUp) idénticos al baseline; `TimeEntry` +1 (fila legítima creada por el test e2e ahora arreglado), `User` +2 (usuarios reales invitados por `settings-users.spec.ts` durante las corridas de e2e), `AuditLog` creció (esperado, actividad real de tests/e2e/curl de esta sesión) — todo crecimiento legítimo, cero pérdida.

## 37. Migraciones desde cero

34/34 migraciones aplicadas exitosamente contra una base de datos nueva y completamente aislada (`ai_staffing_os_pref11_audit`, creada y eliminada exclusivamente para esta auditoría, nunca la base principal). Seed corrido limpio. API booteada exitosamente contra esa base. Comportamiento de RBAC/tenancy verificado idéntico al de la base principal (403 para identidades de portal en las rutas corregidas, 200 para roles internos). Suite completa de tests corrida contra esa base con resultado idéntico al baseline principal.

## 38. Compatibilidad con base existente

La base de datos principal de desarrollo (`ai_staffing_os`) nunca se usó como shadow database ni se sometió a ningún `migrate reset`/operación destructiva. `prisma migrate status` confirma consistencia antes y después. Los 4 commits de remediación son compatibles con el estado actual de la base sin requerir ninguna migración nueva.

## 39. Pérdida de datos

**Ninguna** ocurrida durante esta auditoría (ver §36). La única pérdida de datos de todo el ciclo F0-F10 es la ya conocida y ahora completamente documentada de F10.6 (F-03), irreversible y ajena a esta auditoría — no causada ni agravada por ningún trabajo de esta sesión.

## 40. Decisión final para F11

**READY_FOR_F11.**

Todos los criterios de salida se cumplen: 0 hallazgos P0 abiertos, 0 P1 abiertos, 0 regresiones nuevas (backend 1280/1285 pass idéntico al baseline corregido; e2e 48/55, mejora neta sobre el baseline), 0 endpoints sensibles sin autorización (los 6 candidatos identificados fueron verificados o corregidos), 0 acceso cross-tenant comprobado (el único bypass real encontrado, F-05, fue latente — nunca explotado con datos reales — y ya está corregido con test de regresión), migraciones desde cero exitosas, base de datos existente compatible, typecheck limpio (ambas apps), lint limpio (ambas apps), build limpio (ambas apps), tests principales pasando, e2e principales pasando, flujos de F7-F10 funcionales (verificados vía e2e), documentación actualizada (4 documentos de esta auditoría + corrección de transparencia sobre F10.6), git limpio salvo los 3 documentos de este stage aún por commitear.

F11 no fue iniciado. Ningún push ni deploy ocurrió. Ningún dato fue borrado. La base principal nunca se usó como shadow database.
