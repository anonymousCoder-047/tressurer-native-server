require('dotenv').config();
const db = require('./config/db');
const ws = process.argv[2];
const tables = ['workspace_members', 'daily_summaries', 'transactions', 'transaction_proofs', 'audit_approval_requests', 'audit_log', 'trash', 'email_settings'];
(async () => {
  for (const t of tables) {
    const col = t === 'transaction_proofs' ? 'transaction_id IN (SELECT id FROM transactions WHERE workspace_id' : 'workspace_id';
    const q = t === 'transaction_proofs'
      ? `SELECT COUNT(*) c FROM transaction_proofs WHERE transaction_id IN (SELECT id FROM transactions WHERE workspace_id = $1)`
      : `SELECT COUNT(*) c FROM ${t} WHERE workspace_id = $1`;
    const { rows } = await db.query(q, [ws]);
    console.log(t.padEnd(28), rows[0].c);
  }
  const { rows: w } = await db.query('SELECT COUNT(*) c FROM workspaces WHERE id=$1', [ws]);
  console.log('workspaces'.padEnd(28), w[0].c);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
