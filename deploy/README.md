# Deploying the backend to the Oracle VPS

Push-to-deploy via GitHub Actions: every push to `main` SSHes into the VPS and
runs `deploy.sh` (pull → `npm ci` → migrate → PM2 reload). This repo is the
backend itself — the mobile app is a separate repository.

## One-time setup

### 1. Push this repo to GitHub

```bash
cd D:\Tressurer\backend
git init
git remote add origin https://github.com/<you>/tressurer-backend.git
git add -A && git commit -m "Initial commit"
git push -u origin main
```

### 2. Bootstrap the VPS (Ubuntu)

On the server:

```bash
bash setup-vps.sh https://github.com/<you>/tressurer-backend.git
sudo certbot --nginx -d tressurer.crovncrm.com
```

Then edit `/opt/tressurer/.env` (see `.env.example`) — at minimum:
`DATABASE_URL`, `JWT_SECRET`, `BASE_URL=https://tressurer.crovncrm.com`,
`GOOGLE_CLIENT_ID/SECRET`, `MICROSOFT_CLIENT_ID/SECRET`. Then:

```bash
cd /opt/tressurer
npm run db:migrate
pm2 restart tressurer
```

Oracle Cloud note: open port **443/80** in the VCN security list too — UFW alone
isn't enough on OCI.

### 3. GitHub secrets

Repo → Settings → Secrets and variables → Actions:

| Secret | Value |
|---|---|
| `VPS_HOST` | VPS public IP (or hostname) |
| `VPS_USER` | SSH user (e.g. `ubuntu` on OCI) |
| `VPS_SSH_KEY` | Private key for that user |
| `VPS_SSH_PORT` | `22` (or your custom port) |

### 4. OAuth consoles

Add the production callbacks:

- Google: `https://tressurer.crovncrm.com/api/auth/google/callback`
- Azure: `https://tressurer.crovncrm.com/api/auth/microsoft/callback`

## Files

| File | Purpose |
|---|---|
| `.github/workflows/deploy-backend.yml` | CI trigger — SSHes in and runs deploy.sh |
| `deploy/deploy.sh` | The deploy itself (pull, install, migrate, PM2 reload) |
| `deploy/setup-vps.sh` | One-time server bootstrap (Node, PM2, nginx, certbot, ufw) |
| `deploy/nginx.conf` | Reverse proxy `tressurer.crovncrm.com` → `127.0.0.1:5000` |
| `ecosystem.config.cjs` | PM2 process definition (`pm2 start`, logs, autorestart) |

## Useful commands on the VPS

```bash
pm2 logs tressurer          # app logs
pm2 restart tressurer       # restart after .env edits
bash deploy/deploy.sh       # manual deploy, same as CI
```
