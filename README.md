# Tressurer — Backend

Multi-tenant finance & audit API for the **Tressurer** mobile app (Expo / React
Native). Express 5 + PostgreSQL, OAuth-only sign-in (Google & Microsoft), PM2 on
Oracle Cloud behind nginx.

**Live:** https://tressurer.crovncrm.com — health check:
[`GET /api/health`](https://tressurer.crovncrm.com/api/health)

## Stack

- Node.js, Express 5, `pg` (PostgreSQL)
- JWT auth minted after backend-mediated OAuth
- Multer in-memory uploads → `uploads/{workspace}/{user}/{date}/`
- Nodemailer for report e-mail
- PM2 process manager + GitHub Actions deploys (see `deploy/`)

## Features

- Google / Microsoft OAuth → deep-link back to the app with a JWT
- Workspaces with `admin` / `member` roles, workspace-scoped everything
- Daily opening/closing balances (entries require an opened day)
- Transactions with multi-proof uploads (images/PDF, 5MB each / 25MB total)
- Member edits & deletes → approval requests; admins apply directly
- Soft-delete trash with 30-day purge, restore, proof backfill
- Reports (CSV / XLSX / PDF exports on the app side), e-mail via SMTP
- Append-only audit log, visible to admins in the app (Settings → Audit log)
- Full workspace wipe on delete (rows, audit entries, and files on disk)

## Local development

```bash
npm ci
cp .env.example .env   # fill in DATABASE_URL, JWT_SECRET, OAuth keys…
npm run db:migrate
npm run dev            # http://localhost:5000
```

## Deploy

Push to `main` → GitHub Actions SSHes into the VPS and runs
`deploy/deploy.sh` (pull, `npm ci --omit=dev`, migrate, PM2 reload).

Full runbook: [`deploy/README.md`](deploy/README.md)
