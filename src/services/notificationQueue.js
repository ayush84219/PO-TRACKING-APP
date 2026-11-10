const pool = require('../db/pool');
const { sendPush } = require('./push');
const { logAudit } = require('./auditLogger');

let workerTimer = null;

/**
 * Enqueue a notification in the persistent MySQL queue
 */
async function enqueueNotification({
  lotNumber = null,
  eventId = null,
  userId = null,
  targetRole = null,
  title,
  message,
  payload = {},
  maxAttempts = 3,
  nextRetryDelaySec = 0,
}) {
  const jsonPayload = payload ? (typeof payload === 'string' ? payload : JSON.stringify(payload)) : null;

  const [res] = await pool.query(
    `INSERT INTO notification_queue_app (
       lot_number, event_id, user_id, target_role, title, message, payload,
       status, attempts, max_attempts, next_retry_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))`,
    [lotNumber, eventId, userId, targetRole, title, message, jsonPayload, maxAttempts, nextRetryDelaySec]
  );

  const queueId = res.insertId;

  // Mirror into active notifications table for immediate in-app inbox availability
  try {
    if (userId) {
      await pool.query(
        `INSERT INTO notifications_app (user_id, title, message, lot_number) VALUES (?, ?, ?, ?)`,
        [userId, title, message, lotNumber]
      );
    } else if (targetRole) {
      const [roleUsers] = await pool.query(
        `SELECT id FROM user_app WHERE (role = ? OR base_role = ?) AND is_active = 1`,
        [targetRole, targetRole]
      );
      if (roleUsers.length > 0) {
        await pool.query(
          `INSERT INTO notifications_app (user_id, title, message, lot_number) VALUES ?`,
          [roleUsers.map(u => [u.id, title, message, lotNumber])]
        );
      }
    }
  } catch (e) {
    console.warn('[Queue] Could not mirror to notifications table:', e.message);
  }

  return queueId;
}

/**
 * Process pending notifications ready for delivery or retry
 */
async function processPendingQueue(batchSize = 20, forceSendPush = sendPush) {
  const [items] = await pool.query(
    `SELECT * FROM notification_queue_app
     WHERE status = 'pending' AND next_retry_at <= NOW() AND attempts < max_attempts
     ORDER BY id ASC LIMIT ?`,
    [batchSize]
  );

  if (!items.length) return { processed: 0, delivered: 0, retried: 0, failed: 0 };

  let deliveredCount = 0;
  let retriedCount = 0;
  let failedCount = 0;

  for (const item of items) {
    let parsedPayload = {};
    try {
      parsedPayload = typeof item.payload === 'string' ? JSON.parse(item.payload) : (item.payload || {});
    } catch {
      parsedPayload = {};
    }

    try {
      const recipientIds = item.user_id ? [item.user_id] : [];
      if (!recipientIds.length && item.target_role) {
        const [users] = await pool.query(
          `SELECT id FROM user_app WHERE (role = ? OR base_role = ?) AND is_active = 1`,
          [item.target_role, item.target_role]
        );
        recipientIds.push(...users.map(u => u.id));
      }

      if (recipientIds.length > 0) {
        await forceSendPush(recipientIds, item.title, item.message, {
          lotNumber: item.lot_number,
          queueId: item.id,
          ...parsedPayload,
        });
      }

      // Mark delivered
      await pool.query(
        `UPDATE notification_queue_app SET status = 'delivered', attempts = attempts + 1, updated_at = NOW() WHERE id = ?`,
        [item.id]
      );
      deliveredCount++;

      await logAudit({
        eventType: 'NOTIFICATION_DELIVERED',
        lotNumber: item.lot_number,
        userId: item.user_id,
        details: { queueId: item.id, attempts: item.attempts + 1 },
      });
    } catch (pushErr) {
      const nextAttempt = item.attempts + 1;
      const errorMsg = (pushErr && pushErr.message) || 'Push dispatch error';

      if (nextAttempt >= item.max_attempts) {
        // Exceeded max retries -> Mark failed
        await pool.query(
          `UPDATE notification_queue_app
           SET status = 'failed', attempts = ?, last_error = ?, updated_at = NOW()
           WHERE id = ?`,
          [nextAttempt, errorMsg, item.id]
        );
        failedCount++;

        await logAudit({
          eventType: 'NOTIFICATION_DELIVERY_FAILED',
          lotNumber: item.lot_number,
          userId: item.user_id,
          details: { queueId: item.id, attempts: nextAttempt, maxAttempts: item.max_attempts, error: errorMsg },
        });
      } else {
        // Exponential/linear backoff: next attempt in (nextAttempt * 30) seconds
        const backoffSec = nextAttempt * 30;
        await pool.query(
          `UPDATE notification_queue_app
           SET attempts = ?, last_error = ?,
               next_retry_at = DATE_ADD(NOW(), INTERVAL ? SECOND),
               updated_at = NOW()
           WHERE id = ?`,
          [nextAttempt, errorMsg, backoffSec, item.id]
        );
        retriedCount++;

        await logAudit({
          eventType: 'NOTIFICATION_RETRY_SCHEDULED',
          lotNumber: item.lot_number,
          userId: item.user_id,
          details: { queueId: item.id, attempts: nextAttempt, backoffSec, error: errorMsg },
        });
      }
    }
  }

  return { processed: items.length, delivered: deliveredCount, retried: retriedCount, failed: failedCount };
}

/**
 * Check for unacknowledged gate arrival materials exceeding SLA and escalate to backup supervisors
 */
async function checkAndTriggerEscalations(slaMinutes = 15, forceSendPush = sendPush, batchLimit = 20) {
  // Find distinct overdue gate arrival lots that are unacknowledged and older than slaMinutes
  const [overdue] = await pool.query(
    `SELECT MIN(nq.id) AS id, nq.lot_number, MIN(nq.user_id) AS user_id, MIN(u.name) AS primarySupervisorName
     FROM notification_queue_app nq
     LEFT JOIN user_app u ON u.id = nq.user_id
     WHERE (nq.status = 'pending' OR nq.status = 'delivered')
       AND nq.acknowledged_at IS NULL
       AND nq.escalated_at IS NULL
       AND nq.created_at <= DATE_SUB(NOW(), INTERVAL ? MINUTE)
       AND nq.lot_number IS NOT NULL
       AND (nq.title LIKE '%Arrived at Gate%' OR nq.title LIKE '%Gate%')
     GROUP BY nq.lot_number
     LIMIT ?`,
    [slaMinutes, batchLimit]
  );

  if (!overdue.length) return { escalatedCount: 0, escalatedLots: [] };

  const escalatedLots = [];

  for (const item of overdue) {
    // 1. Mark all queue entries for this lot as escalated
    await pool.query(
      `UPDATE notification_queue_app
       SET status = 'escalated', escalated_at = NOW()
       WHERE lot_number = ? AND escalated_at IS NULL`,
      [item.lot_number]
    );

    // 2. Identify backup supervisor (active supervisor or admin other than the original recipient)
    let [backupUsers] = await pool.query(
      `SELECT id, name, role, email FROM user_app
       WHERE (role IN ('supervisor', 'admin') OR base_role IN ('supervisor', 'admin'))
         AND is_active = 1
         AND id != ?
       ORDER BY (role = 'supervisor') DESC, id ASC`,
      [item.user_id || 0]
    );

    if (!backupUsers.length) {
      // Fallback: any active admin
      const [admins] = await pool.query(`SELECT id, name, role, email FROM user_app WHERE role = 'admin' AND is_active = 1`);
      backupUsers = admins;
    }

    const backupIds = backupUsers.map(b => b.id);
    const primaryName = item.primarySupervisorName || `Supervisor #${item.user_id || 'Unknown'}`;
    const escalationTitle = `⚠️ ESCALATION: Lot ${item.lot_number} Unattended at Gate`;
    const escalationMsg = `SLA Breached (${slaMinutes}m): Lot ${item.lot_number} not acknowledged by ${primaryName}. Urgent pickup required.`;

    if (backupIds.length > 0) {
      // Record escalation in queue for the backup supervisors
      for (const backup of backupUsers) {
        await enqueueNotification({
          lotNumber: item.lot_number,
          userId: backup.id,
          targetRole: backup.role,
          title: escalationTitle,
          message: escalationMsg,
          payload: {
            escalation: true,
            originalQueueId: item.id,
            originalUserId: item.user_id,
            slaMinutes,
            urgency: 'CRITICAL',
          },
        });
      }

      // Fire push immediately to backup supervisors
      try {
        await forceSendPush(backupIds, escalationTitle, escalationMsg, {
          lotNumber: item.lot_number,
          escalation: true,
          type: 'escalation_alert',
        });
      } catch (err) {
        console.warn('[Escalation] Backup push error:', err.message);
      }
    }

    // 3. Log audit event
    await logAudit({
      eventType: 'ESCALATION_TRIGGERED',
      lotNumber: item.lot_number,
      userId: item.user_id,
      userName: primaryName,
      details: {
        originalQueueId: item.id,
        slaMinutes,
        backupUserIds: backupIds,
        backupNames: backupUsers.map(b => b.name),
      },
    });

    escalatedLots.push(item.lot_number);
  }

  return { escalatedCount: overdue.length, escalatedLots };
}

/**
 * Acknowledge a material lot (supervisor confirmed sight or pickup)
 */
async function acknowledgeLot(lotNumber, ackUserId, ackUserName = null, ackUserRole = null) {
  const [res] = await pool.query(
    `UPDATE notification_queue_app
     SET status = 'acknowledged',
         acknowledged_at = NOW(),
         acknowledged_by = ?
     WHERE lot_number = ? AND acknowledged_at IS NULL`,
    [ackUserId, lotNumber]
  );

  // Also mark in-app notifications for this user / lot as read
  await pool.query(
    `UPDATE notifications_app SET is_read = 1 WHERE lot_number = ? AND user_id = ?`,
    [lotNumber, ackUserId]
  ).catch(() => {});

  if (res.affectedRows > 0) {
    await logAudit({
      eventType: 'NOTIFICATION_ACKNOWLEDGED',
      lotNumber,
      userId: ackUserId,
      userName: ackUserName,
      userRole: ackUserRole,
      details: { acknowledgedQueueRows: res.affectedRows },
    });
  }

  return res.affectedRows;
}

/**
 * Acknowledge a specific notification by ID
 */
async function acknowledgeById(queueId, ackUserId, ackUserName = null, ackUserRole = null) {
  const [[item]] = await pool.query(`SELECT * FROM notification_queue_app WHERE id = ?`, [queueId]);
  if (!item) return false;

  await pool.query(
    `UPDATE notification_queue_app
     SET status = 'acknowledged',
         acknowledged_at = NOW(),
         acknowledged_by = ?
     WHERE id = ?`,
    [ackUserId, queueId]
  );

  await pool.query(
    `UPDATE notifications_app SET is_read = 1 WHERE lot_number = ? AND user_id = ?`,
    [item.lot_number, ackUserId]
  ).catch(() => {});

  await logAudit({
    eventType: 'NOTIFICATION_ACKNOWLEDGED',
    lotNumber: item.lot_number,
    userId: ackUserId,
    userName: ackUserName,
    userRole: ackUserRole,
    details: { queueId },
  });

  return true;
}

/**
 * Start background queue runner and SLA escalation monitor
 */
function startQueueWorker({ intervalMs = 20000, slaMinutes = 15 } = {}) {
  if (workerTimer) return;

  const runTick = async () => {
    try {
      await processPendingQueue();
      await checkAndTriggerEscalations(slaMinutes);
    } catch (err) {
      console.error('[NotificationWorker] Worker tick error:', err.message);
    }
  };

  workerTimer = setInterval(runTick, intervalMs);
  console.log(`[NotificationWorker] Background worker started (tick: ${intervalMs}ms, SLA: ${slaMinutes}m).`);
}

/**
 * Stop background queue runner
 */
function stopQueueWorker() {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
    console.log('[NotificationWorker] Background worker stopped.');
  }
}

module.exports = {
  enqueueNotification,
  processPendingQueue,
  checkAndTriggerEscalations,
  acknowledgeLot,
  acknowledgeById,
  startQueueWorker,
  stopQueueWorker,
};

