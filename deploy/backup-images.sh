#!/bin/bash
# Weekly backup of cached dog photos. These are write-once (never modified
# after first cache) and only grow slowly, so weekly is plenty — unlike the
# database, which changes constantly and gets backed up nightly instead.
# Worth keeping at all because a photo can't be re-fetched once a dog is
# adopted and drops off the shelter's site.
set -euo pipefail

IMAGES_DIR="/opt/dogwalk/app/data/images"
BACKUP_DIR="/opt/dogwalk/backups"
KEEP_WEEKS=4
STAMP="$(date +%Y%m%d)"

mkdir -p "$BACKUP_DIR"
tar czf "$BACKUP_DIR/images-$STAMP.tar.gz" -C "$IMAGES_DIR" .

find "$BACKUP_DIR" -name 'images-*.tar.gz' -mtime "+$((KEEP_WEEKS * 7))" -delete
