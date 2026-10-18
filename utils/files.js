const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const UPLOADS_ROOT = path.join(__dirname, '..', 'uploads');

// Folder-name-safe: lowercase alnum, dash and underscore only.
const sanitizeSegment = (name) =>
  String(name || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64) || 'unknown';

// Cryptographic-hash filename: sha256(content + random salt), keeping the
// original extension. Content-derived + salted so names are unguessable and
// collision-proof without leaking the original filename.
const hashFilename = (buffer, originalName) => {
  const ext = path.extname(originalName || '').toLowerCase().replace(/[^a-z0-9.]/g, '');
  const hash = crypto
    .createHash('sha256')
    .update(buffer)
    .update(crypto.randomUUID())
    .digest('hex');
  return `${hash}${ext}`;
};

// Writes buffer to uploads/{workspace}/{user}/{YYYY-MM-DD}/{hash}{ext} and
// returns the path relative to UPLOADS_ROOT for storage in the DB.
const storeUpload = async ({ workspaceName, userName, date, file }) => {
  const dir = path.join(
    UPLOADS_ROOT,
    sanitizeSegment(workspaceName),
    sanitizeSegment(userName),
    date // YYYY-MM-DD
  );
  await fs.promises.mkdir(dir, { recursive: true });

  const filename = hashFilename(file.buffer, file.originalname);
  await fs.promises.writeFile(path.join(dir, filename), file.buffer);

  return path
    .relative(UPLOADS_ROOT, path.join(dir, filename))
    .split(path.sep)
    .join('/');
};

// Resolves a stored relative path back to an absolute path, refusing anything
// that escapes UPLOADS_ROOT (path-traversal guard for the download endpoint).
const resolveUpload = (relativePath) => {
  const abs = path.resolve(UPLOADS_ROOT, relativePath);
  if (!abs.startsWith(UPLOADS_ROOT + path.sep)) {
    return null;
  }
  return abs;
};

// Deletes a stored file only when no transaction_proofs row still references
// it — combined income+expense entries share the same stored files.
// `db` is the pg pool (or a transaction client).
const unlinkIfOrphaned = async (db, filePath) => {
  const { rows } = await db.query(
    'SELECT 1 FROM transaction_proofs WHERE file_path = $1 LIMIT 1',
    [filePath]
  );
  if (rows.length) return false;
  const abs = resolveUpload(filePath);
  if (!abs) return false;
  await fs.promises.unlink(abs).catch(() => {});
  return true;
};

module.exports = { UPLOADS_ROOT, sanitizeSegment, storeUpload, resolveUpload, unlinkIfOrphaned };
