const nodemailer = require('nodemailer');
const db = require('../config/db');

// Reads the workspace's stored SMTP config (password included — server-side only).
const getEmailSettings = async (workspaceId) => {
  const { rows } = await db.query(
    `SELECT host, port, username, password, from_address, secure
     FROM email_settings WHERE workspace_id = $1`,
    [workspaceId]
  );
  return rows[0] ?? null;
};

// Sends a mail through the workspace's SMTP config. Returns false when email
// isn't configured so callers can degrade gracefully (invite still succeeds).
const sendWorkspaceMail = async (workspaceId, { to, subject, text, html, attachments }) => {
  const s = await getEmailSettings(workspaceId);
  if (!s) return false;
  const transport = nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.secure,
    auth: s.username ? { user: s.username, pass: s.password } : undefined,
  });
  await transport.sendMail({
    from: s.from_address,
    to, subject, text, html, attachments,
  });
  return true;
};

module.exports = { getEmailSettings, sendWorkspaceMail };
