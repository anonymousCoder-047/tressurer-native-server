const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../config/db');
const authRequired = require('../middleware/auth');
const { requireRole } = require('../middleware/workspace');
const { logAudit, recalcClosingBalance } = require('../utils/audit');
const { sendWorkspaceMail } = require('../utils/mailer');
const { UPLOADS_ROOT, resolveUpload, sanitizeSegment } = require('../utils/files');
const { payloadProofPaths } = require('../utils/trash');

const router = express.Router();
router.use(authRequired);

// Most recent closing balance before `date` for a workspace (the balance the
// Opening Balance Rule references).
// Full sweep of uploads/{workspaceName}: deletes every file no longer
// referenced by ANY transaction_proofs/transactions row (covers orphans left
// by failed uploads and files a same-named workspace does NOT own), then
// removes all empty dirs bottom-up — including the workspace folder itself.
const wipeWorkspaceDir = async (wsDir) => {
  if (!fs.existsSync(wsDir)) return;
  const entries = await fs.promises.readdir(wsDir, { withFileTypes: true, recursive: true });

  for (const e of entries) {
    if (!e.isFile()) continue;
    const abs = path.join(e.parentPath ?? e.path, e.name);
    const rel = path.relative(UPLOADS_ROOT, abs).split(path.sep).join('/');
    const { rows } = await db.query(
      `SELECT 1 FROM transaction_proofs WHERE file_path = $1
       UNION SELECT 1 FROM transactions WHERE proof_file_path = $1
       LIMIT 1`,
      [rel]
    );
    // Referenced by a surviving workspace → keep it.
    if (!rows.length) await fs.promises.unlink(abs).catch(() => {});
  }

  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(e.parentPath ?? e.path, e.name))
    .sort((a, b) => b.length - a.length); // deepest first
  for (const d of dirs) await fs.promises.rmdir(d).catch(() => {});
  await fs.promises.rmdir(wsDir).catch(() => {});
};

const previousClosingBalance = async (executor, workspaceId, date) => {
  const { rows } = await executor.query(
    `SELECT closing_balance FROM daily_summaries
     WHERE workspace_id = $1 AND business_date < $2
     ORDER BY business_date DESC LIMIT 1`,
    [workspaceId, date]
  );
  return rows[0]?.closing_balance ?? null;
};

// POST /api/workspaces  { name }
// Creates the workspace and makes the creator an admin — atomically.
router.post('/', async (req, res, next) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });

    const workspace = await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO workspaces (name, created_by) VALUES ($1, $2) RETURNING *`,
        [name, req.user.id]
      );
      const ws = rows[0];
      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`,
        [ws.id, req.user.id]
      );
      await logAudit(client, {
        workspaceId: ws.id, userId: req.user.id,
        action: 'workspace.create', entityType: 'workspace', entityId: ws.id,
      });
      return ws;
    });

    res.status(201).json({ workspace: { ...workspace, role: 'admin' } });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/workspaces/:workspaceId  { name } — admin only. Renames the
// workspace. The uploads folder keeps the OLD name on purpose: file_path
// values stored on proofs and trash payloads include it, so renaming the
// directory would break every stored path.
router.patch('/:workspaceId', requireRole('admin'), async (req, res, next) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name || name.length > 120) {
      return res.status(400).json({ error: 'name is required (max 120 chars)' });
    }
    if (name === req.workspace.name) {
      return res.json({ workspace: req.workspace });
    }

    const { rows } = await db.query(
      `UPDATE workspaces SET name = $2 WHERE id = $1 RETURNING *`,
      [req.workspace.id, name]
    );
    await logAudit(db, {
      workspaceId: req.workspace.id, userId: req.user.id,
      action: 'workspace.rename', entityType: 'workspace', entityId: req.workspace.id,
      details: { from: req.workspace.name, to: name },
    });

    res.json({ workspace: { ...rows[0], role: 'admin' } });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/workspaces/:workspaceId/data — admin only. Wipes the books:
// transactions, proofs, daily summaries, approvals, trash and audit trail —
// while keeping the workspace itself, its members and email settings. Every
// referenced upload file is removed from disk.
router.delete('/:workspaceId/data', requireRole('admin'), async (req, res, next) => {
  try {
    const filePaths = new Set();
    const { rows: proofRows } = await db.query(
      `SELECT file_path FROM transaction_proofs
       WHERE transaction_id IN (SELECT id FROM transactions WHERE workspace_id = $1)`,
      [req.workspace.id]
    );
    proofRows.forEach((r) => filePaths.add(r.file_path));
    const { rows: txRows } = await db.query(
      `SELECT proof_file_path FROM transactions WHERE workspace_id = $1 AND proof_file_path IS NOT NULL`,
      [req.workspace.id]
    );
    txRows.forEach((r) => filePaths.add(r.proof_file_path));
    const { rows: trashRows } = await db.query(
      `SELECT payload FROM trash WHERE workspace_id = $1`,
      [req.workspace.id]
    );
    trashRows.forEach((r) => payloadProofPaths(r.payload).forEach((p) => filePaths.add(p)));

    const counts = await db.withTransaction(async (client) => {
      // audit_log rows for this wipe survive the delete by logging last —
      // wipe everything else first, then record the wipe itself.
      const { rowCount: transactions } = await client.query(
        `DELETE FROM transactions WHERE workspace_id = $1`, [req.workspace.id]
      );
      const { rowCount: summaries } = await client.query(
        `DELETE FROM daily_summaries WHERE workspace_id = $1`, [req.workspace.id]
      );
      const { rowCount: approvals } = await client.query(
        `DELETE FROM audit_approval_requests WHERE workspace_id = $1`, [req.workspace.id]
      );
      const { rowCount: trash } = await client.query(
        `DELETE FROM trash WHERE workspace_id = $1`, [req.workspace.id]
      );
      await client.query(`DELETE FROM audit_log WHERE workspace_id = $1`, [req.workspace.id]);
      await logAudit(client, {
        workspaceId: req.workspace.id, userId: req.user.id,
        action: 'workspace.wipe', entityType: 'workspace', entityId: req.workspace.id,
        details: { transactions, summaries, approvals, trash },
      });
      return { transactions, summaries };
    });

    // Disk cleanup after the commit — unlink every referenced file, then
    // sweep the workspace's uploads folder for leftovers.
    for (const rel of filePaths) {
      const abs = resolveUpload(rel);
      if (!abs) continue;
      await fs.promises.unlink(abs).catch(() => {});
    }
    const wsDir = path.join(UPLOADS_ROOT, sanitizeSegment(req.workspace.name));
    await wipeWorkspaceDir(wsDir).catch(() => {});

    res.json({ deleted: counts });
  } catch (err) {
    next(err);
  }
});

// GET /api/workspaces — every workspace the caller belongs to, with their role.
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT w.id, w.name, w.created_at, m.role
       FROM workspace_members m
       JOIN workspaces w ON w.id = m.workspace_id
       WHERE m.user_id = $1
       ORDER BY w.name`,
      [req.user.id]
    );
    res.json({ workspaces: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/workspaces/:workspaceId/members — roster with roles (members can view).
router.get('/:workspaceId/members', requireRole(), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.name, u.avatar_url, m.role, m.joined_at
       FROM workspace_members m
       JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = $1
       ORDER BY m.joined_at`,
      [req.workspace.id]
    );
    res.json({ members: rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/workspaces/:workspaceId/members  { email, role } — admin only.
router.post('/:workspaceId/members', requireRole('admin'), async (req, res, next) => {
  try {
    const { email, role = 'member' } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });
    if (!['admin', 'member'].includes(role)) {
      return res.status(400).json({ error: "role must be 'admin' or 'member'" });
    }

    const { rows: users } = await db.query(`SELECT id FROM users WHERE email = $1`, [email]);
    if (!users[0]) {
      return res.status(404).json({ error: 'No user with that email — they must sign in once first' });
    }

    const { rows } = await db.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role
       RETURNING *`,
      [req.workspace.id, users[0].id, role]
    );
    await logAudit(db, {
      workspaceId: req.workspace.id, userId: req.user.id,
      action: 'member.add', entityType: 'user', entityId: users[0].id,
      details: { role },
    });

    // Best-effort invite email — a missing/failing SMTP never fails the invite.
    sendWorkspaceMail(req.workspace.id, {
      to: email,
      subject: `You've been added to "${req.workspace.name}" on Tressurer`,
      text: `${req.user.name ?? req.user.email} added you to the workspace "${req.workspace.name}" as ${role}. Sign in with your Google or Microsoft account to start recording.`,
    }).catch(() => {});

    res.status(201).json({ member: rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /api/workspaces/:workspaceId/summaries/today
// The Opening Balance Rule gate: the app calls this before the first entry.
// If no summary exists yet, needs_opening_balance=true and
// previous_closing_balance tells the app what to pre-fill.
router.get('/:workspaceId/summaries/today', requireRole(), async (req, res, next) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { rows } = await db.query(
      `SELECT * FROM daily_summaries WHERE workspace_id = $1 AND business_date = $2`,
      [req.workspace.id, today]
    );

    if (rows[0]) {
      return res.json({ summary: rows[0], needs_opening_balance: false });
    }
    res.json({
      summary: null,
      needs_opening_balance: true,
      previous_closing_balance: await previousClosingBalance(db, req.workspace.id, today),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/workspaces/:workspaceId/summaries/open  { opening_balance? }
// Records the day's opening balance. Defaults to the previous closing balance;
// idempotent — a second call returns the existing summary.
router.post('/:workspaceId/summaries/open', requireRole(), async (req, res, next) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const explicit = req.body.opening_balance;
    if (explicit != null && (!isFinite(explicit) || explicit < 0)) {
      return res.status(400).json({ error: 'opening_balance must be a non-negative number' });
    }

    const summary = await db.withTransaction(async (client) => {
      const previous = await previousClosingBalance(client, req.workspace.id, today);
      const opening = explicit != null ? Number(explicit) : Number(previous ?? 0);

      const { rows } = await client.query(
        `INSERT INTO daily_summaries (workspace_id, business_date, opening_balance, closing_balance, opened_by)
         VALUES ($1, $2, $3, $3, $4)
         ON CONFLICT (workspace_id, business_date) DO NOTHING
         RETURNING *`,
        [req.workspace.id, today, opening, req.user.id]
      );

      // Lost the race — someone opened the day first. Return that row.
      if (!rows[0]) {
        const existing = await client.query(
          `SELECT * FROM daily_summaries WHERE workspace_id = $1 AND business_date = $2`,
          [req.workspace.id, today]
        );
        return { row: existing.rows[0], created: false };
      }

      await logAudit(client, {
        workspaceId: req.workspace.id, userId: req.user.id,
        action: 'summary.open', entityType: 'daily_summary', entityId: rows[0].id,
        details: { opening_balance: opening, previous_closing_balance: previous },
      });
      return { row: rows[0], created: true };
    });

    res.status(summary.created ? 201 : 200).json({ summary: summary.row });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/workspaces/:workspaceId/summaries/:date  { opening_balance?, closing_balance? }
// Admin-only correction of an opened day's balances. A new opening balance
// recalculates closing from that day's transactions (closing = opening + net);
// a closing value is a manual override, kept until the next recalculation.
router.patch('/:workspaceId/summaries/:date', requireRole('admin'), async (req, res, next) => {
  try {
    const { date } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    }
    const opening = req.body.opening_balance;
    const closing = req.body.closing_balance;
    if (opening == null && closing == null) {
      return res.status(400).json({ error: 'opening_balance or closing_balance required' });
    }
    if ([opening, closing].some((v) => v != null && (!isFinite(v) || Number(v) < 0))) {
      return res.status(400).json({ error: 'balances must be non-negative numbers' });
    }

    const summary = await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM daily_summaries WHERE workspace_id = $1 AND business_date = $2 FOR UPDATE`,
        [req.workspace.id, date]
      );
      const row = rows[0];
      if (!row) return null;

      const old = { opening_balance: row.opening_balance, closing_balance: row.closing_balance };
      if (opening != null) {
        await client.query(
          `UPDATE daily_summaries SET opening_balance = $2 WHERE id = $1`,
          [row.id, Number(opening)]
        );
        await recalcClosingBalance(client, row.id);
      }
      if (closing != null) {
        await client.query(
          `UPDATE daily_summaries SET closing_balance = $2 WHERE id = $1`,
          [row.id, Number(closing)]
        );
      }

      const { rows: updated } = await client.query(
        `SELECT * FROM daily_summaries WHERE id = $1`, [row.id]
      );
      await logAudit(client, {
        workspaceId: req.workspace.id, userId: req.user.id,
        action: 'summary.update', entityType: 'daily_summary', entityId: row.id,
        details: {
          business_date: date, old,
          new: { opening_balance: updated[0].opening_balance, closing_balance: updated[0].closing_balance },
        },
      });
      return updated[0];
    });

    if (!summary) return res.status(404).json({ error: 'No summary for that date' });
    res.json({ summary });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/workspaces/:workspaceId/members/:userId — admin only.
// Guard: the last remaining admin cannot be removed.
router.delete('/:workspaceId/members/:userId', requireRole('admin'), async (req, res, next) => {
  try {
    const target = req.params.userId;

    const { rows: targetRows } = await db.query(
      `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [req.workspace.id, target]
    );
    if (!targetRows[0]) return res.status(404).json({ error: 'Member not found' });

    if (targetRows[0].role === 'admin') {
      const { rows: admins } = await db.query(
        `SELECT COUNT(*)::int AS n FROM workspace_members
         WHERE workspace_id = $1 AND role = 'admin'`,
        [req.workspace.id]
      );
      if (admins[0].n <= 1) {
        return res.status(409).json({ error: 'Cannot remove the last admin' });
      }
    }

    await db.query(
      `DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [req.workspace.id, target]
    );
    await logAudit(db, {
      workspaceId: req.workspace.id, userId: req.user.id,
      action: 'member.remove', entityType: 'user', entityId: target,
    });
    res.sendStatus(204);
  } catch (err) {
    next(err);
  }
});

// GET /api/workspaces/:workspaceId/audit-log — admin only. Newest first,
// joined to the actor's name/email. ?from=&to= (YYYY-MM-DD) filter by
// created_at; ?limit caps rows (default 200, max 500).
router.get('/:workspaceId/audit-log', requireRole('admin'), async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : null;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : null;
    const { rows } = await db.query(
      `SELECT a.id, a.action, a.entity_type, a.entity_id, a.details, a.created_at,
              u.name AS user_name, u.email AS user_email
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE a.workspace_id = $1
         AND ($2::date IS NULL OR a.created_at >= $2::date)
         AND ($3::date IS NULL OR a.created_at < $3::date + 1)
       ORDER BY a.created_at DESC
       LIMIT $4`,
      [req.workspace.id, from, to, limit]
    );
    res.json({ entries: rows });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/workspaces/:workspaceId — admin only. FULL wipe: cascades
// members, summaries, transactions, proofs, approvals, trash and email config;
// explicitly purges audit_log rows (FK is ON DELETE SET NULL by design) and
// deletes every uploaded file on disk (live proofs + trash payloads).
router.delete('/:workspaceId', requireRole('admin'), async (req, res, next) => {
  try {
    // Gather every stored file path before the rows disappear — proofs plus
    // any files referenced by trash payloads.
    const filePaths = new Set();
    const { rows: proofRows } = await db.query(
      `SELECT file_path FROM transaction_proofs
       WHERE transaction_id IN (SELECT id FROM transactions WHERE workspace_id = $1)`,
      [req.workspace.id]
    );
    proofRows.forEach((r) => filePaths.add(r.file_path));
    const { rows: txRows } = await db.query(
      `SELECT proof_file_path FROM transactions WHERE workspace_id = $1 AND proof_file_path IS NOT NULL`,
      [req.workspace.id]
    );
    txRows.forEach((r) => filePaths.add(r.proof_file_path));
    const { rows: trashRows } = await db.query(
      `SELECT payload FROM trash WHERE workspace_id = $1`,
      [req.workspace.id]
    );
    trashRows.forEach((r) => payloadProofPaths(r.payload).forEach((p) => filePaths.add(p)));

    await db.withTransaction(async (client) => {
      // audit_log keeps rows on workspace delete (SET NULL) — wipe them first.
      await client.query(`DELETE FROM audit_log WHERE workspace_id = $1`, [req.workspace.id]);
      await client.query(`DELETE FROM workspaces WHERE id = $1`, [req.workspace.id]);
      await logAudit(client, {
        workspaceId: null, userId: req.user.id,
        action: 'workspace.delete', entityType: 'workspace', entityId: req.workspace.id,
        details: { name: req.workspace.name },
      });
    });

    // Disk cleanup after the commit — unlink every collected file, then sweep
    // the workspace's uploads folder for leftovers and remove it entirely.
    for (const rel of filePaths) {
      const abs = resolveUpload(rel);
      if (!abs) continue;
      await fs.promises.unlink(abs).catch(() => {});
    }
    const wsDir = path.join(UPLOADS_ROOT, sanitizeSegment(req.workspace.name));
    await wipeWorkspaceDir(wsDir).catch(() => {});

    res.sendStatus(204);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
