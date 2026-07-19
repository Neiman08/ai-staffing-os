#!/usr/bin/env bash
# F12.6: backup real de PostgreSQL vía pg_dump, formato "custom"
# (comprimido, soporta restore selectivo con pg_restore -- nunca texto
# plano). Lee DATABASE_URL del .env real del repo por default, o acepta
# un override explícito como primer argumento.
#
# Uso:
#   ./scripts/db-backup.sh                          # usa DATABASE_URL de .env
#   ./scripts/db-backup.sh "postgresql://..."        # URL explícita
#
# Nunca borra ni modifica la base de origen -- pg_dump es de solo
# lectura por diseño.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="$REPO_ROOT/backups"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

SOURCE_URL="${1:-}"
if [ -z "$SOURCE_URL" ]; then
  if [ ! -f "$REPO_ROOT/.env" ]; then
    echo "FATAL: no se pasó una URL y no existe $REPO_ROOT/.env" >&2
    exit 1
  fi
  SOURCE_URL="$(grep -E '^DATABASE_URL=' "$REPO_ROOT/.env" | head -1 | cut -d'=' -f2- | tr -d '"')"
fi

if [ -z "$SOURCE_URL" ]; then
  echo "FATAL: no se pudo resolver DATABASE_URL." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
OUT_FILE="$BACKUP_DIR/ai-staffing-os-$TIMESTAMP.dump"

echo "Backing up to $OUT_FILE ..."
pg_dump --format=custom --compress=9 --no-owner --no-privileges --dbname="$SOURCE_URL" --file="$OUT_FILE"

SIZE="$(du -h "$OUT_FILE" | cut -f1)"
echo "OK: backup real creado -- $OUT_FILE ($SIZE)"
echo "Verificar integridad: pg_restore --list \"$OUT_FILE\" | head"
