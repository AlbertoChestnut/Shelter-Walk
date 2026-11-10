#!/bin/bash
# Weekly backup of the app's images: cached dog photos (data/images) and the
# pictures staff upload to the Guide (data/wiki-images). Both change far less
# than the database (which is backed up nightly instead), so weekly is
# plenty. Photos are mostly added, but a cached photo can be replaced when the
# shelter posts a new one, and Guide images can be replaced or deleted.
# Worth keeping at all because a dog's photo can't be re-fetched once they're
# adopted and drop off the shelter's site, and Guide images exist nowhere else.
#
# Each archive holds images/ and wiki-images/ side by side. (Archives made
# before 2026-11-10 held only the contents of data/images, with no folder.)
# Restore with: tar xzf images-YYYYMMDD.tar.gz -C /opt/dogwalk/app/data
set -euo pipefail
# Backups are readable by this user only.
umask 077

DATA_DIR="/opt/dogwalk/app/data"
BACKUP_DIR="/opt/dogwalk/backups"
KEEP_WEEKS=4
STAMP="$(date +%Y%m%d)"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
DIRS=()
for d in images wiki-images; do
  [ -d "$DATA_DIR/$d" ] && DIRS+=("$d")
done
if [ "${#DIRS[@]}" -eq 0 ]; then
  echo "no image folders found under $DATA_DIR" >&2
  exit 1
fi
tar czf "$BACKUP_DIR/images-$STAMP.tar.gz" -C "$DATA_DIR" "${DIRS[@]}"

find "$BACKUP_DIR" -name 'images-*.tar.gz' -mtime "+$((KEEP_WEEKS * 7))" -delete
