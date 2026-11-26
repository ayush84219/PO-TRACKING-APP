const pool = require('../db/pool');

/**
 * Sync a single user from user_app into user_details_app
 */
async function syncUserDetails(userId) {
  if (!userId) return;
  try {
    const [rows] = await pool.query(
      'SELECT id, name, email, role, base_role, department, is_active FROM user_app WHERE id = ?',
      [userId]
    );
    if (!rows.length) {
      await pool.query('DELETE FROM user_details_app WHERE user_id = ?', [userId]).catch(() => {});
      return;
    }
    const u = rows[0];
    await pool.query(
      `INSERT INTO user_details_app (user_id, name, email, role, base_role, department, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name),
         email = VALUES(email),
         role = VALUES(role),
         base_role = VALUES(base_role),
         department = VALUES(department),
         is_active = VALUES(is_active)`,
      [u.id, u.name, u.email, u.role, u.base_role, u.department, u.is_active]
    );
  } catch (err) {
    console.warn('[UserDirectory] syncUserDetails error:', err.message);
  }
}

/**
 * Fetch all users from user_details_app (falling back to user_app if empty)
 */
async function getAllUserDetails({ activeOnly = true } = {}) {
  const where = activeOnly ? 'WHERE is_active = 1' : '';
  try {
    const [rows] = await pool.query(
      `SELECT user_id AS id, user_id, name, email, role, base_role, department, is_active, created_at
       FROM user_details_app ${where}
       ORDER BY role ASC, name ASC`
    );
    if (rows.length > 0) return rows;
  } catch {}

  const [fallback] = await pool.query(
    `SELECT id, id AS user_id, name, email, role, base_role, department, is_active, created_at
     FROM user_app ${where}
     ORDER BY role ASC, name ASC`
  );
  return fallback;
}

/**
 * Get active users by role(s) from user_details_app
 */
async function getUsersByRole(roles = [], { excludeUserId = null } = {}) {
  const roleList = Array.isArray(roles) ? roles : [roles];
  if (!roleList.length) return [];
  const all = await getAllUserDetails({ activeOnly: true });
  return all.filter((u) => {
    if (excludeUserId && Number(u.user_id) === Number(excludeUserId)) return false;
    return roleList.includes(u.role) || roleList.includes(u.base_role);
  });
}

/**
 * Resolve ONLY the specific supervisor(s) assigned to a lot/PO from user_details_app.
 * Example: If lot is assigned to "Monu", ONLY Monu's user_id is returned — never other supervisors.
 */
async function resolveSupervisorUsers(assignedSupervisorName, assignedSupervisorId = null, { fallbackAllIfUnassigned = false, excludeUserId = null } = {}) {
  const allSupervisors = await getUsersByRole(['supervisor'], { excludeUserId });

  if (assignedSupervisorId) {
    const byId = allSupervisors.filter((u) => Number(u.user_id) === Number(assignedSupervisorId));
    if (byId.length > 0) return byId;
  }

  if (assignedSupervisorName && String(assignedSupervisorName).trim()) {
    const supKey = String(assignedSupervisorName).trim().toLowerCase();

    // 1. Exact name match or email local-part match
    const exactMatches = allSupervisors.filter((u) => {
      const uName = String(u.name || '').trim().toLowerCase();
      const uEmailLocal = String(u.email || '').split('@')[0].trim().toLowerCase();
      return uName === supKey || uEmailLocal === supKey;
    });
    if (exactMatches.length > 0) return exactMatches;

    // 2. Substring / word match (e.g. "Monu" matches "Monu Kumar" or "Monu (Supervisor)")
    const partialMatches = allSupervisors.filter((u) => {
      const uName = String(u.name || '').trim().toLowerCase();
      const uEmail = String(u.email || '').trim().toLowerCase();
      if (!uName) return false;
      return uName.includes(supKey) || supKey.includes(uName) || uEmail.includes(supKey);
    });
    if (partialMatches.length > 0) return partialMatches;

    // Assigned supervisor name did not match any user in user_details_app -> do NOT notify wrong supervisors!
    console.warn(`[UserDirectory] ⚠️ Assigned supervisor "${assignedSupervisorName}" not found in user_details_app. Skipping other supervisors.`);
    return [];
  }

  return fallbackAllIfUnassigned ? allSupervisors : [];
}

module.exports = {
  syncUserDetails,
  getAllUserDetails,
  getUsersByRole,
  resolveSupervisorUsers,
};
