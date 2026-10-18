// Dev seed: creates a demo user (admin of a demo workspace), opens today and
// yesterday, and inserts a few transactions — then prints a JWT you can paste
// into mobile/.env as EXPO_PUBLIC_DEV_TOKEN to skip the login screen.
//
// Idempotent — safe to re-run. Usage: npm run db:seed
// Run it on the machine whose DATABASE_URL/JWT_SECRET the app will call.

require('dotenv').config();
const jwt = require('jsonwebtoken');
const db = require('../config/db');

async function main() {
  const { rows: users } = await db.query(
    `INSERT INTO users (email, name, provider, provider_subject)
     VALUES ('dev@tressurer.local', 'Dev User', 'google', 'dev-seed')
     ON CONFLICT (provider, provider_subject) DO UPDATE SET name = EXCLUDED.name
     RETURNING *`
  );
  const user = users[0];

  let { rows: wss } = await db.query(
    `SELECT w.* FROM workspaces w
     JOIN workspace_members m ON m.workspace_id = w.id
     WHERE w.name = 'Demo Workspace' AND m.user_id = $1`,
    [user.id]
  );
  let ws = wss[0];
  if (!ws) {
    ws = (
      await db.query(
        `INSERT INTO workspaces (name, created_by) VALUES ('Demo Workspace', $1) RETURNING *`,
        [user.id]
      )
    ).rows[0];
    await db.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`,
      [ws.id, user.id]
    );
  }

  const day = (offset) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d.toISOString().slice(0, 10);
  };

  // Open yesterday and today (idempotent via the unique constraint).
  for (const [date, opening] of [
    [day(-1), 5000],
    [day(0), 5420],
  ]) {
    await db.query(
      `INSERT INTO daily_summaries (workspace_id, business_date, opening_balance, closing_balance, opened_by)
       VALUES ($1, $2, $3, $3, $4) ON CONFLICT (workspace_id, business_date) DO NOTHING`,
      [ws.id, date, opening, user.id]
    );
  }

  // A few transactions spread over both days — only inserted if none exist.
  const { rows: existing } = await db.query(
    `SELECT COUNT(*)::int AS n FROM transactions WHERE workspace_id = $1`,
    [ws.id]
  );
  if (existing[0].n === 0) {
    const seed = [
      [-1, 'income', 420, 'Client retainer — Al Noor Traders', 'Retainers'],
      [-1, 'expense', 85, 'Fuel for site visit', 'Travel'],
      [-1, 'expense', 35, 'Office coffee + supplies', 'Supplies'],
      [-1, 'income', 60, 'Reimbursement — utilities', 'Reimbursement'],
      [0, 'income', 1500, 'Invoice #1023 payment', 'Invoices'],
      [0, 'expense', 220, 'Software subscription renewal', 'Software'],
      [0, 'expense', 48.5, 'Courier charges', 'Logistics'],
      [0, 'income', 300, 'Cash deposit', 'Deposits'],
    ];
    for (const [offset, type, amount, description, category] of seed) {
      const { rows: sums } = await db.query(
        `SELECT id FROM daily_summaries WHERE workspace_id = $1 AND business_date = $2`,
        [ws.id, day(offset)]
      );
      await db.query(
        `INSERT INTO transactions (workspace_id, summary_id, created_by, type, amount, category, description)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [ws.id, sums[0].id, user.id, type, amount, category, description]
      );
    }
    // Refresh closing balances to include the seeded transactions.
    await db.query(
      `UPDATE daily_summaries s SET closing_balance = s.opening_balance + COALESCE(t.net, 0)
       FROM (SELECT summary_id, SUM(CASE WHEN type='income' THEN amount ELSE -amount END) AS net
             FROM transactions WHERE workspace_id = $1 GROUP BY summary_id) t
       WHERE s.id = t.summary_id`,
      [ws.id]
    );
  }

  const token = jwt.sign(
    { sub: user.id, email: user.email, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );

  console.log('\nSeed complete. Paste this line into mobile/.env:\n');
  console.log(`EXPO_PUBLIC_DEV_TOKEN=${token}\n`);

  await db.pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
