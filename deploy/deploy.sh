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
npm run db:migrate

if pm2 describe tressurer >/dev/null 2>&1; then
  pm2 reload ecosystem.config.cjs
else
  pm2 start ecosystem.config.cjs
fi
pm2 save

echo "Deploy complete: $(pm2 describe tressurer | grep -m1 status || true)"
