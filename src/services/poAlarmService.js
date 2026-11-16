const pool = require('../db/pool');
const { sendFcmPush } = require('./fcmPush');
const { getIO } = require('./socketService');
const { logAudit } = require('./auditLogger');

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
 * Triggers a Smart PO Alert and Alarm Notification
 */
async function triggerPoAlarm({
  poNumber,
  vendorName = 'Supplier / Vendor',
  amount = null,
  orderDate = null,
  items = null,
  designName = null,
  triggeredBy = 'System / ERP',
}) {
  if (!poNumber) return null;

  const rawPo = String(poNumber).trim();
  const cleanDigits = rawPo.replace(/[^0-9]/g, '') || rawPo;
  const formattedPo = rawPo.toUpperCase().startsWith('PO-') ? rawPo.toUpperCase() : `PO-${cleanDigits}`;
  const displaySupplier = vendorName || 'ABC Traders';
  const displayAmount = formatPoAmount(amount);
  const displayTime = formatTimeDisplay(orderDate);
  const nowIso = new Date().toISOString();

  // 1. Idempotency Check: Prevent duplicate active alarms for the exact same PO
  try {
    const [existing] = await pool.query(
      `SELECT id, event_id, status FROM po_alarm_events_app 
       WHERE po_number = ? AND status = 'active'
       ORDER BY id DESC LIMIT 1`,
      [formattedPo]
    );

    if (existing.length > 0) {
      console.log(`[POAlarmService] ⚠️ Active alarm already running for ${formattedPo} (${existing[0].event_id}). Skipping duplicate.`);
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

  // 2. Persist alarm event in database
  try {
    await pool.query(
      `INSERT INTO po_alarm_events_app (event_id, po_number, supplier_name, amount, received_at, status)
       VALUES (?, ?, ?, ?, NOW(), 'active')`,
      [eventId, formattedPo, displaySupplier, displayAmount]
    );
  } catch (err) {
    console.error('[POAlarmService] Error recording alarm event:', err.message);
  }

  // 3. Query all target users (Gate, Store, Supervisor, Admin) and filter by notification settings
  let targetUsers = [];
  try {
    const [users] = await pool.query(
      `SELECT u.id, u.name, u.role, u.email,
              COALESCE(s.po_alerts_enabled, 1) AS po_alerts_enabled,
              COALESCE(s.alarm_sound_enabled, 1) AS alarm_sound_enabled,
              COALESCE(s.alarm_tone, 'alarm_siren') AS alarm_tone,
              COALESCE(s.alarm_duration_sec, 30) AS alarm_duration_sec
       FROM user_app u
       LEFT JOIN user_notification_settings_app s ON s.user_id = u.id
       WHERE u.is_active = 1 AND (
         u.role IN ('gate', 'store', 'supervisor', 'admin') OR
         u.base_role IN ('gate', 'store', 'supervisor', 'admin')
       )`
    );

    // Keep users who haven't disabled PO alerts
    targetUsers = users.filter((u) => u.po_alerts_enabled !== 0);
  } catch (err) {
    console.error('[POAlarmService] Error querying target users:', err.message);
  }

  const targetUserIds = targetUsers.map((u) => u.id);

  // 4. Construct Uber/Rapido-style Notification Details
  const title = '🚨 NEW PURCHASE ORDER RECEIVED!';
  const body = `PO Number: ${formattedPo}\nSupplier: ${displaySupplier}\nAmount: ${displayAmount}\nTime: ${displayTime}`;

  const notificationData = {
    type: 'PO_ALARM',
    eventType: 'PO_ALARM',
    eventId,
    poNumber: formattedPo,
    supplier: displaySupplier,
    vendorName: displaySupplier,
    amount: displayAmount,
    receivedTime: displayTime,
    timestamp: nowIso,
    channelId: 'po_alarm_channel',
    isEmergencyAlarm: 'true',
    actions: JSON.stringify([
      { id: 'OPEN_PO', title: 'OPEN PO' },
      { id: 'STOP_ALARM', title: 'STOP ALARM' },
    ]),
  };

  // 5. Send High-Priority FCM Push Notification (works outside app, locked screen, background, killed state)
  if (targetUserIds.length > 0) {
    sendFcmPush(targetUserIds, title, body, notificationData).catch((err) => {
      console.error('[POAlarmService] Error dispatching push:', err.message);
    });
  }

  // 6. Broadcast Real-Time Socket.IO Event for In-App Alert Experience
  const io = getIO();
  if (io) {
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
      title,
      message: body,
      status: 'active',
      timestamp: nowIso,
    };

    io.emit('po:alarm', socketPayload);
    io.emit('new_notification', socketPayload);
    console.log(`[POAlarmService] 📡 Broadcasted live PO Alarm for ${formattedPo} to ${targetUserIds.length} users.`);
  }

  // Also log audit trail
  logAudit({
    eventType: 'PO_ALARM_TRIGGERED',
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
 * STOP ALARM Functionality:
 * Immediately stops alarm sound, dismisses active notification,
 * updates backend status to 'stopped', and ensures PO is NEVER deleted or modified.
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
      queryWhere = 'po_number = ? AND status = "active"';
      params = [userId, userName, poNumber];
    }

    const [result] = await pool.query(
      `UPDATE po_alarm_events_app 
       SET status = 'stopped',
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

    return { ok: true, stopped: true, eventId, poNumber };
  } catch (err) {
    console.error('[POAlarmService] Error stopping alarm:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * OPEN PO Functionality:
 * Marks PO alarm as opened by user
 */
async function openPoAlarm({ eventId, poNumber, userId, userName }) {
  try {
    if (eventId) {
      await pool.query(
        `UPDATE po_alarm_events_app 
         SET status = 'opened', opened_by_user_id = ?, opened_at = NOW()
         WHERE event_id = ?`,
        [userId, eventId]
      );
    } else if (poNumber) {
      await pool.query(
        `UPDATE po_alarm_events_app 
         SET status = 'opened', opened_by_user_id = ?, opened_at = NOW()
         WHERE po_number = ? AND status IN ('active', 'stopped')
         ORDER BY id DESC LIMIT 1`,
        [userId, poNumber]
      );
    }

    logAudit({
      eventType: 'PO_ALARM_OPENED',
      lotNumber: poNumber,
      userId,
      userName,
      details: { eventId, poNumber },
    }).catch(() => {});

    return { ok: true };
  } catch (err) {
    console.warn('[POAlarmService] Error recording open action:', err.message);
    return { ok: false };
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
      { id: 'STOP_ALARM', title: 'STOP ALARM' },
    ]),
  };

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
      status: 'active',
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
  getUserNotificationSettings,
  updateUserNotificationSettings,
  sendTestPoAlarm,
  formatPoAmount,
  formatTimeDisplay,
};
