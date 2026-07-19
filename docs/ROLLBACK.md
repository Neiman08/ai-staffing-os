# Rollback

F14 (2026-07-19). Procedimiento real para revertir un deploy roto — código y, si hace falta, datos. Extraído a un documento propio (antes vivía repartido entre `docs/RENDER_DEPLOYMENT.md` §6 y `docs/BACKUP_AND_RESTORE.md` §10.5) para que sea lo primero que se abre bajo presión, sin tener que buscar entre dos runbooks distintos.

## 1. Principio general

Este proyecto tiene una política estricta de **migraciones solo-aditivas** (nunca `DROP`/`TRUNCATE`/renombres destructivos/`DELETE` masivo — verificado repetidamente en cada fase desde F1, 35 migraciones al día de este documento, todas aditivas). Esto hace que la inmensa mayoría de los rollbacks reales sean **rollback de código únicamente** — el schema de la base nunca deja de ser compatible con una versión anterior del código, porque nunca se le quita nada, solo se le agrega.

Esto significa: **antes de asumir que hace falta restaurar datos, confirmar que el problema es realmente de datos, no de código.** La mayoría de los incidentes reales de deploy son de código (un bug nuevo, una env var mal configurada) — esos se resuelven revirtiendo el deploy, sin tocar la base.

## 2. Rollback de código (caso común)

1. **Identificar el deploy/commit exacto a revertir.** En el dashboard de Render, cada servicio tiene un historial de deploys — identificar el último deploy sano conocido.
2. **Desde el dashboard de Render**: "Rollback to this deploy" sobre el deploy sano anterior (disponible para servicios `web`/`api` tipo Node/static — Render mantiene el build anterior disponible por un tiempo). Esto es **la vía más rápida** — no requiere un nuevo build ni un revert de Git.
3. **Alternativa vía Git** (si el rollback del dashboard no está disponible o se prefiere dejar rastro explícito en el historial): `git revert <commit-o-rango>` sobre `main` (nunca `git reset --hard` + force-push sobre una rama compartida), push, dejar que CI + el auto-deploy de Render hagan el resto.
4. **Verificar**: `docs/RENDER_SMOKE_TEST.md` §1 (smoke mínimo) completo contra el entorno ya revertido, antes de considerar el incidente cerrado.
5. **Nunca** hace falta tocar `packages/db/prisma/migrations/` en este escenario — el schema ya es compatible (regla del §1). Si la migración más reciente ya se aplicó y el código que la usaba se revirtió, la migración simplemente queda sin uso hasta el próximo deploy hacia adelante — no rompe nada (aditiva, columnas/tablas nuevas nunca se leen si el código viejo no las conoce).

## 3. Rollback de datos (caso raro — solo si el código no alcanza)

Necesario únicamente si el deploy roto **ya escribió datos incorrectos** en producción (no solo tenía un bug de código que nunca llegó a persistir nada malo). Ejemplos reales: una migración con un bug en su lógica de backfill, un job que corrió con la config equivocada y escribió valores mal calculados.

1. `./scripts/db-backup.sh` **inmediato** del estado actual (aunque ya esté afectado — preserva evidencia, nunca se pierde el "antes de intervenir").
2. Seguir el rollback de código primero (§2) — dejar de escribir datos incorrectos nuevos es siempre el primer paso.
3. Restaurar el backup más reciente **anterior al incidente** en una base aislada (`./scripts/db-restore.sh`, que **nunca** permite apuntar a la base principal — ver `docs/BACKUP_AND_RESTORE.md` §6).
4. `./scripts/db-verify-restore.sh` contra esa base aislada — confirmar integridad antes de tocar nada más.
5. Extraer **solo las filas afectadas** de la base aislada y reinsertarlas/corregirlas en producción con una migración de datos revisada a mano — **nunca** sobrescribir toda la base de producción con un restore completo salvo que el incidente sea total (pérdida completa del servicio de base de datos, no solo datos incorrectos puntuales).
6. Documentar el incidente completo: qué se rompió, desde cuándo, cuántas filas se vieron afectadas, cómo se corrigieron — mismo criterio que cualquier operación sensible de este proyecto (`AuditLog` ya registra el actor/acción/timestamp real de la mayoría de escrituras, revisar ahí primero para acotar el alcance exacto).

Procedimiento detallado por tipo de incidente (borrado accidental, migración defectuosa, corrupción, pérdida del servicio): ver `docs/BACKUP_AND_RESTORE.md` §10.

## 4. Rollback de una migración específica

Dado que las migraciones son solo-aditivas, "revertir una migración" casi nunca significa deshacer el `ALTER TABLE`/`CREATE TABLE` en sí (eso arriesgaría perder datos reales que ya se escribieron en la columna/tabla nueva). En cambio:

1. Revertir el código que empezó a usar la migración nueva (§2) — la tabla/columna nueva queda sin uso, no rompe nada.
2. Si la migración en sí tiene un bug (ej. un `DEFAULT` incorrecto, un índice mal definido): escribir una migración **nueva** que corrija el problema hacia adelante (`prisma migrate dev` local para generarla, revisar el SQL generado, nunca editar a mano una migración ya aplicada en producción) — nunca editar ni borrar un archivo de migración ya commiteado y aplicado.

## 5. Checklist post-rollback

- [ ] `docs/RENDER_SMOKE_TEST.md` §1 (smoke mínimo) en verde.
- [ ] Si hubo rollback de datos: `./scripts/db-verify-restore.sh` confirmó integridad antes de promover cualquier cambio a producción.
- [ ] Incidente documentado (qué, desde cuándo, alcance, corrección aplicada).
- [ ] Si la causa raíz fue una migración con bug: la migración correctiva nueva tiene su propio test de regresión donde aplique.
- [ ] Equipo notificado del estado final (servicio sano, versión activa, cualquier dato que haya requerido corrección manual).

## 6. Nunca hacer

- Nunca `prisma migrate reset` contra la base de producción, bajo ninguna circunstancia, ni siquiera durante un incidente.
- Nunca editar o borrar un archivo de migración ya aplicado en producción — siempre una migración nueva hacia adelante.
- Nunca restaurar un backup completo directamente sobre la base principal sin verificarlo antes en una base aislada.
- Nunca hacer `git push --force` sobre `main` como parte de un rollback — usar `git revert` o el rollback nativo del dashboard de Render.
- Nunca declarar un incidente cerrado sin repetir el checklist de smoke test.
