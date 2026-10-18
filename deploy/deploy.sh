#!/usr/bin/env bash
# Deploys the backend on the VPS: pull latest, install deps, run migrations,
# reload PM2. Invoked by the GitHub Actions workflow over SSH — can also be
# run manually:  bash /opt/tressurer/deploy/deploy.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${DEPLOY_BRANCH:-master}"

cd "$APP_DIR"
git pull --ff-only origin "$BRANCH"

npm ci --omit=dev
npm run db:migrate

if pm2 describe tressurer >/dev/null 2>&1; then
  pm2 reload ecosystem.config.cjs
else
  pm2 start ecosystem.config.cjs
fi
pm2 save

echo "Deploy complete: $(pm2 describe tressurer | grep -m1 status || true)"
