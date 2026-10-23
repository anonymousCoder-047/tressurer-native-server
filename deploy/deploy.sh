#!/usr/bin/env bash
# Deploys the backend on the VPS: pull latest, install deps, run migrations,
# reload PM2. Invoked by the GitHub Actions workflow over SSH — can also be
# run manually:  bash ~/tressurer/deploy/deploy.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${DEPLOY_BRANCH:-master}"

cd "$APP_DIR"
git pull --ff-only origin "$BRANCH"

# .env is not in git — without it there is no DATABASE_URL/JWT_SECRET and
# pg fails deep inside SCRAM with a cryptic error. Fail fast instead.
if [ ! -f .env ]; then
  cp .env.example .env
  echo ">> Created $APP_DIR/.env from .env.example"
  echo ">> Fill in DATABASE_URL, JWT_SECRET, BASE_URL and the OAuth keys, then re-run the deploy."
  exit 1
fi

npm ci --omit=dev

# --- Database backup + migration ---------------------------------------------
# Snapshot BEFORE migrating so a bad migration can be restored; the schema
# itself runs inside one transaction (schema.sql), so a failure rolls back
# cleanly rather than leaving a half-migrated database.
# .env holds DATABASE_URL — export it so pg_dump can use it.
BACKUP_DIR="$APP_DIR/deploy/backups"
mkdir -p "$BACKUP_DIR"
set -a
. ./.env
set +a

STAMP="$(date +%Y%m%d-%H%M%S)"
if command -v pg_dump >/dev/null 2>&1; then
  if pg_dump "$DATABASE_URL" --format=custom --file="$BACKUP_DIR/pre-migrate-$STAMP.dump"; then
    echo ">> DB backup: $BACKUP_DIR/pre-migrate-$STAMP.dump"
    ls -t "$BACKUP_DIR"/pre-migrate-*.dump | tail -n +11 | xargs -r rm -f  # keep last 10
  else
    echo ">> WARNING: pg_dump failed — no pre-migration backup this deploy"
  fi
else
  echo ">> WARNING: pg_dump not installed — no pre-migration backup"
  echo ">> Install on the VPS:  sudo apt-get install -y postgresql-client"
fi

# If this fails, `set -e` aborts before the PM2 reload — the running app keeps
# its old code and the old schema.
npm run db:migrate
echo ">> Migrations applied"

if pm2 describe tressurer >/dev/null 2>&1; then
  pm2 reload ecosystem.config.cjs
else
  pm2 start ecosystem.config.cjs
fi
pm2 save

# Smoke check — fail the deploy if the reloaded app doesn't answer.
sleep 2
curl -fsS "http://127.0.0.1:${PORT:-5000}/api/health" >/dev/null \
  && echo ">> Health check passed" \
  || { echo ">> ERROR: app did not pass /api/health after reload"; exit 1; }

echo "Deploy complete: $(pm2 describe tressurer | grep -m1 status || true)"
