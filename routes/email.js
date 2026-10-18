const express = require('express');
const db = require('../config/db');
const authRequired = require('../middleware/auth');
const { requireRole } = require('../middleware/workspace');
const { sendWorkspaceMail } = require('../utils/mailer');
const { logAudit } = require('../utils/audit');

const router = express.Router({ mergeParams: true });
router.use(authRequired);

// GET /api/workspaces/:workspaceId/email — admin only.
// Never returns the stored password — a `password_set` flag instead.
router.get('/:workspaceId/email', requireRole('admin'), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT host, port, username, from_address, secure, updated_at,
              (password IS NOT NULL AND password <> '') AS password_set
       FROM email_settings WHERE workspace_id = $1`,
      [req.workspace.id]
    );
    res.json({ settings: rows[0] ?? null });
  } catch (err) {
    next(err);
  }
});

// PUT /api/workspaces/:workspaceId/email — admin only.
// { host, port, username, password?, from_address, secure }
// An empty/missing password keeps the stored one.
router.put('/:workspaceId/email', requireRole('admin'), async (req, res, next) => {
  try {
    const { host, port = 587, username, password, from_address, secure = false } = req.body ?? {};
    if (!host || !from_address) {
      return res.status(400).json({ error: 'host and from_address are required' });
    }
    const { rows } = await db.query(
      `INSERT INTO email_settings (workspace_id, host, port, username, password, from_address, secure, updated_at)
       VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6, $7, now())
       ON CONFLICT (workspace_id) DO UPDATE SET
         host = EXCLUDED.host, port = EXCLUDED.port,
         username = EXCLUDED.username,
         password = COALESCE(EXCLUDED.password, email_settings.password),
         from_address = EXCLUDED.from_address,
         secure = EXCLUDED.secure, updated_at = now()
       RETURNING host, port, username, from_address, secure`,
      [req.workspace.id, host, Number(port) || 587, username ?? null, password ?? '', from_address, Boolean(secure)]
    );
    await logAudit(db, {
      workspaceId: req.workspace.id, userId: req.user.id,
      action: 'email.configure', entityType: 'email_settings', entityId: null,
      details: { host, port: Number(port) || 587 },
    });
    res.json({ settings: rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /api/workspaces/:workspaceId/email/test — admin only.
// Sends a test message to the requesting admin's own email.
router.post('/:workspaceId/email/test', requireRole('admin'), async (req, res, next) => {
  try {
    const sent = await sendWorkspaceMail(req.workspace.id, {
      to: req.user.email,
      subject: 'Tressurer — SMTP test',
      text: `SMTP is configured for workspace "${req.workspace.name}". Invites and report sharing will work.`,
    });
    if (!sent) {
      return res.status(400).json({ error: 'Email is not configured for this workspace' });
    }
    res.json({ ok: true });
  } catch (err) {
    // SMTP failures (auth, unreachable host) surface as a 502-ish client error.
    res.status(502).json({ error: `Send failed: ${err.message}` });
  }
});

module.exports = router;
