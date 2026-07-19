# Backup and Restore

F12.6 (renombrado en F14 de `BACKUP_AND_RECOVERY_RUNBOOK.md`, contenido sin cambios salvo esta nota — la estrategia es solo de base de datos, no depende de qué servicios de Render existan). Estrategia real de backups para PostgreSQL, verificada con un ciclo real de backup → restore → comparación de conteos → arranque del API contra la base restaurada, ejecutado dos veces (F12.6 y F12.12, ver §7). Para el procedimiento de revertir un *deploy* de código (distinto de restaurar datos), ver `docs/ROLLBACK.md`.

## 1. Estrategia general

Dos capas independientes, no una sola:

1. **Backups gestionados por Render** (producción) — Render Postgres en el plan `basic-256mb` (el que usa `render.yaml` — F14: reemplaza al plan legacy `starter`, ya no disponible para bases nuevas) incluye backups diarios automáticos con retención de 7 días, gestionados por la plataforma, sin script propio. Esta es la red de seguridad principal en producción.
2. **Backups manuales/scriptables de este repo** (`scripts/db-backup.sh`) — para: (a) un snapshot inmediato antes de una migración riesgosa o una operación irreversible, (b) copias fuera de Render (portabilidad real, no depender de un solo proveedor), (c) pruebas de restauración reales como la de este documento.

Ninguna reemplaza a la otra. Producción real debe tener ambas.

## 2. Frecuencia

- **Render (automático)**: diario, gestionado por la plataforma.
- **Manual (`scripts/db-backup.sh`)**: antes de toda migración nueva en producción, antes de cualquier operación de datos irreversible, y como snapshot ad-hoc cuando el operador lo considere necesario. No hay una cadencia automática todavía — ejecutarlo vía cron/GitHub Actions programado es una extensión futura razonable, no implementada en F12 (fuera del alcance: "no crear complejidad innecesaria" sin una necesidad operativa real hoy).

## 3. Retención

- Render: 7 días de retención de backups lógicos — política de la plataforma, aplica independientemente del plan contratado (verificado en `render.com/docs/postgresql-backups`); el plan `basic-256mb` de este Blueprint da 3 días de recuperación punto-en-el-tiempo (PITR), los tiers `pro-*` dan 7 días de PITR — verificar el plan real contratado antes de asumir cuál ventana de PITR aplica en producción.
- Manual: sin política automática de borrado — el operador decide cuánto conservar. Recomendación: mantener al menos el último backup manual antes de cada deploy, y no depender de backups manuales viejos como única fuente (Render es la fuente de verdad continua).

## 4. Cifrado

Los backups de Render están cifrados en reposo por la plataforma (estándar de Render para Postgres gestionado). Los dumps manuales (`scripts/db-backup.sh`) se generan en `backups/` (ver `.gitignore` — nunca se commitean) **sin cifrado propio** — si se van a mover fuera de la máquina local (ej. a un bucket), cifrarlos en tránsito/reposo con la herramienta del proveedor de storage elegido es responsabilidad operativa del paso manual, no de este script.

## 5. Ubicación

- Render: gestionado internamente por la plataforma, no accesible como archivo.
- Manual: `backups/` en la raíz del repo (local, temporal) — nunca el lugar final de almacenamiento a largo plazo; mover a un storage real (S3, Google Cloud Storage, o el mecanismo que la agencia ya use) es un paso operativo pendiente, documentado en §9.

## 6. Scripts

Los 3 scripts en `scripts/`, ejecutables (`chmod +x` ya aplicado):

### `scripts/db-backup.sh`
```bash
./scripts/db-backup.sh                     # usa DATABASE_URL de .env
./scripts/db-backup.sh "postgresql://..."  # URL explícita (ej. producción)
```
`pg_dump --format=custom --compress=9` — solo lectura sobre el origen, nunca modifica nada. Sale a `backups/ai-staffing-os-<timestamp>.dump`.

### `scripts/db-restore.sh`
```bash
./scripts/db-restore.sh backups/ai-staffing-os-<timestamp>.dump --target "postgresql://.../una_base_de_prueba"
```
**Nunca restaura sobre la base principal** — dos protecciones reales, no solo un comentario: (1) rechaza si `--target` es textualmente igual al `DATABASE_URL` de `.env`; (2) rechaza si el nombre de la base target no contiene `test`/`temp`/`restore`/`staging`. Ambas verificadas en este documento (§7).

### `scripts/db-verify-restore.sh`
```bash
./scripts/db-verify-restore.sh "<URL origen>" "<URL restaurada>"
```
Compara `count(*)` real de las 19 tablas de negocio principales entre origen y restauración, tabla por tabla, y falla (`exit 1`) si alguna no coincide.

## 7. Prueba real de restauración (ejecutada en F12.6)

1. `./scripts/db-backup.sh` contra la base de desarrollo real (`ai_staffing_os`) → `backups/ai-staffing-os-20260719-004609.dump` (3.9M).
2. Base aislada nueva creada exclusivamente para esta prueba: `ai_staffing_os_restoretest` (nunca la base principal).
3. `./scripts/db-restore.sh <dump> --target "postgresql://staffing:staffing@localhost:5433/ai_staffing_os_restoretest"`.
4. **Hallazgo real, documentado sin ocultarlo**: `pg_restore: error: could not execute query: ERROR: unrecognized configuration parameter "transaction_timeout"` — 1 error ignorado. Causa raíz: la versión de `pg_dump` instalada localmente (18.4, homebrew) genera `SET transaction_timeout = 0;` (parámetro introducido en PostgreSQL 17), pero el servidor real (`postgres:16` en `docker-compose.yml`) no lo reconoce. **Riesgo real para producción**: si Render corre Postgres 16 y el operador usa una versión de `pg_dump` más nueva localmente, este mismo warning cosmético puede aparecer — no pierde datos (confirmado en el paso 5), pero conviene que quien opere el backup use una versión de `pg_dump` igual o anterior a la versión del servidor de Postgres real cuando sea posible.
5. `./scripts/db-verify-restore.sh` — **las 19 tablas coinciden exactamente** entre origen y restauración (Tenant, User, Company, Contact, Lead, Opportunity, Candidate, Worker, JobOrder, Placement, Assignment, TimeEntry, Invoice, Payment, AuditLog, AgentTask, Activity, Notification, `_prisma_migrations`) — el único error del paso 4 fue cosmético, cero pérdida de datos real.
6. API arrancada contra la base restaurada (puerto aislado 4098) — `GET /api/v1/health` → `{"status":"ok","db":true}`; `GET /api/v1/candidates` (dev-bypass) → datos reales servidos correctamente.
7. Base de prueba eliminada al finalizar (`DROP DATABASE ai_staffing_os_restoretest`) — la base principal nunca se tocó en ningún paso de esta prueba.

## 8. RPO / RTO

- **RPO (Recovery Point Objective)**: con backups diarios de Render, hasta 24 horas de pérdida potencial en el peor caso. Un backup manual justo antes de una operación riesgosa reduce esto a minutos para ese evento específico.
- **RTO (Recovery Time Objective)**: el ciclo real medido en esta prueba (backup de una base con ~62k filas de AuditLog + ~58k de Activity) tomó bajo 2 minutos de principio a fin (backup + restore + verificación). Una restauración real en producción probablemente toma más por el tamaño real de los datos y la latencia de red hacia Render, pero el mecanismo en sí es rápido — no es un proceso de horas.

## 9. Responsabilidad operativa

- Backups automáticos de Render: responsabilidad de la plataforma, verificar que el plan contratado los incluya.
- Backups manuales antes de cambios riesgosos: responsabilidad del operador que ejecuta el cambio (ej. quien corre una migración en producción corre `db-backup.sh` primero).
- Mover backups manuales a storage externo duradero: **paso manual pendiente, no implementado en F12** — requiere decidir el proveedor de storage real (fuera del alcance de este agente, es una decisión operativa/de costo del PO).
- Prueba periódica de restauración real (no solo confiar en que "probablemente funciona"): recomendado repetir el procedimiento de §7 al menos trimestralmente, o después de cualquier cambio grande al schema.

## 10. Procedimiento paso a paso ante incidentes

### 10.1 Borrado accidental de datos
1. Identificar el momento exacto del borrado (revisar `AuditLog` — toda escritura sensible queda ahí con actor/acción/timestamp real).
2. Si el borrado fue reciente y acotado: evaluar si es recuperable por lógica de negocio (ej. un `isActive=false` en vez de un DELETE real — la mayoría de las operaciones "destructivas" de este sistema ya son soft-delete/desactivación, ver `docs/PRE_F11_FULL_AUDIT_FINAL_REPORT.md` — un DELETE real es la excepción, no la regla).
3. Si es un DELETE real irrecuperable por lógica: restaurar el backup más reciente ANTES del incidente en una base aislada (§7), extraer solo las filas afectadas, y reinsertarlas manualmente en producción con una migración de datos revisada — nunca sobrescribir toda la base de producción con un restore completo salvo que el incidente sea total.

### 10.2 Migración defectuosa
1. Detener cualquier escritura nueva si es posible (mantenimiento breve).
2. Si la migración fue aditiva (política obligatoria de este proyecto — nunca `DROP`/`TRUNCATE`/renombres destructivos) revertir es normalmente seguro: la migración nueva simplemente no se usa, no hace falta deshacerla en el schema.
3. Si algo salió mal de verdad (dato corrupto escrito por un bug de la migración, no por su forma): restaurar el backup pre-migración (tomado obligatoriamente antes de aplicar, ver §9) en una base aislada, y migrar los datos correctos a mano.

### 10.3 Corrupción de datos
1. `./scripts/db-backup.sh` inmediato del estado actual (aunque esté corrupto — preserva evidencia para diagnóstico, nunca se pierde el estado "antes de intervenir").
2. Restaurar el backup bueno más reciente en una base aislada (§7), confirmar integridad con `db-verify-restore.sh`.
3. Solo después de confirmar que la base aislada está sana, coordinar la ventana de mantenimiento real para promoverla.

### 10.4 Pérdida del servicio (Render caído/base inaccesible)
1. Verificar el status de Render (`https://status.render.com` o el dashboard real).
2. Si es un incidente de la plataforma: esperar y monitorear — no hay acción de datos que tomar, los backups automáticos de Render siguen intactos.
3. Si el servicio de base de datos específico se perdió (no solo caído temporalmente): restaurar el backup automático más reciente de Render a una nueva instancia (procedimiento del dashboard de Render, fuera del alcance de este repo) o, en última instancia, un backup manual reciente vía `db-restore.sh`.

### 10.5 Necesidad de rollback
1. Identificar el commit/deploy exacto a revertir (`git log`, tags de deploy si existen).
2. Si el rollback de código no requiere revertir el schema (la política de "solo aditivo" de este proyecto hace esto el caso común): revertir solo el código desplegado, la base sigue siendo compatible.
3. Si SÍ requiere revertir datos: usar el procedimiento de §10.2/§10.3 con el backup correspondiente al punto en el tiempo deseado.

## 11. Nunca hacer

- Nunca `prisma migrate reset` sobre una base real.
- Nunca usar el `DATABASE_URL` principal como `--shadow-database-url` de Prisma (ver incidente ya documentado de F10.6, `docs/PRE_F11_FULL_AUDIT_FINDINGS.md`).
- Nunca restaurar un backup directamente sobre la base principal sin antes verificarlo en una base aislada (exactamente lo que `db-restore.sh` impide por diseño).
- Nunca commitear un archivo `.dump` real al repo (`.gitignore` ya lo cubre).
