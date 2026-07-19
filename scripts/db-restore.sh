#!/usr/bin/env bash
# F12.6: restaura un backup real (creado por db-backup.sh) contra una
# base de datos AISLADA -- exige un --target explícito, y se niega a
# correr si ese target es textualmente igual al DATABASE_URL real del
# repo. Esto es la protección real contra "restaurar por accidente
# encima de la base principal", no solo una advertencia en un comentario.
#
# Uso:
#   ./scripts/db-restore.sh <archivo.dump> --target "postgresql://.../db_temporal"
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DUMP_FILE="${1:-}"
TARGET_FLAG="${2:-}"
TARGET_URL="${3:-}"

if [ -z "$DUMP_FILE" ] || [ "$TARGET_FLAG" != "--target" ] || [ -z "$TARGET_URL" ]; then
  echo "Uso: $0 <archivo.dump> --target <DATABASE_URL de una base AISLADA>" >&2
  exit 1
fi

if [ ! -f "$DUMP_FILE" ]; then
  echo "FATAL: no existe el archivo $DUMP_FILE" >&2
  exit 1
fi

MAIN_URL=""
if [ -f "$REPO_ROOT/.env" ]; then
  MAIN_URL="$(grep -E '^DATABASE_URL=' "$REPO_ROOT/.env" | head -1 | cut -d'=' -f2- | tr -d '"')"
fi

if [ -n "$MAIN_URL" ] && [ "$TARGET_URL" = "$MAIN_URL" ]; then
  echo "FATAL: --target es exactamente igual al DATABASE_URL principal de .env." >&2
  echo "Este script nunca restaura sobre la base principal -- usa una base aislada real." >&2
  exit 1
fi

# Segunda red de seguridad: el nombre de la base target debe contener
# algo que indique que es temporal/de prueba -- evita un typo que
# apunte por error a una base real de otro entorno con un nombre
# parecido pero no idéntico al de .env.
case "$TARGET_URL" in
  *test*|*temp*|*restore*|*staging*) ;;
  *)
    echo "FATAL: el nombre de la base target no contiene 'test'/'temp'/'restore'/'staging'." >&2
    echo "Por seguridad, este script exige que el nombre de la base deje explícito que es aislada." >&2
    echo "Target recibido: $TARGET_URL" >&2
    exit 1
    ;;
esac

echo "Restaurando $DUMP_FILE en $TARGET_URL ..."
pg_restore --clean --if-exists --no-owner --no-privileges --dbname="$TARGET_URL" "$DUMP_FILE"
echo "OK: restore completado en la base aislada."
echo "Verificar con: ./scripts/db-verify-restore.sh <DATABASE_URL origen> \"$TARGET_URL\""
