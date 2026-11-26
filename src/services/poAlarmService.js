const pool = require('../db/pool');
const { sendFcmPush } = require('./fcmPush');
const { getIO, emitToUsers } = require('./socketService');
const { logAudit } = require('./auditLogger');
const { resolveSupervisorUsers } = require('./userDirectory');

/**
 * Format currency amount for PO display (e.g., ₹25,000)
 */
function formatPoAmount(rawAmount) {
  if (!rawAmount && rawAmount !== 0) return '₹25,000';
  const num = Number(String(rawAmount).replace(/[^0-9.-]/g, ''));
  if (isNaN(num) || num <= 0) return '₹25,000';
  return `₹${num.toLocaleString('en-IN')}`;
}

/**
 * Format time for display (e.g., 10:30 AM)
 */
function formatTimeDisplay(dateInput) {
  const d = dateInput ? new Date(dateInput) : new Date();
  const validDate = isNaN(d.getTime()) ? new Date() : d;
  return validDate.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Periodically check and mark alarms as EXPIRED after 60 seconds
 */
async function checkAndExpireAlarms() {
  try {
    const [res] = await pool.query(
      `UPDATE po_alarm_events_app
       SET status = 'EXPIRED', expired_at = NOW()
       WHERE status IN ('SENT', 'DELIVERED', 'PENDING') AND expires_at IS NOT NULL AND expires_at < NOW()`
    );
    if (res.affectedRows > 0) {
      console.log(`[POAlarmService] ⏰ Marked ${res.affectedRows} PO alarms as EXPIRED (60s auto-expiry reached).`);
    }
  } catch (err) {
    // Safe execution
  }
}

// Start 15s interval for expiring alarms
setInterval(checkAndExpireAlarms, 15000);

/**
 * Triggers a Smart PO Alert and Alarm Notification
 * Saves status as SENT, expires_at = NOW() + 60s
 */
async function triggerPoAlarm({
  poNumber,
  vendorName = 'Supplier / Vendor',
  amount = null,
  orderDate = null,
  items = null,
  designName = null,
  triggeredBy = 'System / ERP',
  assignedSupervisor = null,
  assignedSupervisorId = null,
}) {
  if (!poNumber) return null;

  const rawPo = String(poNumber).trim();
  const cleanDigits = rawPo.replace(/[^0-9]/g, '') || rawPo;
  const formattedPo = rawPo.toUpperCase().startsWith('PO-') ? rawPo.toUpperCase() : `PO-${cleanDigits}`;
  const displaySupplier = vendorName || 'ABC Traders';
  const displayAmount = formatPoAmount(amount);
  const displayTime = formatTimeDisplay(orderDate);
  const nowIso = new Date().toISOString();

  // 1. Idempotency Check: Prevent duplicate active alerts for the exact same PO while not expired
  try {
    const [existing] = await pool.query(
      `SELECT id, event_id, status FROM po_alarm_events_app 
       WHERE po_number = ? AND status IN ('SENT', 'DELIVERED', 'PENDING') AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY id DESC LIMIT 1`,
      [formattedPo]
    );

    if (existing.length > 0) {
      console.log(`[POAlarmService] ⚠️ Active alert already ringing/pending for ${formattedPo} (${existing[0].event_id}). Skipping duplicate.`);
      return {
        success: true,
        isDuplicate: true,
        eventId: existing[0].event_id,
        poNumber: formattedPo,
      };
    }
  } catch (err) {
    console.warn('[POAlarmService] Note checking existing po_alarm_events_app:', err.message);
  }

  const eventId = `EVT-PO-ALARM-${cleanDigits}-${Date.now()}`;

  // 2. Query target users (Gate, Store, and ONLY the Assigned Supervisor — NEVER Admin!)
  let targetUsers = [];
  try {
    const [users] = await pool.query(
      `SELECT u.user_id AS id, u.name, u.role, u.base_role, u.email,
              COALESCE(s.po_alerts_enabled, 1) AS po_alerts_enabled,
              COALESCE(s.alarm_sound_enabled, 1) AS alarm_sound_enabled,
              COALESCE(s.alarm_tone, 'alarm_siren') AS alarm_tone,
              COALESCE(s.alarm_duration_sec, 30) AS alarm_duration_sec
       FROM user_details_app u
       LEFT JOIN user_notification_settings_app s ON s.user_id = u.user_id
       WHERE u.is_active = 1 AND (
         u.role IN ('gate', 'store', 'supervisor') OR
         u.base_role IN ('gate', 'store', 'supervisor')
       )`
    );

    const activeEnabledUsers = users.filter((u) => u.po_alerts_enabled !== 0 && u.role !== 'admin' && u.base_role !== 'admin');

    // Non-supervisor operational roles (gate, store)
    const gateStoreUsers = activeEnabledUsers.filter((u) => {
      const isSupervisor = (u.role === 'supervisor' || u.base_role === 'supervisor');
      return !isSupervisor;
    });

    // Resolve ONLY the specific assigned supervisor by ID/name from user_details_app
    const matchedSups = await resolveSupervisorUsers(assignedSupervisor, assignedSupervisorId);
    const matchedSupIds = new Set(matchedSups.map((s) => Number(s.user_id || s.id)));
    const enabledMatchedSups = activeEnabledUsers.filter((u) => matchedSupIds.has(Number(u.id)));

    targetUsers = [...gateStoreUsers, ...enabledMatchedSups];
  } catch (err) {
    console.error('[POAlarmService] Error querying target users:', err.message);
  }

  const targetUserIds = targetUsers.map((u) => u.id);

  // 3. Persist alarm event in database with status 'SENT', 60s expiration
  try {
    await pool.query(
      `INSERT INTO po_alarm_events_app 
         (event_id, po_number, supplier_name, amount, received_at, sent_at, expires_at, status)
       VALUES (?, ?, ?, ?, NOW(), NOW(), DATE_ADD(NOW(), INTERVAL 60 SECOND), 'SENT')`,
      [eventId, formattedPo, displaySupplier, displayAmount]
    );
  } catch (err) {
    console.error('[POAlarmService] Error recording alarm event:', err.message);
  }

  // 4. Construct Notification Details
  const title = '🚨 NEW PURCHASE ORDER RECEIVED!';
  const supervisorLine = assignedSupervisor ? `\nSupervisor: ${assignedSupervisor}` : '';
  const body = `PO Number: ${formattedPo}\nSupplier: ${displaySupplier}\nAmount: ${displayAmount}\nTime: ${displayTime}${supervisorLine}`;

  const notificationData = {
    type: 'PO_ALARM',
    eventType: 'PO_ALARM',
    eventId,
    poNumber: formattedPo,
    supplier: displaySupplier,
    vendorName: displaySupplier,
    amount: displayAmount,
    receivedTime: displayTime,
    assignedSupervisor: assignedSupervisor || '',
    assignedSupervisorId: String(assignedSupervisorId || ''),
    timestamp: nowIso,
    channelId: 'po_alarm_channel',
    isEmergencyAlarm: 'true',
    actions: JSON.stringify([
      { id: 'OPEN_PO', title: 'OPEN PO' },
      { id: 'STOP_ALARM', title: 'STOP' },
    ]),
  };

  // 5. Send High-Priority FCM Push Notification
  if (targetUserIds.length > 0) {
    sendFcmPush(targetUserIds, title, body, notificationData).catch((err) => {
      console.error('[POAlarmService] Error dispatching push:', err.message);
    });
  }

  // 6. Targeted Real-Time Socket.IO Event ONLY to targetUserIds (never Admin, never unrelated Supervisors)
  if (targetUserIds.length > 0) {
    const socketPayload = {
      eventId,
      eventType: 'PO_ALARM',
      isEmergencyAlarm: true,
      billNumber: formattedPo,
      poNumber: formattedPo,
      supplierName: displaySupplier,
      vendorName: displaySupplier,
      amount: displayAmount,
      receivedTime: displayTime,
      designName: designName || '',
      materialDetails: items ? (typeof items === 'string' ? items : JSON.stringify(items)) : 'Materials Inward',
      source: triggeredBy,
      assignedSupervisor: assignedSupervisor || '',
      title,
      message: body,
      status: 'SENT',
      timestamp: nowIso,
    };

    emitToUsers(targetUserIds, 'po:alarm', socketPayload);
    emitToUsers(targetUserIds, 'new_notification', socketPayload);
    console.log(`[POAlarmService] 📡 Sent targeted PO Alarm for ${formattedPo} (SENT) to user IDs: [${targetUserIds.join(', ')}]`);
  }

  logAudit({
    eventType: 'PO_ALARM_SENT',
    lotNumber: formattedPo,
    details: { eventId, poNumber: formattedPo, supplier: displaySupplier, amount: displayAmount },
  }).catch(() => {});

  return {
    success: true,
    eventId,
    poNumber: formattedPo,
    recipientCount: targetUserIds.length,
    supplier: displaySupplier,
    amount: displayAmount,
    receivedTime: displayTime,
  };
}

/**
 * Mark Alert as DELIVERED (Confirmed by recipient device)
 */
async function markPoAlarmDelivered(eventId, poNumber) {
  if (!eventId && !poNumber) return false;

  try {
    let queryWhere = '';
    let params = [];

    if (eventId) {
      queryWhere = 'event_id = ?';
      params = [eventId];
    } else {
      queryWhere = 'po_number = ? AND status = "SENT"';
      params = [poNumber];
    }

    const [res] = await pool.query(
      `UPDATE po_alarm_events_app 
       SET status = 'DELIVERED', delivered_at = NOW()
       WHERE ${queryWhere} AND status = 'SENT'`,
      params
    );

    if (res.affectedRows > 0) {
      console.log(`[POAlarmService] 📬 Confirmed delivery: ${poNumber || eventId} -> DELIVERED`);
    }
    return true;
  } catch (err) {
    console.warn('[POAlarmService] Error marking delivered:', err.message);
    return false;
  }
}

/**
 * STOP ALARM Functionality:
 * Immediately stops alarm sound, dismisses active notification,
 * updates status to 'STOPPED', and ensures PO is NEVER deleted or modified.
 */
async function stopPoAlarm({ eventId, poNumber, userId, userName }) {
  if (!eventId && !poNumber) return { ok: false, error: 'eventId or poNumber is required' };

  try {
    let queryWhere = '';
    let params = [];

    if (eventId) {
      queryWhere = 'event_id = ?';
      params = [userId, userName, eventId];
    } else {
      queryWhere = 'po_number = ? AND status IN ("SENT", "DELIVERED", "PENDING")';
      params = [userId, userName, poNumber];
    }

    const [result] = await pool.query(
      `UPDATE po_alarm_events_app 
       SET status = 'STOPPED',
           stopped_by_user_id = ?,
           stopped_by_user_name = ?,
           stopped_at = NOW()
       WHERE ${queryWhere}`,
      params
    );

    // Broadcast STOP signal to all connected mobile devices
    const io = getIO();
    if (io) {
      io.emit('po:alarm_stopped', {
        eventId,
        poNumber,
        stoppedByUserId: userId,
        stoppedByName: userName || 'User',
        timestamp: new Date().toISOString(),
      });
      console.log(`[POAlarmService] 🛑 Broadcasted ALARM STOPPED for ${poNumber || eventId} by ${userName}`);
    }

    logAudit({
      eventType: 'PO_ALARM_STOPPED',
      lotNumber: poNumber,
      userId,
      userName,
      details: { eventId, poNumber },
    }).catch(() => {});

    return { ok: true, stopped: true, eventId, poNumber, status: 'STOPPED' };
  } catch (err) {
    console.error('[POAlarmService] Error stopping alarm:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * OPEN PO Functionality:
 * Marks PO alarm as OPENED by user
 */
async function openPoAlarm({ eventId, poNumber, userId, userName }) {
  try {
    let queryWhere = '';
    let params = [];

    if (eventId) {
      queryWhere = 'event_id = ?';
      params = [userId, eventId];
    } else {
      queryWhere = 'po_number = ? AND status IN ("SENT", "DELIVERED", "STOPPED", "PENDING")';
      params = [userId, poNumber];
    }

    await pool.query(
      `UPDATE po_alarm_events_app 
       SET status = 'OPENED', opened_by_user_id = ?, opened_at = NOW()
       WHERE ${queryWhere}`,
      params
    );

    logAudit({
      eventType: 'PO_ALARM_OPENED',
      lotNumber: poNumber,
      userId,
      userName,
      details: { eventId, poNumber },
    }).catch(() => {});

    return { ok: true, status: 'OPENED' };
  } catch (err) {
    console.warn('[POAlarmService] Error recording open action:', err.message);
    return { ok: false };
  }
}

/**
 * Retrieve pending unexpired alarms for offline reconnection
 */
async function getPendingAlarmsForUser(userId) {
  try {
    const [rows] = await pool.query(
      `SELECT event_id AS eventId, po_number AS poNumber, supplier_name AS supplierName,
              amount, received_at AS receivedAt, status, expires_at AS expiresAt
       FROM po_alarm_events_app
       WHERE status IN ('SENT', 'DELIVERED', 'PENDING') AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY id DESC LIMIT 5`
    );
    return rows;
  } catch (err) {
    console.warn('[POAlarmService] Error fetching pending alarms:', err.message);
    return [];
  }
}

/**
 * Get User Notification & Alarm Settings
 */
async function getUserNotificationSettings(userId) {
  const defaults = {
    userId,
    poAlertsEnabled: true,
    alarmSoundEnabled: true,
    alarmTone: 'alarm_siren',
    alarmDurationSec: 30,
    repeatAlarm: true,
    repeatIntervalSec: 60,
  };

  try {
    const [rows] = await pool.query(
      `SELECT po_alerts_enabled, alarm_sound_enabled, alarm_tone, alarm_duration_sec, repeat_alarm, repeat_interval_sec
       FROM user_notification_settings_app
       WHERE user_id = ?`,
      [userId]
    );

    if (!rows.length) return defaults;

    const r = rows[0];
    return {
      userId,
      poAlertsEnabled: Boolean(r.po_alerts_enabled),
      alarmSoundEnabled: Boolean(r.alarm_sound_enabled),
      alarmTone: r.alarm_tone || 'alarm_siren',
      alarmDurationSec: Number(r.alarm_duration_sec) || 30,
      repeatAlarm: Boolean(r.repeat_alarm),
      repeatIntervalSec: Number(r.repeat_interval_sec) || 60,
    };
  } catch (err) {
    console.warn('[POAlarmService] Error getting settings:', err.message);
    return defaults;
  }
}

/**
 * Update User Notification & Alarm Settings
 */
async function updateUserNotificationSettings(userId, settings = {}) {
  const poAlerts = settings.poAlertsEnabled !== undefined ? (settings.poAlertsEnabled ? 1 : 0) : 1;
  const soundEnabled = settings.alarmSoundEnabled !== undefined ? (settings.alarmSoundEnabled ? 1 : 0) : 1;
  const tone = settings.alarmTone || 'alarm_siren';
  const duration = Math.min(Math.max(parseInt(settings.alarmDurationSec) || 30, 5), 180);
  const repeat = settings.repeatAlarm !== undefined ? (settings.repeatAlarm ? 1 : 0) : 1;
  const repeatInterval = Math.min(Math.max(parseInt(settings.repeatIntervalSec) || 60, 15), 300);

  try {
    await pool.query(
      `INSERT INTO user_notification_settings_app 
         (user_id, po_alerts_enabled, alarm_sound_enabled, alarm_tone, alarm_duration_sec, repeat_alarm, repeat_interval_sec)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         po_alerts_enabled = VALUES(po_alerts_enabled),
         alarm_sound_enabled = VALUES(alarm_sound_enabled),
         alarm_tone = VALUES(alarm_tone),
         alarm_duration_sec = VALUES(alarm_duration_sec),
         repeat_alarm = VALUES(repeat_alarm),
         repeat_interval_sec = VALUES(repeat_interval_sec),
         updated_at = NOW()`,
      [userId, poAlerts, soundEnabled, tone, duration, repeat, repeatInterval]
    );

    return {
      userId,
      poAlertsEnabled: Boolean(poAlerts),
      alarmSoundEnabled: Boolean(soundEnabled),
      alarmTone: tone,
      alarmDurationSec: duration,
      repeatAlarm: Boolean(repeat),
      repeatIntervalSec: repeatInterval,
    };
  } catch (err) {
    console.error('[POAlarmService] Error updating settings:', err.message);
    throw err;
  }
}

/**
 * Send Test PO Notification & Alarm to a specific user
 */
async function sendTestPoAlarm(userId, userName = 'Tester') {
  const testPoNumber = `PO-TEST-${Math.floor(1000 + Math.random() * 9000)}`;
  const displaySupplier = 'ABC Traders (Test Supplier)';
  const displayAmount = '₹25,000';
  const displayTime = formatTimeDisplay(new Date());
  const eventId = `EVT-TEST-ALARM-${Date.now()}`;
  const nowIso = new Date().toISOString();

  const title = '🚨 NEW PURCHASE ORDER RECEIVED!';
  const body = `PO Number: ${testPoNumber}\nSupplier: ${displaySupplier}\nAmount: ${displayAmount}\nTime: ${displayTime}`;

  const payload = {
    type: 'PO_ALARM',
    eventType: 'PO_ALARM',
    eventId,
    poNumber: testPoNumber,
    supplier: displaySupplier,
    vendorName: displaySupplier,
    amount: displayAmount,
    receivedTime: displayTime,
    timestamp: nowIso,
    channelId: 'po_alarm_channel',
    isEmergencyAlarm: 'true',
    actions: JSON.stringify([
      { id: 'OPEN_PO', title: 'OPEN PO' },
      { id: 'STOP_ALARM', title: 'STOP' },
    ]),
  };

  // Record test alarm
  try {
    await pool.query(
      `INSERT INTO po_alarm_events_app 
         (event_id, po_number, supplier_name, amount, recipient_user_id, received_at, sent_at, expires_at, status)
       VALUES (?, ?, ?, ?, ?, NOW(), NOW(), DATE_ADD(NOW(), INTERVAL 60 SECOND), 'SENT')`,
      [eventId, testPoNumber, displaySupplier, displayAmount, userId]
    );
  } catch {}

  // 1. Send direct FCM push to user
  const pushRes = await sendFcmPush([userId], title, body, payload);

  // 2. Broadcast via Socket.IO directly to user
  const io = getIO();
  if (io) {
    io.emit('po:alarm', {
      eventId,
      eventType: 'PO_ALARM',
      isEmergencyAlarm: true,
      billNumber: testPoNumber,
      poNumber: testPoNumber,
      supplierName: displaySupplier,
      vendorName: displaySupplier,
      amount: displayAmount,
      receivedTime: displayTime,
      designName: 'Sample Goods',
      materialDetails: 'Industrial Test Materials (500 PCS)',
      source: 'Test Trigger',
      title,
      message: body,
      status: 'SENT',
      timestamp: nowIso,
    });
  }

  return {
    ok: true,
    eventId,
    testPoNumber,
    supplier: displaySupplier,
    amount: displayAmount,
    receivedTime: displayTime,
    pushResult: pushRes,
  };
}

module.exports = {
  triggerPoAlarm,
  stopPoAlarm,
  openPoAlarm,
  markPoAlarmDelivered,
  getPendingAlarmsForUser,
  checkAndExpireAlarms,
  getUserNotificationSettings,
  updateUserNotificationSettings,
  sendTestPoAlarm,
  formatPoAmount,
  formatTimeDisplay,
};
