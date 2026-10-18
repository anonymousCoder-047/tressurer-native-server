const express = require('express');
const db = require('../config/db');
const authRequired = require('../middleware/auth');
const { requireRole } = require('../middleware/workspace');
const { logAudit, recalcClosingBalance } = require('../utils/audit');
const { moveToTrash } = require('../utils/trash');

const router = express.Router({ mergeParams: true });
router.use(authRequired);
// NB: requireRole must run per-route, not at router.use level — it reads
// req.params.workspaceId, which only exists after a route has matched.
// A router-level gate 404s every request that flows through this router
// (including /reports and /files mounted after it).

// Columns a pending 'update' request is allowed to touch — the UPDATE below
// whitelists exactly these, never interpolating new_values keys into SQL.
// GET /api/workspaces/:workspaceId/approvals?status=pending
router.get('/:workspaceId/approvals', requireRole('admin'), async (req, res, next) => {
  try {
    const status = req.query.status ?? 'pending';
    if (!['pending', 'approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const { rows } = await db.query(
      `SELECT a.*, u.name AS requested_by_name, u.email AS requested_by_email,
              r.name AS reviewed_by_name
       FROM audit_approval_requests a
       JOIN users u ON u.id = a.requested_by
       LEFT JOIN users r ON r.id = a.reviewed_by
       WHERE a.workspace_id = $1 AND a.status = $2
       ORDER BY a.created_at`,
      [req.workspace.id, status]
    );
    res.json({ approvals: rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/workspaces/:workspaceId/approvals/:approvalId/approve
// Applies the pending change atomically with the status flip.
router.post('/:workspaceId/approvals/:approvalId/approve', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM audit_approval_requests
         WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
        [req.params.approvalId, req.workspace.id]
      );
      const approval = rows[0];
      if (!approval) return { status: 404 };
      if (approval.status !== 'pending') return { status: 409, approval };

      if (approval.entity_type === 'transaction') {
        const txRes = await client.query(
          `SELECT * FROM transactions WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
          [approval.entity_id, req.workspace.id]
        );
        const tx = txRes.rows[0];
        if (!tx) return { status: 410 }; // entity already gone (e.g. admin deleted it)

        if (approval.action === 'update') {
          const v = approval.new_values ?? {};
          await client.query(
            `UPDATE transactions
             SET type = COALESCE($3, type),
                 amount = COALESCE($4, amount),
                 category = COALESCE($5, category),
                 description = COALESCE($6, description),
                 updated_at = now()
             WHERE id = $1 AND workspace_id = $2`,
            [
              tx.id, req.workspace.id,
              v.type ?? null,
              v.amount != null ? Number(v.amount) : null,
              v.category ?? null,
              v.description ?? null,
            ]
          );
        } else if (approval.action === 'delete') {
          await moveToTrash(client, {
            workspaceId: req.workspace.id, tx, deletedBy: req.user.id,
          });
          await client.query(`DELETE FROM transactions WHERE id = $1`, [tx.id]);
        }
        await recalcClosingBalance(client, tx.summary_id);
      }

      await client.query(
        `UPDATE audit_approval_requests
         SET status = 'approved', reviewed_by = $3, reviewed_at = now()
         WHERE id = $1 AND workspace_id = $2`,
        [approval.id, req.workspace.id, req.user.id]
      );
      await logAudit(client, {
        workspaceId: req.workspace.id, userId: req.user.id,
        action: 'approval.approve', entityType: approval.entity_type, entityId: approval.entity_id,
        details: { approval_request_id: approval.id, applied: approval.action, requested_by: approval.requested_by },
      });
      return { status: 200 };
    });

    if (result.status === 404) return res.status(404).json({ error: 'Approval request not found' });
    if (result.status === 409) return res.status(409).json({ error: 'Request already reviewed', approval: result.approval });
    if (result.status === 410) {
      return res.status(410).json({ error: 'Entity no longer exists — reject this request instead' });
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/workspaces/:workspaceId/approvals/:approvalId/reject  { reason? }
router.post('/:workspaceId/approvals/:approvalId/reject', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM audit_approval_requests
         WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
        [req.params.approvalId, req.workspace.id]
      );
      const approval = rows[0];
      if (!approval) return { status: 404 };
      if (approval.status !== 'pending') return { status: 409, approval };

      await client.query(
        `UPDATE audit_approval_requests
         SET status = 'rejected', reviewed_by = $3, reviewed_at = now()
         WHERE id = $1 AND workspace_id = $2`,
        [approval.id, req.workspace.id, req.user.id]
      );
      await logAudit(client, {
        workspaceId: req.workspace.id, userId: req.user.id,
        action: 'approval.reject', entityType: approval.entity_type, entityId: approval.entity_id,
        details: { approval_request_id: approval.id, reason: req.body?.reason ?? null, requested_by: approval.requested_by },
      });
      return { status: 200 };
    });

    if (result.status === 404) return res.status(404).json({ error: 'Approval request not found' });
    if (result.status === 409) return res.status(409).json({ error: 'Request already reviewed', approval: result.approval });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
