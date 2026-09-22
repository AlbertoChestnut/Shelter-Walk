#!/bin/bash
# Daily SQLite backup for the dog-walk tracker.
# Uses sqlite3's .backup command (safe to run against a live, in-use
# database — unlike `cp`, it won't grab a torn/inconsistent copy).
set -euo pipefail

DB_PATH="/opt/dogwalk/app/data/dogwalk.db"
BACKUP_DIR="/opt/dogwalk/backups"
KEEP_DAYS=14
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR"
sqlite3 "$DB_PATH" ".backup '$BACKUP_DIR/db-$STAMP.sqlite3'"
gzip "$BACKUP_DIR/db-$STAMP.sqlite3"

find "$BACKUP_DIR" -name 'db-*.sqlite3.gz' -mtime "+$KEEP_DAYS" -delete
