const pool = require('../db/pool');

/**
 * Log an audit event to the persistent audit_logs MySQL table.
 */
async function logAudit({
  eventType,
  lotNumber = null,
  userId = null,
  userName = null,
  userRole = null,
  details = null,
  ipAddress = null,
}) {
  try {
    const jsonDetails = details ? (typeof details === 'string' ? details : JSON.stringify(details)) : null;
    await pool.query(
      `INSERT INTO audit_logs_app (event_type, lot_number, user_id, user_name, user_role, details, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [eventType, lotNumber, userId, userName, userRole, jsonDetails, ipAddress]
    );
  } catch (err) {
    console.error('[AuditLog] Failed to record audit log:', err.message);
  }
}

/**
 * Query audit logs with pagination and filters
 */
async function queryAuditLogs({ limit = 50, offset = 0, eventType, lotNumber, userId }) {
  const where = ['1=1'];
  const params = [];

  if (eventType) {
    where.push('event_type = ?');
    params.push(eventType);
  }
  if (lotNumber) {
    where.push('lot_number = ?');
    params.push(lotNumber);
  }
  if (userId) {
    where.push('user_id = ?');
    params.push(userId);
  }

  const [items] = await pool.query(
    `SELECT id, event_type AS eventType, lot_number AS lotNumber, user_id AS userId,
            user_name AS userName, user_role AS userRole, details, ip_address AS ipAddress,
            created_at AS createdAt
     FROM audit_logs_app
     WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC, id DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  const [[countRow]] = await pool.query(
    `SELECT COUNT(*) AS total FROM audit_logs_app WHERE ${where.join(' AND ')}`,
    params
  );

  return { items, total: countRow.total };
}

module.exports = { logAudit, queryAuditLogs };

