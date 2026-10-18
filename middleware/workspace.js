const db = require('../config/db');

// Resolves :workspaceId membership for req.user and attaches:
//   req.workspace  — { id, name }
//   req.membership — { role }
// requireRole() gates on membership only; requireRole('admin') gates admins.
const requireRole = (...roles) => async (req, res, next) => {
  try {
    const { workspaceId } = req.params;
    const { rows } = await db.query(
      `SELECT w.id, w.name, m.role
       FROM workspace_members m
       JOIN workspaces w ON w.id = m.workspace_id
       WHERE m.workspace_id = $1 AND m.user_id = $2`,
      [workspaceId, req.user.id]
    );

    const row = rows[0];
    if (!row) {
      // Same response for "no such workspace" and "not a member" — don't leak existence.
      return res.status(404).json({ error: 'Workspace not found' });
    }
    if (roles.length && !roles.includes(row.role)) {
      return res.status(403).json({ error: 'Admin role required' });
    }

    req.workspace = { id: row.id, name: row.name };
    req.membership = { role: row.role };
    next();
  } catch (err) {
    next(err);
  }
};

module.exports = { requireRole };
