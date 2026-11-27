const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { accessSecret } = require('../config/env');

let io = null;

/**
 * Initialize Socket.IO with HTTP Server
 */
function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
    pingTimeout: 30000,
    pingInterval: 10000,
    allowEIO3: true,
  });

  // JWT Authentication Middleware for Socket.IO Handshake
  io.use(async (socket, next) => {
    try {
      const auth = socket.handshake.auth || {};
      const headers = socket.handshake.headers || {};
      const rawToken = auth.token || (headers.authorization && headers.authorization.startsWith('Bearer ') ? headers.authorization.slice(7) : null);

      if (!rawToken) {
        // Guest connection (e.g. app just launched before login)
        socket.user = { id: 0, name: 'Guest', role: 'guest' };
        return next();
      }

      // Support demo and offline tokens
      if (rawToken.startsWith('demo_') || rawToken.startsWith('offline_token_')) {
        let role = 'supervisor';
        if (rawToken.includes('gate')) role = 'gate';
        else if (rawToken.includes('store')) role = 'store';
        else if (rawToken.includes('admin')) role = 'admin';
        socket.user = { id: 1, name: `${role.toUpperCase()} User`, role, baseRole: role };
        return next();
      }

      const decoded = jwt.verify(rawToken, accessSecret);
      socket.user = {
        id: decoded.id,
        name: decoded.name,
        role: decoded.role,
        baseRole: decoded.baseRole || decoded.role,
      };
      next();
    } catch (err) {
      // Connect as guest instead of throwing unhandled transport errors
      socket.user = { id: 0, name: 'Guest', role: 'guest' };
      next();
    }
  });

  function joinUserRooms(socket, user) {
    if (!user || user.role === 'guest') return;
    socket.join(`user:${user.id}`);
    const role = user.role;
    if (role === 'gate') {
      socket.join('gate-notifications');
    } else if (role === 'store') {
      socket.join('store-notifications');
    } else if (role === 'supervisor') {
      socket.join('supervisor-notifications');
    } else if (role === 'admin') {
      // Admin only joins admin-notifications & personal user room (never gate/store/supervisor alarm rooms)
      socket.join('admin-notifications');
    }
    console.log(`[Socket] 🟢 Joined rooms for: ${user.name} (Role: ${user.role}, ID: ${user.id}, Socket: ${socket.id})`);
  }

  io.on('connection', (socket) => {
    let user = socket.user || { id: 0, name: 'Guest', role: 'guest' };

    if (user.role !== 'guest') {
      joinUserRooms(socket, user);
    }

    // Dynamic Auth / Room Join Event (handles late login, role switch, or token refresh)
    socket.on('auth:identify', async (data) => {
      try {
        const { token, role, userId, name } = data || {};
        let targetUser = null;
        if (token) {
          try {
            if (token.startsWith('demo_') || token.startsWith('offline_token_')) {
              let r = role || 'supervisor';
              if (token.includes('gate')) r = 'gate';
              else if (token.includes('store')) r = 'store';
              else if (token.includes('admin')) r = 'admin';
              targetUser = { id: userId || 1, name: name || `${r.toUpperCase()} User`, role: r, baseRole: r };
            } else {
              const decoded = jwt.verify(token, accessSecret);
              targetUser = {
                id: decoded.id,
                name: decoded.name,
                role: decoded.role,
                baseRole: decoded.baseRole || decoded.role,
              };
            }
          } catch (e) {
            if (role) {
              targetUser = { id: userId || 0, name: name || 'User', role, baseRole: role };
            }
          }
        } else if (role) {
          targetUser = { id: userId || 0, name: name || 'User', role, baseRole: role };
        }

        if (targetUser) {
          user = targetUser;
          socket.user = targetUser;
          joinUserRooms(socket, targetUser);
          console.log(`[Socket] 🔑 Socket ${socket.id} dynamically identified as ${targetUser.name} (${targetUser.role})`);
        }
      } catch (err) {
        console.warn('[Socket] auth:identify error:', err.message);
      }
    });

    // Client Event: Notification Delivered (triggers Double Grey Tick ✓✓ on sender panel)
    socket.on('notification:delivered', async (data) => {
      try {
        const { eventId, lotNumber, queueId } = data || {};
        if (!eventId && !lotNumber && !queueId) return;

        console.log(`[Socket] 📬 Notification delivered to ${user.name} (${user.role}) for Event: ${eventId || lotNumber}`);

        // Update database: mark delivered_at
        if (eventId) {
          await pool.query(
            `UPDATE notification_queue_app 
             SET status = 'delivered', delivered_at = NOW(), attempts = attempts + 1, updated_at = NOW() 
             WHERE (event_id = ? OR lot_number = ?) AND (status = 'pending' OR status IS NULL)`,
            [eventId, lotNumber || '']
          ).catch(() => { });

          await pool.query(
            `UPDATE scans_app 
             SET delivery_status = 'delivered', delivered_at = NOW() 
             WHERE (event_id = ? OR lot_number = ?) AND delivery_status = 'pending'`,
            [eventId, lotNumber || '']
          ).catch(() => { });
        } else if (lotNumber) {
          await pool.query(
            `UPDATE scans_app 
             SET delivery_status = 'delivered', delivered_at = NOW() 
             WHERE lot_number = ? AND delivery_status = 'pending'`,
            [lotNumber]
          ).catch(() => { });
        }

        // Broadcast delivery status to senders (Gate, Store, Admin rooms)
        io.to('gate-notifications').to('store-notifications').to('admin-notifications').emit('notification:status_change', {
          eventId,
          lotNumber,
          queueId,
          status: 'delivered', // Double Grey Tick ✓✓
          deliveredAt: new Date().toISOString(),
          deliveredTo: user.name,
          deliveredToRole: user.role,
        });
      } catch (err) {
        console.warn('[Socket] notification:delivered handler error:', err.message);
      }
    });

    // Client Event: Notification Acknowledged (user clicks STOP / ACKNOWLEDGE after 10-30s timer)
    // Triggers Double Blue Tick ✓✓ on sender panel!
    socket.on('notification:acknowledge', async (data, callback) => {
      try {
        const { eventId, lotNumber, queueId } = data || {};
        const ackTimestamp = new Date();
        const rawNum = String(lotNumber || '').trim();
        const cleanDigits = rawNum.replace(/[^0-9]/g, '');
        const cleanPo = cleanDigits ? `PO-${cleanDigits}` : rawNum;
        const cleanRgp = cleanDigits ? `RGP-${cleanDigits}` : rawNum;
        const lotVariants = Array.from(new Set([rawNum, cleanPo, cleanRgp, cleanDigits].filter(Boolean)));

        console.log(`[Socket] 🛑 Notification ACKNOWLEDGED by ${user.name} (${user.role}) for Event: ${eventId || lotNumber}`);

        // Update database: mark status = acknowledged, acknowledged_at, acknowledged_by in both queue & scans
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
            [user.id, user.name, ...matchParams]
          ).catch((e) => console.warn('[Socket] Queue ack error:', e.message));

          await pool.query(
            `UPDATE scans_app 
             SET delivery_status = 'acknowledged', acknowledged_at = NOW(), acknowledged_by_name = ? 
             WHERE ${whereClause}`,
            [user.name, ...matchParams]
          ).catch((e) => console.warn('[Socket] Scans ack error:', e.message));
        }

        if (lotVariants.length > 0) {
          await pool.query(
            `UPDATE notifications_app SET is_read = 1 WHERE lot_number IN (${lotVariants.map(() => '?').join(',')})`,
            lotVariants
          ).catch(() => { });
        }

        const isRgp = rawNum.toUpperCase().includes('RGP');
        const preferredLot = isRgp ? cleanRgp : (cleanDigits ? cleanPo : rawNum);

        // Broadcast status update to ALL panels (Double Blue Tick ✓✓)
        const updatePayload = {
          eventId,
          lotNumber: preferredLot,
          cleanPo,
          cleanRgp,
          cleanDigits,
          queueId,
          status: 'acknowledged', // Double Blue Tick ✓✓
          acknowledgedAt: ackTimestamp.toISOString(),
          acknowledgedBy: user.name,
          acknowledgedById: user.id,
          acknowledgedByRole: user.role,
        };

        io.emit('notification:status_change', updatePayload);
        console.log(`[Socket] 📡 Broadcasted Double Blue Tick (ACKNOWLEDGED) to all panels for ${preferredLot}`);

        if (typeof callback === 'function') {
          callback({ success: true, timestamp: ackTimestamp.toISOString() });
        }
      } catch (err) {
        console.warn('[Socket] notification:acknowledge error:', err.message);
        if (typeof callback === 'function') {
          callback({ success: false, error: err.message });
        }
      }
    });

    // Client Event: Sync Missed Notifications after reconnecting
    socket.on('notification:sync_missed', async (data) => {
      try {
        const { lastSyncTime } = data || {};
        console.log(`[Socket] 🔄 Sync missed notifications requested by ${user.name} since ${lastSyncTime || 'beginning'}`);

        const params = [];
        let query = `
          SELECT nq.id, nq.event_id AS eventId, nq.lot_number AS billNumber,
                 nq.title, nq.message, nq.payload, nq.status, nq.created_at AS createdAt,
                 nq.acknowledged_at AS acknowledgedAt, nq.acknowledged_by_name AS acknowledgedByName
          FROM notification_queue_app nq
          WHERE (nq.user_id = ? OR (nq.user_id IS NULL AND nq.target_role = ?))
        `;
        params.push(user.id, user.role);

        if (lastSyncTime) {
          query += ` AND nq.created_at > ?`;
          params.push(new Date(lastSyncTime));
        } else {
          // If no timestamp, get unacknowledged items from last 24 hours
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

        socket.emit('notification:missed_batch', {
          serverTimestamp: new Date().toISOString(),
          notifications: missedList,
        });
      } catch (err) {
        console.warn('[Socket] notification:sync_missed error:', err.message);
      }
    });

    socket.on('disconnect', (reason) => {
      console.log(`[Socket] 🔴 Disconnected: ${user.name} (${socket.id}) - Reason: ${reason}`);
    });
  });

  console.log('[Socket] ✅ Socket.IO initialized with authenticated role rooms (gate, store, supervisor, admin)');
  return io;
}

/**
 * Emit a socket event ONLY to specific user IDs via their personal `user:<id>` rooms
 */
function emitToUsers(userIds, eventName, payload) {
  if (!io || !Array.isArray(userIds) || userIds.length === 0) return;
  const uniqueIds = [...new Set(userIds.filter(Boolean).map(Number))];
  for (const uid of uniqueIds) {
    io.to(`user:${uid}`).emit(eventName, payload);
  }
}

/**
 * Stage 1: Send Gate Scan Notification
 * Sent when Gate Person scans the material bill.
 * Delivery targets: Store Person & ONLY the specific assigned Supervisor (never Admin, never other Supervisors)
 */
function sendGateScanNotification({
  eventId,
  billNumber,
  lotNo = null,
  supplierName,
  materialDetails,
  scannerName,
  scannerId,
  scanTime,
  billId,
  title,
  message,
  source = 'Gate',
  isEmergencyAlarm = true,
  targetUserIds = [],
  assignedSupervisor = null,
}) {
  if (!io) return;

  const payload = {
    eventId,
    eventType: 'MATERIAL_RECEIVED_AT_GATE',
    billNumber,
    lotNo: lotNo || billNumber,
    lotNumber: lotNo || billNumber,
    supplierName: supplierName || 'Supplier',
    materialDetails: materialDetails || 'Material Lot',
    scannerName: scannerName || 'Gate Officer',
    scannerId: scannerId || null,
    assignedSupervisor: assignedSupervisor || null,
    scanTime: scanTime || new Date().toISOString(),
    billId,
    source,
    title: title || 'NEW MATERIAL ARRIVED AT GATE',
    message: message || 'NEW MATERIAL ARRIVED AT GATE. Please verify and process this bill.',
    status: 'pending', // Single grey tick ✓ initially
    isEmergencyAlarm: Boolean(isEmergencyAlarm),
    timestamp: new Date().toISOString(),
  };

  if (Array.isArray(targetUserIds) && targetUserIds.length > 0) {
    console.log(`[Socket] 📢 Emitting Stage 1 Gate Scan Alarm ${eventId} for Bill ${billNumber} ONLY to user IDs: [${targetUserIds.join(', ')}]`);
    emitToUsers(targetUserIds, 'new_notification', payload);
  } else {
    console.log(`[Socket] 📢 Emitting Stage 1 Gate Scan Alarm ${eventId} for Bill ${billNumber} to Store room only (no supervisor matched)`);
    io.to('store-notifications').emit('new_notification', payload);
  }

  return payload;
}

/**
 * Stage 2: Send Store Scan Notification
 * Sent when Store Person scans the same bill.
 * Delivery targets: ONLY the specific assigned Supervisor & Gate (never Admin, never other Supervisors)
 */
function sendStoreScanNotification({
  eventId,
  billNumber,
  lotNo = null,
  supplierName,
  materialDetails,
  scannerName,
  scannerId,
  scanTime,
  billId,
  gateOfficerName,
  title,
  message,
  isEmergencyAlarm = true,
  targetUserIds = [],
  assignedSupervisor = null,
}) {
  if (!io) return;

  const payload = {
    eventId,
    eventType: 'STORE_SCANNED',
    billNumber,
    lotNo: lotNo || billNumber,
    lotNumber: lotNo || billNumber,
    supplierName: supplierName || 'Supplier',
    materialDetails: materialDetails || 'Material Lot',
    scannerName: scannerName || 'Store Person',
    scannerId: scannerId || null,
    assignedSupervisor: assignedSupervisor || null,
    scanTime: scanTime || new Date().toISOString(),
    billId,
    source: 'Store',
    gateOfficerName,
    title: title || 'MATERIAL RECEIVED AND SCANNED BY STORE',
    message: message || 'MATERIAL RECEIVED AND SCANNED BY STORE. Please verify the bill.',
    status: 'pending', // Single grey tick ✓ initially
    isEmergencyAlarm: Boolean(isEmergencyAlarm),
    timestamp: new Date().toISOString(),
  };

  if (Array.isArray(targetUserIds) && targetUserIds.length > 0) {
    console.log(`[Socket] 📢 Emitting Stage 2 Store Scan Alarm ${eventId} for Bill ${billNumber} ONLY to user IDs: [${targetUserIds.join(', ')}]`);
    emitToUsers(targetUserIds, 'new_notification', payload);
  } else {
    console.log(`[Socket] 📢 Emitting Stage 2 Store Scan Alarm ${eventId} for Bill ${billNumber} to Gate room`);
    io.to('gate-notifications').emit('new_notification', payload);
  }

  // Also broadcast status change to gate so gate person knows parcel is now in store
  io.to('gate-notifications').emit('bill:stage_update', {
    billNumber,
    stage: 'STORE_SCANNED',
    storePersonName: scannerName,
    timestamp: scanTime,
  });

  return payload;
}

/**
 * Stage 3: Send Supervisor Scan Notification (LAST STAGE)
 * Sent when Supervisor verifies/picks up material.
 * Admin receives a clean message here (isEmergencyAlarm: false).
 */
function sendSupervisorScanNotification({
  eventId,
  billNumber,
  scannerName,
  scannerId,
  scanTime,
  isClosed,
  materialDetails,
  title,
  message,
  isEmergencyAlarm = true,
  targetUserIds = [],
  adminUserIds = [],
}) {
  if (!io) return;

  const payload = {
    eventId,
    eventType: isClosed ? 'SUPERVISOR_CLOSED' : 'SUPERVISOR_PARTIAL',
    billNumber,
    scannerName,
    scannerId: scannerId || null,
    scanTime: scanTime || new Date().toISOString(),
    isClosed,
    source: 'Supervisor',
    materialDetails: materialDetails || 'Material Lot',
    title: title || (isClosed ? 'MATERIAL VERIFIED & CLOSED' : 'MATERIAL HALF RECEIVED'),
    message: message || (isClosed
      ? `PO ${billNumber} officially CLOSED & verified by Supervisor ${scannerName}.`
      : `PO ${billNumber} partially received by Supervisor ${scannerName}.`),
    status: 'pending',
    isEmergencyAlarm: Boolean(isEmergencyAlarm),
    timestamp: new Date().toISOString(),
  };

  // Notify Gate/Store users if targeted
  if (Array.isArray(targetUserIds) && targetUserIds.length > 0) {
    console.log(`[Socket] 📢 Emitting Stage 3 Supervisor Scan to Gate/Store user IDs: [${targetUserIds.join(', ')}]`);
    emitToUsers(targetUserIds, 'new_notification', payload);
  }

  // Admin ONLY receives a clean non-alarm message in this last stage
  if (Array.isArray(adminUserIds) && adminUserIds.length > 0) {
    console.log(`[Socket] 📩 Sending Last-Stage Supervisor Receipt Message to Admin IDs: [${adminUserIds.join(', ')}] (No Alarm)`);
    emitToUsers(adminUserIds, 'new_notification', {
      ...payload,
      isEmergencyAlarm: false,
    });
  }

  io.emit('bill:stage_update', {
    billNumber,
    stage: isClosed ? 'CLOSED' : 'HALF_RECEIVED',
    supervisorName: scannerName,
    timestamp: scanTime,
  });

  return payload;
}

/**
 * Stage 4 / Generic: Send Scan Notification for Any Material Scan
 */
function sendGenericScanNotification({
  eventId,
  billNumber,
  scannerName,
  scanStage,
  materialDetails,
  title,
  message,
  source = 'Scanner',
  isEmergencyAlarm = true,
  targetUserIds = [],
}) {
  if (!io) return;

  const payload = {
    eventId,
    eventType: 'MATERIAL_SCANNED',
    billNumber,
    scannerName,
    scanStage,
    materialDetails: materialDetails || 'Material Lot',
    scanTime: new Date().toISOString(),
    source,
    title: title || `Material Scanned: ${billNumber}`,
    message: message || `Material ${billNumber} was scanned by ${scannerName}.`,
    status: 'pending',
    isEmergencyAlarm: Boolean(isEmergencyAlarm),
    timestamp: new Date().toISOString(),
  };

  if (Array.isArray(targetUserIds) && targetUserIds.length > 0) {
    console.log(`[Socket] 📢 Emitting Generic Scan ${eventId} for ${billNumber} to user IDs: [${targetUserIds.join(', ')}]`);
    emitToUsers(targetUserIds, 'new_notification', payload);
  }

  return payload;
}

/**
 * Notify all listeners of tick status changes (Single Grey -> Double Grey -> Double Blue)
 */
function notifyStatusChange(data) {
  if (!io) return;
  io.emit('notification:status_change', data);
}

function getIO() {
  return io;
}

module.exports = {
  initSocket,
  emitToUsers,
  sendGateScanNotification,
  sendStoreScanNotification,
  sendSupervisorScanNotification,
  sendGenericScanNotification,
  notifyStatusChange,
  getIO,
};

