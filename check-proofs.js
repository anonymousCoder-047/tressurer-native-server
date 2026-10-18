require('dotenv').config();
const db = require('./config/db');

(async () => {
  const { rows: o } = await db.query(
    `SELECT COUNT(*) AS orphans FROM transactions t
     WHERE t.proof_file_path IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM transaction_proofs p WHERE p.transaction_id = t.id)`
  );
  const { rows: t } = await db.query('SELECT COUNT(*) AS total FROM transaction_proofs');
  console.log('orphaned transactions:', o[0].orphans, '| proof rows:', t[0].total);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
