#!/usr/bin/env bash
# One-time bootstrap for a fresh Oracle Cloud Ubuntu instance.
# Run as a sudo-capable user:  bash setup-vps.sh <backend-git-repo-url>
# e.g. bash setup-vps.sh https://github.com/you/tressurer-backend.git
set -euo pipefail

REPO_URL="${1:?Usage: bash setup-vps.sh <backend-git-repo-url>}"
APP_DIR=~/tressurer

# --- System packages --------------------------------------------------------
sudo apt-get update
sudo apt-get install -y nginx git curl ufw postgresql-client

# Node 22 LTS via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# PM2
sudo npm install -g pm2

# --- App (this repo IS the backend) -----------------------------------------
mkdir -p "$APP_DIR"
git clone "$REPO_URL" "$APP_DIR"
cd "$APP_DIR"
npm ci --omit=dev

# .env is NOT in git — create it now (see .env.example), especially:
#   DATABASE_URL, JWT_SECRET, BASE_URL=https://tressurer.crovncrm.com,
#   GOOGLE_CLIENT_ID/SECRET, MICROSOFT_CLIENT_ID/SECRET
if [ ! -f .env ]; then
  cp .env.example .env
  echo ">> Edit $APP_DIR/.env before starting the app <<"
fi

mkdir -p uploads

# --- Nginx + TLS ------------------------------------------------------------
sudo cp "$APP_DIR/deploy/nginx.conf" /etc/nginx/sites-available/tressurer
sudo ln -sf /etc/nginx/sites-available/tressurer /etc/nginx/sites-enabled/tressurer
sudo nginx -t
sudo systemctl reload nginx

sudo apt-get install -y certbot python3-certbot-nginx
echo ">> Run: sudo certbot --nginx -d tressurer.crovncrm.com <<"

# --- Firewall ---------------------------------------------------------------
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw --force enable

# --- Start ------------------------------------------------------------------
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd   # prints a sudo command — run it to survive reboots

echo "Done. Edit .env, then: pm2 restart tressurer"
