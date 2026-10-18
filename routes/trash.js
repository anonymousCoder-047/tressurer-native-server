const express = require('express');
const fs = require('fs');
const db = require('../config/db');
const authRequired = require('../middleware/auth');
const { requireRole } = require('../middleware/workspace');
const { logAudit, recalcClosingBalance } = require('../utils/audit');
const { purgeExpired, payloadProofPaths } = require('../utils/trash');
const { resolveUpload, unlinkIfOrphaned } = require('../utils/files');

const router = express.Router({ mergeParams: true });
router.use(authRequired);

// GET /api/workspaces/:workspaceId/trash — admin only.
// Purges expired rows first so expired items never show up in the bin.
router.get('/:workspaceId/trash', requireRole('admin'), async (req, res, next) => {
  try {
    await purgeExpired();
    const { rows } = await db.query(
      `SELECT t.id, t.entity_type, t.entity_id, t.deleted_at, t.expires_at,
              t.payload, u.name AS deleted_by_name
       FROM trash t JOIN users u ON u.id = t.deleted_by
       WHERE t.workspace_id = $1
       ORDER BY t.deleted_at DESC`,
      [req.workspace.id]
    );
    res.json({ trash: rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/workspaces/:workspaceId/trash/:trashId/restore — admin only.
// Re-inserts the transaction with its original id/summary/author/date so
// nothing displays as "unknown" or with an Invalid Date after restore.
router.post('/:workspaceId/trash/:trashId/restore', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        `DELETE FROM trash WHERE id = $1 AND workspace_id = $2
         RETURNING entity_type, entity_id, payload`,
        [req.params.trashId, req.workspace.id]
      );
      const item = rows[0];
      if (!item) return { status: 404 };
      if (item.entity_type !== 'transaction') return { status: 400 };

      const p = item.payload;
      // The day summary must still exist for the entry to land back on its date.
      const { rows: sum } = await client.query(
        `SELECT id FROM daily_summaries WHERE id = $1 AND workspace_id = $2`,
        [p.summary_id, req.workspace.id]
      );
      if (!sum[0]) return { status: 409 };

      await client.query(
        `INSERT INTO transactions
           (id, workspace_id, summary_id, created_by, type, amount, category, description, proof_file_path, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          p.id, req.workspace.id, p.summary_id, p.created_by, p.type,
          Number(p.amount), p.category ?? null, p.description ?? null,
          p.proof_file_path ?? null, p.created_at, p.updated_at ?? p.created_at,
        ]
      );
      // Restore proof rows — the files were never touched by the trash flow.
      for (const proof of p.proofs ?? []) {
        await client.query(
          `INSERT INTO transaction_proofs (id, transaction_id, file_path, mime, original_name, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (id) DO NOTHING`,
          [proof.id, p.id, proof.file_path, proof.mime, proof.original_name, proof.created_at]
        );
      }
      // Legacy snapshot (pre multi-proof): only the single-path mirror survives
      // — synthesise a proof row so the entry isn't left with an orphan file.
      if (!p.proofs?.length && p.proof_file_path) {
        await client.query(
          `INSERT INTO transaction_proofs (transaction_id, file_path)
           SELECT $1, $2 WHERE NOT EXISTS
             (SELECT 1 FROM transaction_proofs WHERE transaction_id = $1 AND file_path = $2)`,
          [p.id, p.proof_file_path]
        );
      }
      await recalcClosingBalance(client, p.summary_id);
      await logAudit(client, {
        workspaceId: req.workspace.id, userId: req.user.id,
        action: 'trash.restore', entityType: 'transaction', entityId: p.id,
        details: { amount: p.amount, type: p.type },
      });
      return { status: 200 };
    });

    if (result.status === 404) return res.status(404).json({ error: 'Trash item not found' });
    if (result.status === 409) {
      return res.status(409).json({ error: 'The day this entry belonged to no longer exists' });
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/workspaces/:workspaceId/trash/:trashId — permanent delete.
// Also removes the uploaded proof file from disk.
router.delete('/:workspaceId/trash/:trashId', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        `DELETE FROM trash WHERE id = $1 AND workspace_id = $2 RETURNING entity_type, entity_id, payload`,
        [req.params.trashId, req.workspace.id]
      );
      const item = rows[0];
      if (!item) return { status: 404 };
      await logAudit(client, {
        workspaceId: req.workspace.id, userId: req.user.id,
        action: 'trash.purge', entityType: item.entity_type ?? 'transaction', entityId: item.entity_id,
        details: { permanently: true },
      });
      return { status: 200, payload: item.payload };
    });

    if (result.status === 404) return res.status(404).json({ error: 'Trash item not found' });

    for (const rel of payloadProofPaths(result.payload)) {
      // A combined entry's sibling may still reference the shared file.
      await unlinkIfOrphaned(db, rel);
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
