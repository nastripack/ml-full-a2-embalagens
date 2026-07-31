#!/bin/bash
# Backup semanal do D1: exporta, mantem so os ultimos 8 (~2 meses), commita e envia ao GitHub.
set -e
cd "$(dirname "$0")/.."

DATA=$(date +%Y-%m-%d)
ARQUIVO="backups/backup-${DATA}.sql"

npx wrangler d1 export ml-full-a2-embalagens-db --remote --output="$ARQUIVO"

# Mantem so os 8 backups mais recentes
ls -1t backups/backup-*.sql | tail -n +9 | xargs -r rm --

git add backups/
if ! git diff --cached --quiet; then
  git commit -m "Backup semanal do D1 - ${DATA}"
  git push origin main
  echo "Backup ${DATA} commitado e enviado."
else
  echo "Nada novo para commitar (backup identico ao ultimo)."
fi
