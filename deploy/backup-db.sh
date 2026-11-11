#!/bin/bash
# Daily SQLite backup for the dog-walk tracker.
# Uses sqlite3's .backup command (safe to run against a live, in-use
# database — unlike `cp`, it won't grab a torn/inconsistent copy).
set -euo pipefail
# The database holds private notes, so backups are readable by this user only.
umask 077

DB_PATH="/opt/dogwalk/app/data/dogwalk.db"
BACKUP_DIR="/opt/dogwalk/backups"
KEEP_DAYS=14
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
sqlite3 "$DB_PATH" ".backup '$BACKUP_DIR/db-$STAMP.sqlite3'"
gzip "$BACKUP_DIR/db-$STAMP.sqlite3"

# find's -mtime +N means "more than N+1 days old" (it counts whole days and
# rounds down), so +13 is what keeps 14 days.
PRUNE_MTIME="+$((KEEP_DAYS - 1))"
find "$BACKUP_DIR" -name 'db-*.sqlite3.gz' -mtime "$PRUNE_MTIME" -delete
# The copies taken before each deploy (pre-deploy-<UTC timestamp>/: a code
# tarball and a copy of the database) follow the same 14-day policy.
# Create them as the dogwalk user (sudo -u dogwalk mkdir ..., or chown -R
# dogwalk: the folder afterwards) so this script, which runs as dogwalk, can
# prune them. One it can't remove (left root-owned) is reported but never
# stops the nightly backup above from being kept.
if ! find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -name 'pre-deploy-*' -mtime "$PRUNE_MTIME" -exec rm -rf -- {} +; then
  echo "backup-db: some pre-deploy-* folders could not be removed (owned by root?). Prune them as root, or create them as dogwalk." >&2
fi
