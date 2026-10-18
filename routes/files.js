const express = require('express');
const fs = require('fs');
const db = require('../config/db');
const authRequired = require('../middleware/auth');
const { requireRole } = require('../middleware/workspace');
const { resolveUpload } = require('../utils/files');

const router = express.Router({ mergeParams: true });
router.use(authRequired);

// GET /api/workspaces/:workspaceId/files/:transactionId/proof
// Secure download: requires workspace membership, the path comes from the DB
// (never from the request), and resolveUpload refuses traversal outside uploads/.
router.get('/:workspaceId/files/:transactionId/proof', requireRole(), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT proof_file_path FROM transactions WHERE id = $1 AND workspace_id = $2`,
      [req.params.transactionId, req.workspace.id]
    );

    const rel = rows[0]?.proof_file_path;
    if (!rel) return res.status(404).json({ error: 'No proof file for this transaction' });

    const abs = resolveUpload(rel);
    if (!abs || !fs.existsSync(abs)) {
      return res.status(404).json({ error: 'File not found' });
    }
    res.sendFile(abs);
  } catch (err) {
    next(err);
  }
});

// GET /api/workspaces/:workspaceId/files/:transactionId/proofs
// Lists all proof attachments for a transaction.
router.get('/:workspaceId/files/:transactionId/proofs', requireRole(), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT p.id, p.file_path, p.mime, p.original_name
       FROM transaction_proofs p
       JOIN transactions t ON t.id = p.transaction_id
       WHERE p.transaction_id = $1 AND t.workspace_id = $2
       ORDER BY p.created_at`,
      [req.params.transactionId, req.workspace.id]
    );
    res.json({ proofs: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/workspaces/:workspaceId/files/:transactionId/proofs/:proofId
// Secure download of a single proof attachment.
router.get('/:workspaceId/files/:transactionId/proofs/:proofId', requireRole(), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT p.file_path, p.mime, p.original_name
       FROM transaction_proofs p
       JOIN transactions t ON t.id = p.transaction_id
       WHERE p.id = $1 AND p.transaction_id = $2 AND t.workspace_id = $3`,
      [req.params.proofId, req.params.transactionId, req.workspace.id]
    );
    const proof = rows[0];
    if (!proof) return res.status(404).json({ error: 'Proof not found' });

    const abs = resolveUpload(proof.file_path);
    if (!abs || !fs.existsSync(abs)) {
      return res.status(404).json({ error: 'File not found' });
    }
    if (proof.mime) res.setHeader('Content-Type', proof.mime);
    res.sendFile(abs);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
