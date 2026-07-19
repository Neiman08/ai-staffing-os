#!/usr/bin/env bash
# F12.6: compara conteos de filas reales entre la base de origen y una
# base restaurada -- prueba real de integridad, no solo "el comando de
# restore no tiró error". Cubre las tablas de negocio principales
# (tenant/user/company/lead/opportunity/candidate/worker/joborder/
# placement/assignment/timeentry/invoice/auditlog) más el conteo de
# migraciones aplicadas.
#
# Uso:
#   ./scripts/db-verify-restore.sh <DATABASE_URL origen> <DATABASE_URL restaurada>
set -euo pipefail

SOURCE_URL="${1:-}"
TARGET_URL="${2:-}"

if [ -z "$SOURCE_URL" ] || [ -z "$TARGET_URL" ]; then
  echo "Uso: $0 <DATABASE_URL origen> <DATABASE_URL restaurada>" >&2
  exit 1
fi

TABLES=(
  "Tenant" "User" "Company" "Contact" "Lead" "Opportunity" "Candidate" "Worker"
  "JobOrder" "Placement" "Assignment" "TimeEntry" "Invoice" "Payment" "AuditLog"
  "AgentTask" "Activity" "Notification" "_prisma_migrations"
)

FAILED=0
printf "%-20s %12s %12s %s\n" "Tabla" "Origen" "Restaurada" "Estado"
printf "%-20s %12s %12s %s\n" "-----" "------" "----------" "------"

for table in "${TABLES[@]}"; do
  source_count="$(psql "$SOURCE_URL" -tAc "SELECT count(*) FROM \"$table\";" 2>/dev/null || echo "ERROR")"
  target_count="$(psql "$TARGET_URL" -tAc "SELECT count(*) FROM \"$table\";" 2>/dev/null || echo "ERROR")"

  if [ "$source_count" = "$target_count" ] && [ "$source_count" != "ERROR" ]; then
    status="OK"
  else
    status="MISMATCH"
    FAILED=1
  fi
  printf "%-20s %12s %12s %s\n" "$table" "$source_count" "$target_count" "$status"
done

echo
if [ "$FAILED" -eq 0 ]; then
  echo "OK: todos los conteos coinciden entre origen y restauración."
  exit 0
else
  echo "FALLO: al menos una tabla no coincide -- ver detalle arriba." >&2
  exit 1
fi
