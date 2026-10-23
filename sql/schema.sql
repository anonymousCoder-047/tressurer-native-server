-- Tressurer workspace app — PostgreSQL schema
-- Run: npm run db:migrate   (or: psql "$DATABASE_URL" -f sql/schema.sql)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;    -- case-insensitive email

-- ---------------------------------------------------------------------------
-- users: identity comes from OAuth only (google | microsoft) — no passwords.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email            CITEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  avatar_url       TEXT,
  provider         TEXT NOT NULL CHECK (provider IN ('google', 'microsoft')),
  provider_subject TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subject)
);

-- ---------------------------------------------------------------------------
-- workspaces: the tenant boundary. Every business row carries workspace_id.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workspaces (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

-- ---------------------------------------------------------------------------
-- daily_summaries: one row per workspace per business day.
-- opening_balance is captured on the first entry of the day (Opening Balance
-- Rule); closing_balance = opening_balance + net(transactions) and is
-- recalculated after every committed change.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_summaries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  business_date   DATE NOT NULL,
  opening_balance NUMERIC(15, 2) NOT NULL DEFAULT 0,
  closing_balance NUMERIC(15, 2) NOT NULL DEFAULT 0,
  opened_by       UUID NOT NULL REFERENCES users (id),
  opened_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at       TIMESTAMPTZ,
  UNIQUE (workspace_id, business_date)
);

-- ---------------------------------------------------------------------------
-- transactions: income/expense entries belonging to a daily summary.
-- proof_file_path is relative to backend/uploads/ and served only through the
-- authenticated download endpoint.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  summary_id      UUID NOT NULL REFERENCES daily_summaries (id) ON DELETE CASCADE,
  created_by      UUID NOT NULL REFERENCES users (id),
  type            TEXT NOT NULL CHECK (type IN ('income', 'expense')),
  amount          NUMERIC(15, 2) NOT NULL CHECK (amount > 0),
  category        TEXT,
  description     TEXT,
  received_from   TEXT,   -- counterparty on income entries
  paid_to         TEXT,   -- counterparty on expense entries
  proof_file_path TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Counterparty fields added after launch — no-ops on fresh installs.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS received_from TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS paid_to TEXT;

-- ---------------------------------------------------------------------------
-- audit_approval_requests: pending changes proposed by non-admin members.
-- old_values/new_values snapshot the entity as JSONB so an admin can review
-- exactly what would change before approving.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_approval_requests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  requested_by UUID NOT NULL REFERENCES users (id),
  action       TEXT NOT NULL CHECK (action IN ('update', 'delete')),
  entity_type  TEXT NOT NULL DEFAULT 'transaction',
  entity_id    UUID NOT NULL,
  old_values   JSONB,
  new_values   JSONB,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by  UUID REFERENCES users (id),
  reviewed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- audit_log: append-only record of every member action (creates, edits,
-- deletes, approval requests, reviews, balance openings).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id UUID REFERENCES workspaces (id) ON DELETE SET NULL,
  user_id      UUID REFERENCES users (id) ON DELETE SET NULL,
  action       TEXT NOT NULL,
  entity_type  TEXT,
  entity_id    UUID,
  details      JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- transaction_proofs: multiple proof attachments per entry. transactions.
-- proof_file_path is kept in sync as "first proof" for backward compatibility
-- with the single-proof download endpoint and client checks.
-- Limits: 5 MB per file, 25 MB total, enforced in the routes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transaction_proofs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
  file_path      TEXT NOT NULL,
  mime           TEXT,
  original_name  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- trash: soft-deleted entities. payload snapshots the complete original row
-- (plus display fields like business_date) so restores are lossless.
-- Rows auto-expire 30 days after deletion and are purged lazily + daily.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trash (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  entity_type  TEXT NOT NULL DEFAULT 'transaction',
  entity_id    UUID NOT NULL,
  payload      JSONB NOT NULL,
  deleted_by   UUID NOT NULL REFERENCES users (id),
  deleted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days')
);

-- ---------------------------------------------------------------------------
-- email_settings: per-workspace SMTP config (admin-managed). Used for member
-- invites and report sharing. password is stored server-side only and is
-- never returned by the API.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_settings (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
  host         TEXT NOT NULL,
  port         INT NOT NULL DEFAULT 587,
  username     TEXT,
  password     TEXT,
  from_address TEXT NOT NULL,
  secure       BOOLEAN NOT NULL DEFAULT false,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_proofs_tx          ON transaction_proofs (transaction_id);

-- Backfill: entries created before multi-proof support have proof_file_path
-- but no transaction_proofs row — create one per transaction.
INSERT INTO transaction_proofs (transaction_id, file_path, mime, original_name)
SELECT t.id, t.proof_file_path,
       CASE
         WHEN t.proof_file_path ~* '\.(png|jpe?g|gif|webp|heic)$' THEN 'image/*'
         WHEN t.proof_file_path ~* '\.pdf$' THEN 'application/pdf'
       END,
       NULL
FROM transactions t
WHERE t.proof_file_path IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM transaction_proofs p WHERE p.transaction_id = t.id);
CREATE INDEX IF NOT EXISTS idx_trash_ws           ON trash (workspace_id, deleted_at DESC);
CREATE INDEX IF NOT EXISTS idx_trash_expires      ON trash (expires_at);
CREATE INDEX IF NOT EXISTS idx_members_user        ON workspace_members (user_id);
CREATE INDEX IF NOT EXISTS idx_summaries_ws_date   ON daily_summaries (workspace_id, business_date DESC);
CREATE INDEX IF NOT EXISTS idx_tx_summary          ON transactions (summary_id);
CREATE INDEX IF NOT EXISTS idx_tx_ws_created       ON transactions (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_approvals_ws_status ON audit_approval_requests (workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_approvals_entity    ON audit_approval_requests (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_ws_created    ON audit_log (workspace_id, created_at DESC);

COMMIT;
