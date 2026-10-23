const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../config/db');
const authRequired = require('../middleware/auth');
const { requireRole } = require('../middleware/workspace');
const upload = require('../middleware/upload');
const { logAudit, recalcClosingBalance } = require('../utils/audit');
const { moveToTrash } = require('../utils/trash');
const { UPLOADS_ROOT, resolveUpload, storeUpload, unlinkIfOrphaned } = require('../utils/files');

const router = express.Router({ mergeParams: true });
router.use(authRequired);

const TX_FIELDS = ['type', 'amount', 'category', 'description', 'received_from', 'paid_to'];

const MAX_TOTAL_PROOF_BYTES = 25 * 1024 * 1024; // 25 MB across all proofs

// Stores every uploaded proof under uploads/… and returns their rows.
// Enforces the 25 MB aggregate cap (per-file cap is multer's fileSize limit).
// Any file already stored is removed if a later one fails.
const storeProofs = async ({ workspaceName, userName, date, files }) => {
  const total = (files ?? []).reduce((n, f) => n + f.size, 0);
  if (total > MAX_TOTAL_PROOF_BYTES) {
    const err = new Error('Total proof size exceeds 25 MB');
    err.status = 413;
    throw err;
  }
  const stored = [];
  try {
    for (const file of files ?? []) {
      const file_path = await storeUpload({ workspaceName, userName, date, file });
      stored.push({ file_path, mime: file.mimetype, original_name: file.originalname });
    }
  } catch (err) {
    for (const p of stored) {
      const abs = resolveUpload(p.file_path);
      if (abs) await fs.promises.unlink(abs).catch(() => {});
    }
    throw err;
  }
  return stored;
};

// pg returns DATE as a local-midnight Date — derive YMD via local parts
// (toISOString would shift a day for UTC+ timezones).
const businessYMD = (businessDate) => {
  const d = new Date(businessDate);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const insertProofRows = (client, transactionId, proofs) =>
  Promise.all(
    proofs.map((p) =>
      client.query(
        `INSERT INTO transaction_proofs (transaction_id, file_path, mime, original_name)
         VALUES ($1, $2, $3, $4)`,
        [transactionId, p.file_path, p.mime, p.original_name]
      )
    )
  );

const validateTransaction = ({ type, amount }) =>
  ['income', 'expense'].includes(type) && isFinite(amount) && Number(amount) > 0;

const getTransaction = (executor, workspaceId, transactionId, lock = '') =>
  executor
    .query(`SELECT * FROM transactions WHERE id = $1 AND workspace_id = $2 ${lock}`, [
      transactionId,
      workspaceId,
    ])
    .then((r) => r.rows[0]);

const summaryFor = (executor, workspaceId, date) =>
  executor
    .query(
      `SELECT * FROM daily_summaries WHERE workspace_id = $1 AND business_date = $2`,
      [workspaceId, date]
    )
    .then((r) => r.rows[0]);

const openingBalanceRequired = async (res, workspaceId, date) => {
  const { rows } = await db.query(
    `SELECT closing_balance FROM daily_summaries
     WHERE workspace_id = $1 AND business_date < $2
     ORDER BY business_date DESC LIMIT 1`,
    [workspaceId, date]
  );
  res.status(409).json({
    error: 'OPENING_BALANCE_REQUIRED',
    business_date: date,
    previous_closing_balance: rows[0]?.closing_balance ?? null,
  });
};

// GET /api/workspaces/:workspaceId/transactions?date=YYYY-MM-DD
//   or ?from=YYYY-MM-DD&to=YYYY-MM-DD for a range (newest first).
// Single-date mode also returns the day's summary.
router.get('/:workspaceId/transactions', requireRole(), async (req, res, next) => {
  try {
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const { from, to } = req.query;

    if (DATE_RE.test(from || '') && DATE_RE.test(to || '')) {
      const { rows } = await db.query(
        `SELECT t.*, u.name AS created_by_name, s.business_date
         FROM transactions t
         JOIN daily_summaries s ON s.id = t.summary_id
         JOIN users u ON u.id = t.created_by
         WHERE t.workspace_id = $1 AND s.business_date BETWEEN $2 AND $3
         ORDER BY s.business_date DESC, t.created_at DESC`,
        [req.workspace.id, from, to]
      );
      return res.json({ transactions: rows });
    }

    const date = DATE_RE.test(req.query.date || '')
      ? req.query.date
      : new Date().toISOString().slice(0, 10);

    const [summaryRes, txRes] = await Promise.all([
      db.query(
        `SELECT * FROM daily_summaries WHERE workspace_id = $1 AND business_date = $2`,
        [req.workspace.id, date]
      ),
      db.query(
        `SELECT t.*, u.name AS created_by_name
         FROM transactions t
         JOIN daily_summaries s ON s.id = t.summary_id
         JOIN users u ON u.id = t.created_by
         WHERE t.workspace_id = $1 AND s.business_date = $2
         ORDER BY t.created_at`,
        [req.workspace.id, date]
      ),
    ]);

    res.json({ summary: summaryRes.rows[0] ?? null, transactions: txRes.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/workspaces/:workspaceId/transactions/descriptions?q=
// Distinct past descriptions for autocomplete in the Log Record form.
router.get('/:workspaceId/transactions/descriptions', requireRole(), async (req, res, next) => {
  try {
    const q = `%${(req.query.q || '').trim()}%`;
    const { rows } = await db.query(
      `SELECT DISTINCT description FROM transactions
       WHERE workspace_id = $1 AND description IS NOT NULL AND description ILIKE $2
       ORDER BY description LIMIT 10`,
      [req.workspace.id, q]
    );
    res.json({ descriptions: rows.map((r) => r.description) });
  } catch (err) {
    next(err);
  }
});

// POST /api/workspaces/:workspaceId/transactions  (multipart: 'proof' fields ×N)
// Requires the day to be opened — otherwise 409 OPENING_BALANCE_REQUIRED so the
// app can collect the opening balance first. Proofs: ≤5 MB each, ≤25 MB total.
// Two shapes: { type, amount } for a single entry, or { received, paid } (both
// > 0) for a combined submission — the latter creates an income + an expense
// row atomically, sharing category/description and the proof files.
router.post(
  '/:workspaceId/transactions',
  requireRole(),
  upload.array('proof', 20),
  async (req, res, next) => {
    let proofs = [];
    try {
      const receivedNum = Number(req.body.received);
      const paidNum = Number(req.body.paid);
      const combined = isFinite(receivedNum) && isFinite(paidNum) && receivedNum > 0 && paidNum > 0;
      if (!combined && !validateTransaction(req.body)) {
        return res.status(400).json({ error: 'type must be income|expense and amount > 0' });
      }
      const entries = combined
        ? [{ type: 'income', amount: receivedNum }, { type: 'expense', amount: paidNum }]
        : [{ type: req.body.type, amount: Number(req.body.amount) }];

      // Entries may target an already-opened past day; today is the default.
      const businessDate = /^\d{4}-\d{2}-\d{2}$/.test(req.body.date || '')
        ? req.body.date
        : new Date().toISOString().slice(0, 10);

      proofs = await storeProofs({
        workspaceName: req.workspace.name,
        userName: req.user.name || req.user.email,
        date: businessDate,
        files: req.files,
      });

      const transactions = await db.withTransaction(async (client) => {
        const summary = await summaryFor(client, req.workspace.id, businessDate);
        if (!summary) return null; // handled below

        const created = [];
        for (const [i, e] of entries.entries()) {
          const { rows } = await client.query(
            `INSERT INTO transactions
               (workspace_id, summary_id, created_by, type, amount, category, description,
                received_from, paid_to, proof_file_path)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING *`,
            [
              req.workspace.id, summary.id, req.user.id,
              e.type, e.amount,
              req.body.category ?? null, req.body.description ?? null,
              e.type === 'income' ? (req.body.received_from ?? null) : null,
              e.type === 'expense' ? (req.body.paid_to ?? null) : null,
              i === 0 ? proofs[0]?.file_path ?? null : null, // legacy mirror on the first
            ]
          );
          // Combined entries share the same proof files — each gets its own
          // proof rows pointing at the stored paths.
          await insertProofRows(client, rows[0].id, proofs);
          await logAudit(client, {
            workspaceId: req.workspace.id, userId: req.user.id,
            action: 'transaction.create', entityType: 'transaction', entityId: rows[0].id,
            details: { type: e.type, amount: e.amount, proof_count: proofs.length, combined },
          });
          created.push(rows[0]);
        }
        await recalcClosingBalance(client, summary.id);
        return created;
      });

      if (!transactions) {
        // Day not opened — remove the uploaded files so they aren't orphaned.
        for (const p of proofs) {
          const abs = resolveUpload(p.file_path);
          if (abs) await fs.promises.unlink(abs).catch(() => {});
        }
        return openingBalanceRequired(res, req.workspace.id, businessDate);
      }
      res.status(201).json({ transaction: transactions[0], transactions });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/workspaces/:workspaceId/transactions/:transactionId
// Admins apply edits directly; member edits become pending approval requests.
router.patch('/:workspaceId/transactions/:transactionId', requireRole(), async (req, res, next) => {
  try {
    const changes = {};
    for (const field of TX_FIELDS) {
      if (req.body[field] !== undefined) changes[field] = req.body[field];
    }
    if (changes.type !== undefined && !['income', 'expense'].includes(changes.type)) {
      return res.status(400).json({ error: 'type must be income|expense' });
    }
    if (changes.amount !== undefined && (!isFinite(changes.amount) || Number(changes.amount) <= 0)) {
      return res.status(400).json({ error: 'amount must be > 0' });
    }
    if (Object.keys(changes).length === 0) {
      return res.status(400).json({ error: `No editable fields — allowed: ${TX_FIELDS.join(', ')}` });
    }

    const result = await db.withTransaction(async (client) => {
      const tx = await getTransaction(client, req.workspace.id, req.params.transactionId, 'FOR UPDATE');
      if (!tx) return { status: 404 };

      if (req.membership.role === 'admin') {
        const { rows } = await client.query(
          `UPDATE transactions
           SET type = COALESCE($3, type),
               amount = COALESCE($4, amount),
               category = COALESCE($5, category),
               description = COALESCE($6, description),
               received_from = COALESCE($7, received_from),
               paid_to = COALESCE($8, paid_to),
               updated_at = now()
           WHERE id = $1 AND workspace_id = $2
           RETURNING *`,
          [
            tx.id, req.workspace.id,
            changes.type ?? null,
            changes.amount != null ? Number(changes.amount) : null,
            changes.category ?? null,
            changes.description ?? null,
            changes.received_from ?? null,
            changes.paid_to ?? null,
          ]
        );
        await recalcClosingBalance(client, tx.summary_id);
        await logAudit(client, {
          workspaceId: req.workspace.id, userId: req.user.id,
          action: 'transaction.update', entityType: 'transaction', entityId: tx.id,
          details: { old: tx, changes },
        });
        return { status: 200, transaction: rows[0] };
      }

      const { rows } = await client.query(
        `INSERT INTO audit_approval_requests
           (workspace_id, requested_by, action, entity_type, entity_id, old_values, new_values)
         VALUES ($1, $2, 'update', 'transaction', $3, $4, $5)
         RETURNING *`,
        [req.workspace.id, req.user.id, tx.id, JSON.stringify(tx), JSON.stringify(changes)]
      );
      await logAudit(client, {
        workspaceId: req.workspace.id, userId: req.user.id,
        action: 'transaction.update_requested', entityType: 'transaction', entityId: tx.id,
        details: { approval_request_id: rows[0].id, changes },
      });
      return { status: 202, approval_request: rows[0] };
    });

    if (result.status === 404) return res.status(404).json({ error: 'Transaction not found' });
    res.status(result.status).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/workspaces/:workspaceId/transactions/:transactionId/proofs
// Admin only — appends proof files (multipart 'proof' fields ×N).
router.post(
  '/:workspaceId/transactions/:transactionId/proofs',
  requireRole('admin'),
  upload.array('proof', 20),
  async (req, res, next) => {
    try {
      if (!req.files?.length) return res.status(400).json({ error: 'proof file(s) required' });

      const { rows } = await db.query(
        `SELECT t.*, s.business_date FROM transactions t
         JOIN daily_summaries s ON s.id = t.summary_id
         WHERE t.id = $1 AND t.workspace_id = $2`,
        [req.params.transactionId, req.workspace.id]
      );
      const tx = rows[0];
      if (!tx) return res.status(404).json({ error: 'Transaction not found' });

      const proofs = await storeProofs({
        workspaceName: req.workspace.name,
        userName: req.user.name || req.user.email,
        date: businessYMD(tx.business_date),
        files: req.files,
      });

      await db.withTransaction(async (client) => {
        await insertProofRows(client, tx.id, proofs);
        // Keep the legacy first-proof mirror populated.
        if (!tx.proof_file_path && proofs[0]) {
          await client.query(
            `UPDATE transactions SET proof_file_path = $2, updated_at = now() WHERE id = $1`,
            [tx.id, proofs[0].file_path]
          );
        } else {
          await client.query(`UPDATE transactions SET updated_at = now() WHERE id = $1`, [tx.id]);
        }
      });

      await logAudit(db, {
        workspaceId: req.workspace.id, userId: req.user.id,
        action: 'transaction.proof_add', entityType: 'transaction', entityId: tx.id,
        details: { added: proofs.length },
      });
      res.status(201).json({ added: proofs.length });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/workspaces/:workspaceId/transactions/:transactionId/proofs/:proofId
// Admin only — removes one proof attachment (and its file on disk).
router.delete(
  '/:workspaceId/transactions/:transactionId/proofs/:proofId',
  requireRole('admin'),
  async (req, res, next) => {
    try {
      const result = await db.withTransaction(async (client) => {
        const { rows } = await client.query(
          `DELETE FROM transaction_proofs
           WHERE id = $1 AND transaction_id IN
             (SELECT id FROM transactions WHERE id = $2 AND workspace_id = $3)
           RETURNING file_path`,
          [req.params.proofId, req.params.transactionId, req.workspace.id]
        );
        const proof = rows[0];
        if (!proof) return { status: 404 };

        // Fix the legacy first-proof mirror if it pointed at the removed file.
        await client.query(
          `UPDATE transactions
           SET proof_file_path = (SELECT file_path FROM transaction_proofs
                                   WHERE transaction_id = $1 ORDER BY created_at LIMIT 1),
               updated_at = now()
           WHERE id = $1 AND proof_file_path = $2`,
          [req.params.transactionId, proof.file_path]
        );
        await logAudit(client, {
          workspaceId: req.workspace.id, userId: req.user.id,
          action: 'transaction.proof_remove', entityType: 'transaction',
          entityId: req.params.transactionId,
          details: { proof_id: req.params.proofId, file_path: proof.file_path },
        });
        return { status: 200, path: proof.file_path };
      });

      if (result.status === 404) return res.status(404).json({ error: 'Proof not found' });
      await unlinkIfOrphaned(db, result.path);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/workspaces/:workspaceId/transactions/:transactionId
// Admins delete directly; member deletes become pending approval requests.
router.delete('/:workspaceId/transactions/:transactionId', requireRole(), async (req, res, next) => {
  try {
    const result = await db.withTransaction(async (client) => {
      const tx = await getTransaction(client, req.workspace.id, req.params.transactionId, 'FOR UPDATE');
      if (!tx) return { status: 404 };

      if (req.membership.role === 'admin') {
        // Soft delete: the row moves to trash (30-day restore window), it is
        // not destroyed. Permanent deletion lives in the trash endpoints.
        await moveToTrash(client, { workspaceId: req.workspace.id, tx, deletedBy: req.user.id });
        await client.query(`DELETE FROM transactions WHERE id = $1`, [tx.id]);
        await recalcClosingBalance(client, tx.summary_id);
        await logAudit(client, {
          workspaceId: req.workspace.id, userId: req.user.id,
          action: 'transaction.delete', entityType: 'transaction', entityId: tx.id,
          details: { old: tx, trashed: true },
        });
        return { status: 204 };
      }

      const { rows } = await client.query(
        `INSERT INTO audit_approval_requests
           (workspace_id, requested_by, action, entity_type, entity_id, old_values)
         VALUES ($1, $2, 'delete', 'transaction', $3, $4)
         RETURNING *`,
        [req.workspace.id, req.user.id, tx.id, JSON.stringify(tx)]
      );
      await logAudit(client, {
        workspaceId: req.workspace.id, userId: req.user.id,
        action: 'transaction.delete_requested', entityType: 'transaction', entityId: tx.id,
        details: { approval_request_id: rows[0].id },
      });
      return { status: 202, approval_request: rows[0] };
    });

    if (result.status === 404) return res.status(404).json({ error: 'Transaction not found' });
    if (result.status === 204) return res.sendStatus(204);
    res.status(202).json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
