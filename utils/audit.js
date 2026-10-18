// Append-only audit trail. Accepts a pg client (inside a transaction) or the
// pool — anything with .query().
const logAudit = (executor, { workspaceId, userId, action, entityType, entityId, details }) =>
  executor.query(
    `INSERT INTO audit_log (workspace_id, user_id, action, entity_type, entity_id, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [workspaceId ?? null, userId ?? null, action, entityType ?? null, entityId ?? null, details ?? null]
  );

// Recalculates a summary's closing balance from its transactions.
// closing = opening + Σ(income) − Σ(expense)
const recalcClosingBalance = (client, summaryId) =>
  client.query(
    `UPDATE daily_summaries
     SET closing_balance = opening_balance + (
       SELECT COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE -amount END), 0)
       FROM transactions
       WHERE summary_id = $1
     )
     WHERE id = $1`,
    [summaryId]
  );

module.exports = { logAudit, recalcClosingBalance };
