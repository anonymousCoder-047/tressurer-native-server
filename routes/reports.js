const express = require('express');
const db = require('../config/db');
const authRequired = require('../middleware/auth');
const { requireRole } = require('../middleware/workspace');
const { sendWorkspaceMail } = require('../utils/mailer');
const { logAudit } = require('../utils/audit');

const router = express.Router({ mergeParams: true });
router.use(authRequired);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// GET /api/workspaces/:workspaceId/reports?from=YYYY-MM-DD&to=YYYY-MM-DD
// Per-day financial breakdown + range totals. Defaults to the current month.
// credit = money received (income), debit = money paid out (expense).
router.get('/:workspaceId/reports', requireRole(), async (req, res, next) => {
  try {
    const now = new Date();
    const from = DATE_RE.test(req.query.from || '')
      ? req.query.from
      : new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const to = DATE_RE.test(req.query.to || '')
      ? req.query.to
      : now.toISOString().slice(0, 10);

    const { rows } = await db.query(
      `SELECT s.business_date, s.opening_balance, s.closing_balance,
              COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'income'), 0)  AS credit,
              COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'expense'), 0) AS debit
       FROM daily_summaries s
       LEFT JOIN transactions t ON t.summary_id = s.id
       WHERE s.workspace_id = $1 AND s.business_date BETWEEN $2 AND $3
       GROUP BY s.id
       ORDER BY s.business_date`,
      [req.workspace.id, from, to]
    );

    const { rows: txRows } = await db.query(
      `SELECT t.id, s.business_date, t.type, t.amount, t.category, t.description,
              t.received_from, t.paid_to, u.name AS created_by_name
       FROM transactions t
       JOIN daily_summaries s ON s.id = t.summary_id
       LEFT JOIN users u ON u.id = t.created_by
       WHERE t.workspace_id = $1 AND s.business_date BETWEEN $2 AND $3
       ORDER BY s.business_date, t.created_at`,
      [req.workspace.id, from, to]
    );

    const totals = rows.reduce(
      (acc, r) => ({
        credit: acc.credit + Number(r.credit),
        debit: acc.debit + Number(r.debit),
      }),
      { credit: 0, debit: 0 }
    );

    res.json({
      range: { from, to },
      days: rows,
      transactions: txRows,
      totals: {
        ...totals,
        opening_balance: rows[0]?.opening_balance ?? 0,
        closing_balance: rows[rows.length - 1]?.closing_balance ?? 0,
        net: totals.credit - totals.debit,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/workspaces/:workspaceId/reports/email  { from, to, recipient }
// Admin only — attaches a CSV of the range to a workspace-SMTP email.
router.post('/:workspaceId/reports/email', requireRole('admin'), async (req, res, next) => {
  try {
    const { from, to, recipient } = req.body ?? {};
    if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '')) {
      return res.status(400).json({ error: 'from/to must be YYYY-MM-DD' });
    }
    if (!recipient || !/^\S+@\S+\.\S+$/.test(recipient)) {
      return res.status(400).json({ error: 'Valid recipient email required' });
    }

    const { rows } = await db.query(
      `SELECT s.business_date, s.opening_balance, s.closing_balance,
              COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'income'), 0)  AS credit,
              COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'expense'), 0) AS debit
       FROM daily_summaries s
       LEFT JOIN transactions t ON t.summary_id = s.id
       WHERE s.workspace_id = $1 AND s.business_date BETWEEN $2 AND $3
       GROUP BY s.id
       ORDER BY s.business_date`,
      [req.workspace.id, from, to]
    );

    const { rows: txRows } = await db.query(
      `SELECT t.id, s.business_date, t.type, t.amount, t.category, t.description,
              t.received_from, t.paid_to, u.name AS created_by_name
       FROM transactions t
       JOIN daily_summaries s ON s.id = t.summary_id
       LEFT JOIN users u ON u.id = t.created_by
       WHERE t.workspace_id = $1 AND s.business_date BETWEEN $2 AND $3
       ORDER BY s.business_date, t.created_at`,
      [req.workspace.id, from, to]
    );

    // Counterparty folded into the description, like the app's txLabel.
    const descLabel = (r) => {
      const base = r.description ?? '';
      const party = r.type === 'income' ? r.received_from : r.paid_to;
      if (!party) return base;
      const tag = `${r.type === 'income' ? 'Received from' : 'Paid to'} ${party}`;
      return base ? `${base} · ${tag}` : tag;
    };
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const ddmmyyyy = (d) => {
      const [y, m, dd] = (d.toISOString?.().slice(0, 10) ?? String(d).slice(0, 10)).split('-');
      return `${dd}-${m}-${y}`;
    };
    const csv = [
      'Date,Opening,Credit,Debit,Closing',
      ...rows.map((r) =>
        [ddmmyyyy(r.business_date), r.opening_balance, r.credit, r.debit, r.closing_balance]
          .map(esc).join(',')
      ),
      '',
      'Date,Description,Category,Received,Paid,Recorded by',
      ...txRows.map((r) =>
        [
          ddmmyyyy(r.business_date),
          descLabel(r), r.category ?? '',
          r.type === 'income' ? r.amount : '', r.type === 'expense' ? r.amount : '',
          r.created_by_name ?? '',
        ].map(esc).join(',')
      ),
    ].join('\n');

    const sent = await sendWorkspaceMail(req.workspace.id, {
      to: recipient,
      subject: `${req.workspace.name} report ${from} → ${to}`,
      text: `Attached is the audit report for "${req.workspace.name}" covering ${from} to ${to}.`,
      attachments: [{ filename: `report-${from}-to-${to}.csv`, content: csv }],
    });
    if (!sent) {
      return res.status(400).json({ error: 'Email is not configured — set up SMTP in Settings first' });
    }
    await logAudit(db, {
      workspaceId: req.workspace.id, userId: req.user.id,
      action: 'report.email', entityType: 'report', entityId: null,
      details: { from, to, recipient },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: `Send failed: ${err.message}` });
  }
});

module.exports = router;
