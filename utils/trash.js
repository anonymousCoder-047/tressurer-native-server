const fs = require('fs');
const db = require('../config/db');
const { resolveUpload, unlinkIfOrphaned } = require('./files');

// Moves a transaction into trash instead of hard-deleting it. The payload
// snapshots every field needed for a lossless restore (incl. business_date
// from the summary and created_by_name for display) plus a label for the bin.
// Call inside a transaction; the caller still recalcs closing + logs audit.
const moveToTrash = async (client, { workspaceId, tx, deletedBy }) => {
  const { rows } = await client.query(
    `SELECT s.business_date, u.name AS created_by_name
     FROM daily_summaries s JOIN users u ON u.id = $2
     WHERE s.id = $1`,
    [tx.summary_id, tx.created_by]
  );
  const meta = rows[0] ?? {};
  // Snapshot proof rows too — restores re-create them and purges unlink files.
  const { rows: proofs } = await client.query(
    `SELECT id, file_path, mime, original_name, created_at
     FROM transaction_proofs WHERE transaction_id = $1`,
    [tx.id]
  );
  await client.query(
    `INSERT INTO trash (workspace_id, entity_type, entity_id, payload, deleted_by)
     VALUES ($1, 'transaction', $2, $3, $4)`,
    [
      workspaceId, tx.id,
      JSON.stringify({
        ...tx,
        business_date: meta.business_date ?? null,
        created_by_name: meta.created_by_name ?? null,
        proofs,
      }),
      deletedBy,
    ]
  );
};

// All file paths stored for a trashed payload (proofs + legacy mirror).
const payloadProofPaths = (payload) => {
  const paths = new Set((payload?.proofs ?? []).map((p) => p.file_path));
  if (payload?.proof_file_path) paths.add(payload.proof_file_path);
  return [...paths];
};

// Permanently deletes expired trash rows + their proof files. Called lazily on
// trash reads and on a daily interval from index.js.
const purgeExpired = async () => {
  const { rows } = await db.query(
    `DELETE FROM trash WHERE expires_at < now() RETURNING payload`
  );
  for (const row of rows) {
    for (const rel of payloadProofPaths(row.payload)) {
      await unlinkIfOrphaned(db, rel);
    }
  }
  return rows.length;
};

module.exports = { moveToTrash, purgeExpired, payloadProofPaths };
