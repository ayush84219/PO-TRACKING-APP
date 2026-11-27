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

/**
 * Case-insensitive match between a user's name/email and an assigned supervisor name
 */
function isSupervisorNameMatch(userName, assignedSupervisorName) {
  if (!userName || !assignedSupervisorName) return false;
  const u = String(userName).trim().toLowerCase();
  const sup = String(assignedSupervisorName).trim().toLowerCase();
  if (!u || !sup) return false;
  return u === sup || u.includes(sup) || sup.includes(u);
}

/**
 * Resolve the assigned Supervisor name for a Lot / PO number by checking:
 * 1. cutting_header (Lot_Number)
 * 2. purchase_orders (supervisorName or designName -> cutting_header)
 * 3. zip / old_zip / doori / old_doori
 * 4. supervisor_details_app
 */
async function resolveLotSupervisor(lotOrPo, extraLot = null) {
  const candidates = [];
  for (const val of [lotOrPo, extraLot]) {
    if (!val) continue;
    const raw = String(val).trim().toUpperCase();
    const digits = raw.replace(/[^0-9]/g, '');
    const stripped = raw.replace(/^(PO-|ZIP-|DORI-|DOORI-|RGP[-/]?)/i, '');
    if (raw) candidates.push(raw);
    if (stripped && stripped !== raw) candidates.push(stripped);
    if (digits && digits !== raw && digits !== stripped) candidates.push(digits);
  }
  const uniqueKeys = [...new Set(candidates)];
  if (!uniqueKeys.length) return null;

  // 1. Check cutting_header (Primary source of truth for Lot Supervisor)
  try {
    const [ch] = await pool.query(
      `SELECT Supervisor FROM cutting_header
       WHERE Lot_Number IN (?) AND Supervisor IS NOT NULL AND TRIM(Supervisor) != ''
       ORDER BY id DESC LIMIT 1`,
      [uniqueKeys]
    );
    if (ch.length && ch[0].Supervisor) {
      return String(ch[0].Supervisor).trim();
    }
  } catch {}

  // 2. Check purchase_orders (and if designName is a Lot_Number, resolve from cutting_header)
  try {
    const [po] = await pool.query(
      `SELECT supervisorName, designName FROM purchase_orders
       WHERE poNumber IN (?) OR designName IN (?)
       ORDER BY id DESC LIMIT 1`,
      [uniqueKeys, uniqueKeys]
    );
    if (po.length) {
      if (po[0].supervisorName && String(po[0].supervisorName).trim()) {
        return String(po[0].supervisorName).trim();
      }
      if (po[0].designName && String(po[0].designName).trim()) {
        const dKey = String(po[0].designName).trim();
        const [ch2] = await pool.query(
          `SELECT Supervisor FROM cutting_header
           WHERE Lot_Number = ? AND Supervisor IS NOT NULL AND TRIM(Supervisor) != ''
           ORDER BY id DESC LIMIT 1`,
          [dKey]
        ).catch(() => [[]]);
        if (ch2.length && ch2[0].Supervisor) {
          return String(ch2[0].Supervisor).trim();
        }
      }
    }
  } catch {}

  // 3. Check zip & old_zip
  try {
    const [z] = await pool.query(
      `SELECT Supervisor FROM zip
       WHERE (po_number IN (?) OR Lot_Number IN (?)) AND Supervisor IS NOT NULL AND TRIM(Supervisor) != ''
       ORDER BY id DESC LIMIT 1`,
      [uniqueKeys, uniqueKeys]
    );
    if (z.length && z[0].Supervisor) return String(z[0].Supervisor).trim();
  } catch {}
  try {
    const [oz] = await pool.query(
      `SELECT Supervisor FROM old_zip
       WHERE Lot_Number IN (?) AND Supervisor IS NOT NULL AND TRIM(Supervisor) != ''
       ORDER BY id DESC LIMIT 1`,
      [uniqueKeys]
    );
    if (oz.length && oz[0].Supervisor) return String(oz[0].Supervisor).trim();
  } catch {}

  // 4. Check doori & old_doori
  try {
    const [d] = await pool.query(
      `SELECT Supervisor FROM doori
       WHERE (po_number IN (?) OR Lot_Number IN (?)) AND Supervisor IS NOT NULL AND TRIM(Supervisor) != ''
       ORDER BY id DESC LIMIT 1`,
      [uniqueKeys, uniqueKeys]
    );
    if (d.length && d[0].Supervisor) return String(d[0].Supervisor).trim();
  } catch {}
  try {
    const [od] = await pool.query(
      `SELECT Supervisor FROM old_doori
       WHERE Lot_Number IN (?) AND Supervisor IS NOT NULL AND TRIM(Supervisor) != ''
       ORDER BY id DESC LIMIT 1`,
      [uniqueKeys]
    );
    if (od.length && od[0].Supervisor) return String(od[0].Supervisor).trim();
  } catch {}

  // 5. Fallback to supervisor_details_app
  try {
    const [sd] = await pool.query(
      `SELECT supervisor FROM supervisor_details_app
       WHERE lot_number IN (?) AND supervisor IS NOT NULL AND TRIM(supervisor) != ''
       LIMIT 1`,
      [uniqueKeys]
    );
    if (sd.length && sd[0].supervisor) return String(sd[0].supervisor).trim();
  } catch {}

  return null;
}

/**
 * Get distinct list of all supervisor names from cutting_header & user_details_app
 */
async function getAllCuttingSupervisors() {
  const names = new Set();
  try {
    const [ch] = await pool.query(
      `SELECT DISTINCT TRIM(Supervisor) AS sup FROM cutting_header
       WHERE Supervisor IS NOT NULL AND TRIM(Supervisor) != '' ORDER BY sup ASC`
    );
    ch.forEach((r) => { if (r.sup) names.add(r.sup); });
  } catch {}
  try {
    const sups = await getUsersByRole(['supervisor'], {});
    sups.forEach((u) => { if (u.name) names.add(u.name.trim()); });
  } catch {}
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

module.exports = {
  syncUserDetails,
  getAllUserDetails,
  getUsersByRole,
  resolveSupervisorUsers,
  isSupervisorNameMatch,
  resolveLotSupervisor,
  getAllCuttingSupervisors,
};
