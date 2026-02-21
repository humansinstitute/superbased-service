#!/bin/sh
set -eu

echo "Waiting for Postgres..."
ATTEMPTS=0
MAX_ATTEMPTS=40

until bun run src/cli/init-db.ts >/tmp/init-db.log 2>&1; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [ "$ATTEMPTS" -ge "$MAX_ATTEMPTS" ]; then
    echo "Database init failed after ${MAX_ATTEMPTS} attempts."
    cat /tmp/init-db.log || true
    exit 1
  fi
  echo "Postgres not ready yet (attempt ${ATTEMPTS}/${MAX_ATTEMPTS}). Retrying in 3s..."
  sleep 3
done

echo "Database ready. Starting service..."
exec bun run src/index.ts
