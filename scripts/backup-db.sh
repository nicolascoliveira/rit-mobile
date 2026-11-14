#!/bin/bash
# ==============================================================================
# RIT SAAS — SCRIPT DE BACKUP A QUENTE DE PRODUÇÃO (SQLITE WAL + POSTGRES)
# ==============================================================================
# Execução recomendada via Cron diariamente (ex: às 03:00 da manhã):
#   0 3 * * * /bin/bash /opt/rit/scripts/backup-db.sh >> /var/log/rit-backup.log 2>&1
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
DATA_DIR="${DATA_DIR:-$ROOT_DIR/data}"
BACKUP_DIR="${BACKUP_DIR:-$DATA_DIR/backups/daily_archives}"
TIMESTAMP="$(date +'%Y-%m-%d_%H%M%S')"
DATE_TAG="$(date +'%Y-%m-%d')"

mkdir -p "$BACKUP_DIR"

echo "[$(date +'%T')] Iniciando rotina de backup de produção da Rit..."

# 1. Snapshot a quente do banco SQLite principal (rit.db)
SQLITE_DB="$DATA_DIR/rit.db"
SQLITE_DEST="$BACKUP_DIR/rit-db-$TIMESTAMP.sqlite"
API_CONTAINER="$(docker ps --format '{{.Names}}' | grep -E '(^|[-_])api([_-]|$)' | head -n 1 || true)"

if [ -f "$SQLITE_DB" ]; then
    echo "[$(date +'%T')] Criando snapshot atômico do SQLite (rit.db)..."
    if command -v sqlite3 >/dev/null 2>&1; then
        sqlite3 "$SQLITE_DB" "PRAGMA wal_checkpoint(TRUNCATE);"
        sqlite3 "$SQLITE_DB" ".backup '$SQLITE_DEST'"
    elif [ -n "$API_CONTAINER" ] && [ "$DATA_DIR" = "$ROOT_DIR/data" ]; then
        docker exec "$API_CONTAINER" node -e "import('node:sqlite').then(async ({ DatabaseSync, backup }) => { const db = new DatabaseSync('/data/rit.db'); await backup(db, '/data/backups/daily_archives/rit-db-${TIMESTAMP}.sqlite'); db.close(); })"
    else
        # Fallback caso sqlite3 CLI não esteja no host e container api não esteja rodando
        cp "$SQLITE_DB" "$SQLITE_DEST"
        [ -f "${SQLITE_DB}-wal" ] && cp "${SQLITE_DB}-wal" "${SQLITE_DEST}-wal" || true
        [ -f "${SQLITE_DB}-shm" ] && cp "${SQLITE_DB}-shm" "${SQLITE_DEST}-shm" || true
    fi
    echo "[$(date +'%T')] Snapshot SQLite concluído: $SQLITE_DEST"
else
    echo "[$(date +'%T')] Aviso: rit.db não encontrado em $DATA_DIR"
fi

# 2. Dump do PostgreSQL da Evolution API (WhatsApp)
PG_DEST="$BACKUP_DIR/evolution-pg-$TIMESTAMP.sql.gz"
PG_CONTAINER="$(docker ps --format '{{.Names}}' | grep "evolution-postgres" | head -n 1 || true)"
if [ -n "$PG_CONTAINER" ]; then
    echo "[$(date +'%T')] Exportando banco PostgreSQL da Evolution API ($PG_CONTAINER)..."
    if docker exec "$PG_CONTAINER" sh -c 'pg_dump -U "${POSTGRES_USER:-evolution}" "${POSTGRES_DB:-evolution}"' | gzip > "${PG_DEST}.tmp"; then
        mv "${PG_DEST}.tmp" "$PG_DEST"
        echo "[$(date +'%T')] Dump PostgreSQL concluído: $PG_DEST"
    else
        rm -f "${PG_DEST}.tmp"
        echo "[$(date +'%T')] Aviso: falha ao exportar banco PostgreSQL da Evolution API" >&2
    fi
fi

# 3. Compactação de mídias customizadas dos exercícios (uploads/)
UPLOADS_DIR="$DATA_DIR/uploads"
if [ -d "$UPLOADS_DIR" ] && [ "$(ls -A "$UPLOADS_DIR")" ]; then
    echo "[$(date +'%T')] Compactando fotos e vídeos de exercícios customizados..."
    tar -czf "$BACKUP_DIR/uploads-$DATE_TAG.tar.gz" -C "$DATA_DIR" uploads
fi

# 4. Rotação local (mantém os últimos 14 dias de backups)
echo "[$(date +'%T')] Limpando arquivos de backup locais com mais de 14 dias..."
find "$BACKUP_DIR" -type f -name "rit-db-*" -mtime +14 -delete
find "$BACKUP_DIR" -type f -name "evolution-pg-*" -mtime +14 -delete
find "$BACKUP_DIR" -type f -name "uploads-*" -mtime +14 -delete

# 5. Opcional: Envio Offsite para AWS S3 ou Cloudflare R2
if [ -n "${BACKUP_S3_BUCKET:-}" ] && command -v aws >/dev/null 2>&1; then
    echo "[$(date +'%T')] Sincronizando com armazenamento em nuvem S3: $BACKUP_S3_BUCKET..."
    aws s3 sync "$BACKUP_DIR" "s3://$BACKUP_S3_BUCKET/rit-backups/" --delete
fi

echo "[$(date +'%T')] Rotina de backup concluída com sucesso!"
