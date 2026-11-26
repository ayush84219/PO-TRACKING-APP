const router = require('express').Router();
const pool = require('../db/pool');
const { wrap } = require('../middleware/errors');
const { authenticate, requireRole } = require('../middleware/auth');
const { sendPush } = require('../services/push');
const {
  enqueueNotification,
  acknowledgeLot,
  acknowledgeById,
  processPendingQueue,
  checkAndTriggerEscalations,
} = require('../services/notificationQueue');
const { logAudit } = require('../services/auditLogger');
const { notifyStatusChange, sendGateScanNotification, getIO } = require('../services/socketService');
const S = require('../validators/schemas');
const { isFirebaseReady } = require('../services/fcmPush');
const { resolveSupervisorUsers } = require('../services/userDirectory');
const { binarySearchService } = require('../services/binarySearchService');

/**
 * Public health & FCM readiness diagnostic endpoint
 */
router.get('/fcm-status', (req, res) => {
  res.json({
    ok: true,
    firebaseReady: isFirebaseReady(),
    serverTime: new Date().toISOString(),
  });
});

router.use(authenticate);

/**
 * GET /notifications
 * Fetches user notifications + unread count
 */
router.get('/', wrap(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const [items] = await pool.query(
    `SELECT id, title, message, lot_number AS lotNumber, is_read AS isRead, created_at AS createdAt
     FROM notifications_app WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    [req.user.id, limit]
  );
  const [[c]] = await pool.query(
    'SELECT COUNT(*) AS unread FROM notifications_app WHERE user_id = ? AND is_read = 0',
    [req.user.id]
  );
  res.json({
    items: items.map(i => ({ ...i, isRead: !!i.isRead })),
    unread: +c.unread,
  });
}));

/**
 * POST /notifications
 * Post a notification manually / via workflow
 */
router.post('/', wrap(async (req, res) => {
  const { role, title, message, lotNumber } = req.body || {};
  if (!title || !message) {
    return res.status(400).json({ error: 'Title and message are required' });
  }

  let targetUsers = [];
  if (role) {
    const [users] = await pool.query(
      'SELECT id, role FROM user_app WHERE (role = ? OR base_role = ?) AND is_active = 1',
      [role, role]
    );
    targetUsers = users;
  }
  if (!targetUsers.length) {
    const [all] = await pool.query('SELECT id, role FROM user_app WHERE is_active = 1');
    targetUsers = all;
  }

  for (const u of targetUsers) {
    await enqueueNotification({
      lotNumber,
      userId: u.id,
      targetRole: u.role,
      title,
      message,
      payload: { lotNumber, senderId: req.user.id, senderName: req.user.name },
    });
  }

  const targetIds = targetUsers.map(u => u.id);
  if (targetIds.length) {
    sendPush(targetIds, title, message, { lotNumber, role, type: 'manual_alert' });
  }

  // Real-time broadcast to connected panels
  const io = getIO();
  if (io) {
    const payload = {
      eventId: `EVT-MANUAL-${Date.now()}`,
      eventType: 'MATERIAL_RECEIVED_AT_GATE',
      billNumber: lotNumber || 'MANUAL-ALERT',
      supplierName: 'Factory Gate',
      materialDetails: message,
      scannerName: req.user.name || 'Officer',
      scanTime: new Date().toISOString(),
      source: 'Gate',
      title,
      message,
      status: 'pending',
      timestamp: new Date().toISOString(),
    };
    if (role === 'supervisor') io.to('supervisor-notifications').emit('new_notification', payload);
    else if (role === 'store') io.to('store-notifications').emit('new_notification', payload);
    else io.emit('new_notification', payload);
  }

  res.status(201).json({ ok: true, queuedCount: targetUsers.length });
}));

/**
 * POST /notifications/notify-supervisor
 * Dispatches an urgent material arrival notification to Supervisor panels
 * Called when Gate Person clicks "Notify Supervisor Again" or triggers a resend
 */
router.post('/notify-supervisor', wrap(async (req, res) => {
  const { lotNumber, poNumber, rgpNumber, supervisorName, note, supplierName, materialName } = req.body || {};
  const docLot = (lotNumber || poNumber || rgpNumber || '').trim();
  if (!docLot) {
    return res.status(400).json({ error: 'Bill Number / PO Number is required' });
  }

  const cleanLot = docLot.toUpperCase();
  const eventId = `EVT-SUP-NOTIF-${cleanLot.replace(/[^A-Za-z0-9]/g, '')}-${Date.now()}`;
  const me = req.user;

  console.log(`[Notification] 📢 Dispatching Supervisor Notification for ${cleanLot} from ${me.name} (${me.role})`);

  // 1. Resolve ONLY the specific supervisor assigned to this lot via user_details_app (never Admin, never other supervisors)
  let resolvedSupName = (supervisorName || '').trim() || null;
  if (!resolvedSupName && binarySearchService.isWarmedUp) {
    const fastDoc = binarySearchService.lookupFast(cleanLot);
    if (fastDoc && fastDoc.supervisor) resolvedSupName = String(fastDoc.supervisor).trim();
  }
  const targets = await resolveSupervisorUsers(resolvedSupName, null, { fallbackAllIfUnassigned: !resolvedSupName });

  const notifTitle = `🚨 URGENT: Material at Gate (${cleanLot})`;
  const notifMessage = `NEW MATERIAL ARRIVED AT GATE: Bill ${cleanLot}. Please verify and collect.`;

  // 2. Enqueue notification in database for persistence & offline sync
  for (const t of targets) {
    await enqueueNotification({
      lotNumber: cleanLot,
      eventId,
      userId: t.id,
      targetRole: t.role,
      title: notifTitle,
      message: notifMessage,
      payload: {
        eventId,
        lotNumber: cleanLot,
        supplierName: supplierName || 'Supplier',
        materialDetails: materialName || 'Material Lot',
        scannerName: me.name || 'Gate Officer',
        type: 'MATERIAL_RECEIVED_AT_GATE',
        isReminder: true,
      },
    }).catch(() => {});
  }

  // 3. Update scans_app for this bill with the new eventId & pending delivery status
  await pool.query(
    `UPDATE scans_app 
     SET event_id = ?, delivery_status = 'pending', delivered_at = NULL, acknowledged_at = NULL, acknowledged_by_name = NULL 
     WHERE lot_number = ? OR lot_number = ?`,
    [eventId, cleanLot, cleanLot.replace(/^(PO-|RGP-)/, '')]
  ).catch(() => {});

  // 4. Trigger Real-time Socket.IO notification ONLY to the targeted supervisor user IDs
  const targetUserIds = targets.map(t => t.id);
  const notifPayload = {
    eventId,
    eventType: 'MATERIAL_RECEIVED_AT_GATE',
    billNumber: cleanLot,
    supplierName: supplierName || 'Supplier',
    materialDetails: materialName || `Material Lot ${cleanLot}`,
    scannerName: me.name || 'Gate Officer',
    scanTime: new Date().toISOString(),
    billId: cleanLot,
    source: 'Gate',
    title: 'NEW MATERIAL ARRIVED AT GATE',
    message: notifMessage,
    status: 'pending', // Single grey tick ✓
    timestamp: new Date().toISOString(),
    isReminder: true,
    isEmergencyAlarm: true,
    targetUserIds,
    assignedSupervisor: resolvedSupName,
  };

  if (targetUserIds.length > 0) {
    sendGateScanNotification(notifPayload);
    sendPush(targetUserIds, notifTitle, notifMessage, notifPayload);
  }

  res.json({
    ok: true,
    eventId,
    message: `Supervisor alert dispatched to ${targets.length} targeted recipient(s)`,
    recipientsCount: targets.length,
  });
}));

/**
 * POST /notifications/sync
 * Offline synchronization endpoint for mobile clients:
 * - Reconciles offline scans and acks collected while device was disconnected
 * - Delivers missed notifications since device's lastSyncTimestamp
 */
router.post('/sync', wrap(async (req, res) => {
  const { lastSyncTimestamp, offlineScans = [], offlineAcks = [] } = req.body || {};
  const me = req.user;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  const syncedScans = [];
  const syncedAcks = [];

  // 1. Process offline acknowledgments
  for (const ack of offlineAcks) {
    try {
      if (ack.lotNumber) {
        const affected = await acknowledgeLot(ack.lotNumber, me.id, me.name, me.role);
        syncedAcks.push({ lotNumber: ack.lotNumber, status: 'success', affectedRows: affected });
      } else if (ack.queueId) {
        const ok = await acknowledgeById(ack.queueId, me.id, me.name, me.role);
        syncedAcks.push({ queueId: ack.queueId, status: ok ? 'success' : 'not_found' });
      }
    } catch (err) {
      syncedAcks.push({ lotNumber: ack.lotNumber, status: 'error', error: err.message });
    }
  }

  // 2. Process offline scans safely
  for (const scanItem of offlineScans) {
    const clientId = scanItem.clientId || scanItem.id || `temp-${Math.random()}`;
    const conn = await pool.getConnection();

    try {
      const parsed = S.scan.safeParse(scanItem);
      if (!parsed.success) {
        syncedScans.push({ clientId, status: 'invalid_data', error: parsed.error.issues[0].message });
        conn.release();
        continue;
      }

      const { lotNumber, materialName, status, note } = parsed.data;
      const isGateScan = (me.role === 'gate' || me.base_role === 'gate' || (note && note.includes('[GATE ENTRY]')) || status === 'pending');
      const isSupervisorScan = (me.role === 'supervisor' || me.base_role === 'supervisor' || (note && note.includes('[SUPERVISOR PICKUP]')) || status === 'completed');

      await conn.beginTransaction();

      const [mats] = await conn.query('SELECT * FROM materials_app WHERE lot_number = ? FOR UPDATE', [lotNumber]);
      const material = mats[0] || null;

      // Duplicate / Gate arrival checks
      if (isSupervisorScan && (!material || material.status === 'completed')) {
        await conn.rollback();
        syncedScans.push({
          clientId,
          lotNumber,
          status: material ? 'duplicate_pickup_blocked' : 'gate_entry_required',
          message: material ? 'Already picked up' : 'Material never arrived at gate',
        });
        conn.release();
        continue;
      }

      if (isGateScan && material && material.status === 'pending') {
        await conn.rollback();
        syncedScans.push({
          clientId,
          lotNumber,
          status: 'duplicate_scan_blocked',
          message: 'Already awaiting pickup at gate',
        });
        conn.release();
        continue;
      }

      // Insert material if needed
      let materialId = material ? material.id : null;
      if (!material) {
        const [mr] = await conn.query(
          'INSERT INTO materials_app (lot_number, material_name, status) VALUES (?,?,?)',
          [lotNumber, materialName || 'Unnamed material', status]
        );
        materialId = mr.insertId;
      }

      const [sr] = await conn.query(
        'INSERT INTO scans_app (material_id, lot_number, scanned_by, status, note, created_at) VALUES (?,?,?,?,?, COALESCE(?, NOW()))',
        [materialId, lotNumber, me.id, status, note || null, scanItem.timestamp ? new Date(scanItem.timestamp) : null]
      );
      const scanId = sr.insertId;

      await conn.query(
        'UPDATE materials_app SET status = ?, scan_count = scan_count + 1, last_scanned_by = ?, last_scanned_at = NOW() WHERE id = ?',
        [status, me.id, materialId]
      );

      await conn.commit();

      await logAudit({
        eventType: 'OFFLINE_SYNC_SCAN_PROCESSED',
        lotNumber,
        userId: me.id,
        userName: me.name,
        userRole: me.role,
        ipAddress: clientIp,
        details: { scanId, clientId, isGateScan, isSupervisorScan },
      });

      if (isSupervisorScan) {
        await acknowledgeLot(lotNumber, me.id, me.name, me.role);
      }

      syncedScans.push({
        clientId,
        lotNumber,
        scanId,
        status: 'success',
        materialId,
      });
    } catch (err) {
      await conn.rollback();
      syncedScans.push({ clientId, status: 'error', error: err.message });
    } finally {
      conn.release();
    }
  }

  // 3. Fetch missed notifications since lastSyncTimestamp
  let missedWhere = 'user_id = ?';
  const missedParams = [me.id];
  if (lastSyncTimestamp) {
    missedWhere += ' AND created_at > ?';
    missedParams.push(new Date(lastSyncTimestamp));
  }

  const [missed] = await pool.query(
    `SELECT id, title, message, lot_number AS lotNumber, is_read AS isRead, created_at AS createdAt
     FROM notifications_app
     WHERE ${missedWhere}
     ORDER BY created_at DESC LIMIT 100`,
    missedParams
  );

  await logAudit({
    eventType: 'OFFLINE_SYNC_COMPLETED',
    userId: me.id,
    userName: me.name,
    userRole: me.role,
    ipAddress: clientIp,
    details: {
      syncedScansCount: syncedScans.length,
      syncedAcksCount: syncedAcks.length,
      missedNotificationsCount: missed.length,
    },
  });

  res.json({
    success: true,
    serverTimestamp: new Date().toISOString(),
    syncedScans,
    syncedAcks,
    missedNotifications: missed.map(m => ({ ...m, isRead: !!m.isRead })),
  });
}));

/**
 * POST /notifications/delivered
 * Marks a notification event as delivered (receives double grey tick ✓✓)
 */
router.post('/delivered', wrap(async (req, res) => {
  const { eventId, lotNumber, queueId } = req.body || {};
  const me = req.user;

  if (eventId) {
    await pool.query(
      `UPDATE notification_queue_app 
       SET status = 'delivered', delivered_at = NOW(), attempts = attempts + 1, updated_at = NOW() 
       WHERE (event_id = ? OR lot_number = ?) AND (status = 'pending' OR status IS NULL)`,
      [eventId, lotNumber || '']
    ).catch(() => {});

    await pool.query(
      `UPDATE scans_app 
       SET delivery_status = 'delivered', delivered_at = NOW() 
       WHERE (event_id = ? OR lot_number = ?) AND delivery_status = 'pending'`,
      [eventId, lotNumber || '']
    ).catch(() => {});
  } else if (lotNumber) {
    await pool.query(
      `UPDATE scans_app 
       SET delivery_status = 'delivered', delivered_at = NOW() 
       WHERE lot_number = ? AND delivery_status = 'pending'`,
      [lotNumber]
    ).catch(() => {});
  }

  notifyStatusChange({
    eventId,
    lotNumber,
    queueId,
    status: 'delivered', // Double Grey Tick ✓✓
    deliveredAt: new Date().toISOString(),
    deliveredTo: me.name,
    deliveredToRole: me.role,
  });

  res.json({ ok: true, status: 'delivered' });
}));

/**
 * POST /notifications/acknowledge
 * Acknowledges notification event (user clicks STOP / ACKNOWLEDGE after min 10s timer)
 * Triggers double blue tick ✓✓ in sender panel!
 */
router.post('/acknowledge', wrap(async (req, res) => {
  const { eventId, lotNumber, queueId } = req.body || {};
  const me = req.user;
  const ackTimestamp = new Date();
  const rawNum = String(lotNumber || '').trim();
  const cleanDigits = rawNum.replace(/[^0-9]/g, '');
  const cleanPo = cleanDigits ? `PO-${cleanDigits}` : rawNum;
  const cleanRgp = cleanDigits ? `RGP-${cleanDigits}` : rawNum;
  const lotVariants = Array.from(new Set([rawNum, cleanPo, cleanRgp, cleanDigits].filter(Boolean)));

  if (lotVariants.length > 0 || eventId) {
    const matchParams = [];
    let whereClause = '';
    if (eventId) {
      whereClause += 'event_id = ?';
      matchParams.push(eventId);
    }
    if (lotVariants.length > 0) {
      if (whereClause) whereClause += ' OR ';
      whereClause += `lot_number IN (${lotVariants.map(() => '?').join(',')})`;
      matchParams.push(...lotVariants);
    }

    await pool.query(
      `UPDATE notification_queue_app 
       SET status = 'acknowledged', acknowledged_at = NOW(), acknowledged_by = ?, acknowledged_by_name = ?, updated_at = NOW() 
       WHERE ${whereClause}`,
      [me.id, me.name, ...matchParams]
    ).catch(() => {});

    await pool.query(
      `UPDATE scans_app 
       SET delivery_status = 'acknowledged', acknowledged_at = NOW(), acknowledged_by_name = ? 
       WHERE ${whereClause}`,
      [me.name, ...matchParams]
    ).catch(() => {});
  } else if (queueId) {
    await acknowledgeById(queueId, me.id, me.name, me.role);
  }

  if (lotVariants.length > 0) {
    await pool.query(
      `UPDATE notifications_app SET is_read = 1 WHERE lot_number IN (${lotVariants.map(() => '?').join(',')})`,
      lotVariants
    ).catch(() => {});
  }

  const isRgp = rawNum.toUpperCase().includes('RGP');
  const preferredLot = isRgp ? cleanRgp : (cleanDigits ? cleanPo : rawNum);

  notifyStatusChange({
    eventId,
    lotNumber: preferredLot,
    cleanPo,
    cleanRgp,
    cleanDigits,
    queueId,
    status: 'acknowledged', // Double Blue Tick ✓✓
    acknowledgedAt: ackTimestamp.toISOString(),
    acknowledgedBy: me.name,
    acknowledgedById: me.id,
    acknowledgedByRole: me.role,
  });

  res.json({ ok: true, status: 'acknowledged', acknowledgedAt: ackTimestamp.toISOString() });
}));

/**
 * GET /notifications/missed
 * Fetches unacknowledged or recent notifications for reconnecting mobile clients
 */
router.get('/missed', wrap(async (req, res) => {
  const me = req.user;
  const { lastSyncTime } = req.query;

  const params = [me.id, me.role, me.role];
  let query = `
    SELECT nq.id, nq.event_id AS eventId, nq.lot_number AS billNumber,
           nq.title, nq.message, nq.payload, nq.status, nq.created_at AS createdAt,
           nq.acknowledged_at AS acknowledgedAt, nq.acknowledged_by_name AS acknowledgedByName
    FROM notification_queue_app nq
    WHERE (nq.user_id = ? OR nq.target_role = ? OR ? = 'admin')
  `;

  if (lastSyncTime) {
    query += ` AND nq.created_at > ?`;
    params.push(new Date(lastSyncTime));
  } else {
    query += ` AND nq.acknowledged_at IS NULL AND nq.created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`;
  }

  query += ` ORDER BY nq.id DESC LIMIT 30`;

  const [items] = await pool.query(query, params);

  const missedList = items.map((row) => {
    let parsedPayload = {};
    try {
      parsedPayload = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload || {});
    } catch {
      parsedPayload = {};
    }
    return {
      eventId: row.eventId || `EVT-MISSED-${row.id}`,
      eventType: parsedPayload.type || 'MATERIAL_NOTIFICATION',
      billNumber: row.billNumber,
      supplierName: parsedPayload.supplierName || 'Supplier',
      materialDetails: parsedPayload.materialDetails || parsedPayload.materialName || 'Material',
      scannerName: parsedPayload.scannerName || parsedPayload.gateOfficerName || 'Officer',
      scanTime: row.createdAt,
      billId: parsedPayload.scanId || row.id,
      source: parsedPayload.source || (row.title.includes('STORE') ? 'Store' : 'Gate'),
      title: row.title,
      message: row.message,
      status: row.status,
      isMissed: true,
    };
  });

  res.json({ items: missedList, serverTimestamp: new Date().toISOString() });
}));

/**
 * POST /notifications/:id/acknowledge
 * Acknowledges a specific notification by ID
 */
router.post('/:id/acknowledge', wrap(async (req, res) => {
  const queueId = parseInt(req.params.id);
  const ok = await acknowledgeById(queueId, req.user.id, req.user.name, req.user.role);
  if (!ok) {
    return res.status(404).json({ error: 'Notification queue item not found' });
  }
  res.json({ ok: true });
}));

/**
 * POST /notifications/ack-lot
 * Acknowledges all queue records for a lot number
 */
router.post('/ack-lot', wrap(async (req, res) => {
  const { lotNumber } = req.body || {};
  if (!lotNumber) {
    return res.status(400).json({ error: 'lotNumber is required' });
  }
  const count = await acknowledgeLot(lotNumber, req.user.id, req.user.name, req.user.role);
  res.json({ ok: true, acknowledgedCount: count });
}));

/**
 * GET /notifications/queue
 * Admin inspection endpoint for persistent MySQL notification queue
 */
router.get('/queue', requireRole('admin'), wrap(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const where = ['1=1'];
  const params = [];

  if (req.query.status) {
    where.push('status = ?');
    params.push(req.query.status);
  }
  if (req.query.lotNumber) {
    where.push('lot_number = ?');
    params.push(req.query.lotNumber);
  }

  const [items] = await pool.query(
    `SELECT nq.*, u.name AS userName, u.email AS userEmail
     FROM notification_queue_app nq
     LEFT JOIN user_app u ON u.id = nq.user_id
     WHERE ${where.join(' AND ')}
     ORDER BY nq.created_at DESC, nq.id DESC
     LIMIT ?`,
    [...params, limit]
  );

  const [[counts]] = await pool.query(
    `SELECT
       COUNT(*) AS total,
       SUM(status = 'pending') AS pending,
       SUM(status = 'delivered') AS delivered,
       SUM(status = 'acknowledged') AS acknowledged,
       SUM(status = 'escalated') AS escalated,
       SUM(status = 'failed') AS failed
     FROM notification_queue_app`
  );

  res.json({ items, counts });
}));

/**
 * POST /notifications/trigger-escalation-check
 * Trigger SLA escalation check manually or for tests
 */
router.post('/trigger-escalation-check', wrap(async (req, res) => {
  const slaMinutes = typeof req.body.slaMinutes === 'number' ? req.body.slaMinutes : 15;
  const result = await checkAndTriggerEscalations(slaMinutes);
  res.json(result);
}));

/**
 * POST /notifications/trigger-retry
 * Trigger retry worker tick manually or for tests
 */
router.post('/trigger-retry', wrap(async (req, res) => {
  const result = await processPendingQueue(req.body.batchSize || 20);
  res.json(result);
}));

router.delete('/clear-all', wrap(async (req, res) => {
  const [result] = await pool.query('DELETE FROM notifications_app WHERE user_id = ?', [req.user.id]);
  res.json({ ok: true, deletedCount: result.affectedRows });
}));

router.delete('/:id', wrap(async (req, res) => {
  const [result] = await pool.query('DELETE FROM notifications_app WHERE id = ? AND user_id = ?', [parseInt(req.params.id), req.user.id]);
  res.json({ ok: true, deleted: result.affectedRows > 0 });
}));

router.patch('/read-all', wrap(async (req, res) => {
  await pool.query('UPDATE notifications_app SET is_read = 1 WHERE user_id = ?', [req.user.id]);
  res.json({ ok: true });
}));

router.patch('/:id/read', wrap(async (req, res) => {
  await pool.query('UPDATE notifications_app SET is_read = 1 WHERE id = ? AND user_id = ?', [parseInt(req.params.id), req.user.id]);
  res.json({ ok: true });
}));

/**
 * POST /notifications/fcm-token
 * Register device push token for authenticated user
 */
router.post('/fcm-token', wrap(async (req, res) => {
  const { token, platform, deviceName } = req.body || {};
  if (!token) return res.status(400).json({ error: 'Token is required' });
  const { registerFcmToken } = require('../services/fcmPush');
  const ok = await registerFcmToken(req.user.id, token, platform || 'android', deviceName);
  res.json({ ok, token });
}));

// ============================================================================
// Smart PO Alert & Alarm Notification Endpoints
// ============================================================================
const {
  getUserNotificationSettings,
  updateUserNotificationSettings,
  stopPoAlarm,
  openPoAlarm,
  markPoAlarmDelivered,
  getPendingAlarmsForUser,
  sendTestPoAlarm,
  triggerPoAlarm,
} = require('../services/poAlarmService');

/**
 * POST /notifications/alarm/delivered
 * Marks PO alert status as DELIVERED upon device confirmation
 */
router.post('/alarm/delivered', wrap(async (req, res) => {
  const { eventId, poNumber } = req.body || {};
  const ok = await markPoAlarmDelivered(eventId, poNumber);
  res.json({ ok, status: 'DELIVERED' });
}));

/**
 * GET /notifications/alarm/pending
 * Retrieve pending unexpired PO alarms for offline user reconnection
 */
router.get('/alarm/pending', wrap(async (req, res) => {
  const items = await getPendingAlarmsForUser(req.user.id);
  res.json({ ok: true, items });
}));

/**
 * GET /notifications/settings
 * Fetch user's notification & alarm configuration
 */
router.get('/settings', wrap(async (req, res) => {
  const settings = await getUserNotificationSettings(req.user.id);
  res.json({ ok: true, settings });
}));

/**
 * PUT /notifications/settings
 * Update user's notification & alarm configuration
 */
router.put('/settings', wrap(async (req, res) => {
  const updated = await updateUserNotificationSettings(req.user.id, req.body || {});
  res.json({ ok: true, settings: updated });
}));

/**
 * POST /notifications/alarm/stop
 * STOP ALARM action handler: immediately silences alarm and records stopped state
 */
router.post('/alarm/stop', wrap(async (req, res) => {
  const { eventId, poNumber } = req.body || {};
  const result = await stopPoAlarm({
    eventId,
    poNumber,
    userId: req.user.id,
    userName: req.user.name,
  });
  res.json(result);
}));

/**
 * POST /notifications/alarm/open
 * OPEN PO action handler: records user opened the PO from alert
 */
router.post('/alarm/open', wrap(async (req, res) => {
  const { eventId, poNumber } = req.body || {};
  const result = await openPoAlarm({
    eventId,
    poNumber,
    userId: req.user.id,
    userName: req.user.name,
  });
  res.json(result);
}));

/**
 * POST /notifications/alarm/test
 * Triggers a live test PO alert on user's phone for verification
 */
router.post('/alarm/test', wrap(async (req, res) => {
  const result = await sendTestPoAlarm(req.user.id, req.user.name);
  res.json(result);
}));

/**
 * POST /notifications/alarm/trigger
 * Manually trigger PO alarm (Admin / testing)
 */
router.post('/alarm/trigger', wrap(async (req, res) => {
  const { poNumber, vendorName, amount, items, designName } = req.body || {};
  if (!poNumber) return res.status(400).json({ error: 'poNumber is required' });

  const result = await triggerPoAlarm({
    poNumber,
    vendorName,
    amount,
    items,
    designName,
    triggeredBy: `${req.user.name} (${req.user.role})`,
  });
  res.json(result);
}));

module.exports = router;
