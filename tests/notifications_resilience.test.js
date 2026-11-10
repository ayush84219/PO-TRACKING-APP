const test = require('node:test');
const assert = require('node:assert');
const app = require('../src/app');
const pool = require('../src/db/pool');
const { initSchema } = require('../src/db/initSchema');
const {
  enqueueNotification,
  processPendingQueue,
  checkAndTriggerEscalations,
  acknowledgeLot,
} = require('../src/services/notificationQueue');

let server, base;
const uniq = Date.now();

const call = async (path, { method = 'GET', body, token } = {}) => {
  const r = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

test.before(async () => {
  await initSchema();
  // Clear any leftover pending or unacknowledged items from previous runs
  await pool.query("UPDATE notification_queue_app SET status = 'delivered', acknowledged_at = NOW() WHERE status = 'pending' OR acknowledged_at IS NULL").catch(() => {});
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  await pool.end();
});

test('RESILIENCE SUITE: Persistent notification queue, retries, escalation, duplicate protection, and audit logs', async (t) => {
  // Setup users: 1 Gate officer, 1 Primary Supervisor, 1 Backup Supervisor/Admin
  const gateUser = await call('/auth/register', {
    method: 'POST',
    body: { name: 'Gate Ram', email: `gate_${uniq}@resilience.test`, password: 'password123', role: 'gate' },
  });
  assert.equal(gateUser.status, 201);
  const gateToken = gateUser.data.accessToken;
  const gateId = gateUser.data.user.id;

  const primarySup = await call('/auth/register', {
    method: 'POST',
    body: { name: 'Supervisor Amit', email: `sup_${uniq}@resilience.test`, password: 'password123', role: 'supervisor' },
  });
  assert.equal(primarySup.status, 201);
  const supToken = primarySup.data.accessToken;
  const supId = primarySup.data.user.id;

  const adminUser = await call('/auth/register', {
    method: 'POST',
    body: { name: 'Admin Boss', email: `admin_${uniq}@resilience.test`, password: 'password123', role: 'admin' },
  });
  assert.equal(adminUser.status, 201);
  const adminToken = adminUser.data.accessToken;
  const adminId = adminUser.data.user.id;

  // ----------------------------------------------------------------------------------------
  // 1. PERSISTENT NOTIFICATION QUEUE & STATE TRANSITIONS IN MYSQL
  // ----------------------------------------------------------------------------------------
  await t.test('1. Persistent Queue: Enqueue, MySQL persistence, and delivery state', async () => {
    const lotNumber = `LOT-QUEUE-${uniq}`;
    const queueId = await enqueueNotification({
      lotNumber,
      userId: supId,
      targetRole: 'supervisor',
      title: 'Material Arrival Test',
      message: 'Test persistent queue in MySQL',
      payload: { test: true },
    });
    assert.ok(queueId > 0, 'Queue ID should be returned');

    // Verify row in MySQL notification_queue_app
    const [[row]] = await pool.query('SELECT * FROM notification_queue_app WHERE id = ?', [queueId]);
    assert.equal(row.lot_number, lotNumber);
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 0);

    // Mock successful push delivery
    let pushedUsers = [];
    const mockSendPush = async (ids) => { pushedUsers = ids; };
    const result = await processPendingQueue(50, mockSendPush);
    assert.ok(result.delivered >= 1, 'Should process and deliver item');

    // Verify delivered state in MySQL
    const [[updatedRow]] = await pool.query('SELECT * FROM notification_queue_app WHERE id = ?', [queueId]);
    assert.equal(updatedRow.status, 'delivered');
    assert.equal(updatedRow.attempts, 1);
  });

  // ----------------------------------------------------------------------------------------
  // 2. AUTOMATIC RETRIES WITH EXPONENTIAL BACKOFF ON PUSH FAILURE
  // ----------------------------------------------------------------------------------------
  await t.test('2. Automatic Retries: Backoff on failure and max attempts handling', async () => {
    const lotNumber = `LOT-RETRY-${uniq}`;
    const queueId = await enqueueNotification({
      lotNumber,
      userId: supId,
      targetRole: 'supervisor',
      title: 'Failing Push Test',
      message: 'Simulating push service failure',
      maxAttempts: 2,
    });

    const mockFailingPush = async () => {
      throw new Error('Connection reset by OneSignal gateway');
    };

    // First attempt -> should fail and schedule retry
    const res1 = await processPendingQueue(50, mockFailingPush);
    assert.ok(res1.retried >= 1, 'Should schedule retry on first failure');

    const [[rowAttempt1]] = await pool.query('SELECT * FROM notification_queue_app WHERE id = ?', [queueId]);
    assert.equal(rowAttempt1.status, 'pending');
    assert.equal(rowAttempt1.attempts, 1);
    assert.ok(rowAttempt1.last_error.includes('OneSignal'), 'Error recorded');

    // Force next_retry_at to past so second attempt triggers immediately
    await pool.query('UPDATE notification_queue_app SET next_retry_at = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE id = ?', [queueId]);

    // Second attempt -> exceeds max_attempts (2) -> marks failed
    const res2 = await processPendingQueue(50, mockFailingPush);
    assert.ok(res2.failed >= 1, 'Should mark failed when max attempts reached');

    const [[rowAttempt2]] = await pool.query('SELECT * FROM notification_queue_app WHERE id = ?', [queueId]);
    assert.equal(rowAttempt2.status, 'failed');
    assert.equal(rowAttempt2.attempts, 2);

    // Verify audit log for failure
    const [auditRows] = await pool.query(
      "SELECT * FROM audit_logs_app WHERE event_type = 'NOTIFICATION_DELIVERY_FAILED' AND lot_number = ?",
      [lotNumber]
    );
    assert.ok(auditRows.length >= 1, 'Audit log recorded for NOTIFICATION_DELIVERY_FAILED');
  });

  // ----------------------------------------------------------------------------------------
  // 3. BACKUP SUPERVISOR ESCALATION IF PRIMARY DOES NOT ACKNOWLEDGE WITHIN SLA
  // ----------------------------------------------------------------------------------------
  await t.test('3. Escalation: Overdue gate arrival triggers backup supervisor alert', async () => {
    const lotNumber = `LOT-ESCALATE-${uniq}`;
    const queueId = await enqueueNotification({
      lotNumber,
      userId: supId,
      targetRole: 'supervisor',
      title: 'Material Arrived at Gate',
      message: `Lot ${lotNumber} at gate`,
    });

    // Artificially age the notification to 20 minutes ago (exceeding 15-minute SLA)
    await pool.query(
      'UPDATE notification_queue_app SET created_at = DATE_SUB(NOW(), INTERVAL 20 MINUTE) WHERE id = ?',
      [queueId]
    );

    // Trigger escalation check with 15-minute SLA
    const escalationResult = await checkAndTriggerEscalations(15);
    assert.ok(escalationResult.escalatedCount >= 1, 'Should escalate overdue gate item');
    assert.ok(escalationResult.escalatedLots.includes(lotNumber), 'Escalated lot included');

    // Original entry marked escalated
    const [[orig]] = await pool.query('SELECT * FROM notification_queue_app WHERE id = ?', [queueId]);
    assert.equal(orig.status, 'escalated');
    assert.ok(orig.escalated_at !== null);

    // Escalation alert created for backup users (admin or other supervisors)
    const [backupAlerts] = await pool.query(
      "SELECT * FROM notification_queue_app WHERE lot_number = ? AND title LIKE '%ESCALATION%'",
      [lotNumber]
    );
    assert.ok(backupAlerts.length >= 1, 'Escalation notification created for backup supervisor');

    // Audit log recorded
    const [auditEsc] = await pool.query(
      "SELECT * FROM audit_logs_app WHERE event_type = 'ESCALATION_TRIGGERED' AND lot_number = ?",
      [lotNumber]
    );
    assert.ok(auditEsc.length >= 1, 'Audit log recorded for ESCALATION_TRIGGERED');
  });

  // ----------------------------------------------------------------------------------------
  // 4. DUPLICATE-SCAN PREVENTION AT GATE
  // ----------------------------------------------------------------------------------------
  await t.test('4. Gate Security: Duplicate-scan prevention and audit log', async () => {
    const lotNumber = `LOT-GATE-DUP-${uniq}`;

    // First Gate Scan -> Should succeed
    const firstScan = await call('/scans', {
      method: 'POST',
      token: gateToken,
      body: {
        lotNumber,
        materialName: 'Test Fabric Rolls',
        status: 'pending',
        note: '[GATE ENTRY] Gate 1 Checked In',
      },
    });
    assert.equal(firstScan.status, 201);
    assert.equal(firstScan.data.duplicate, false);

    // Second Gate Scan (Duplicate) -> Should detect duplicate and return warning without duplicate insertion
    const secondScan = await call('/scans', {
      method: 'POST',
      token: gateToken,
      body: {
        lotNumber,
        materialName: 'Test Fabric Rolls',
        status: 'pending',
        note: '[GATE ENTRY] Duplicate scan attempt',
      },
    });
    assert.equal(secondScan.status, 200);
    assert.equal(secondScan.data.duplicate, true);
    assert.ok(secondScan.data.message.includes('already logged at the Gate'));

    // Check database has only 1 material row and 1 scan row
    const [matRows] = await pool.query('SELECT * FROM materials_app WHERE lot_number = ?', [lotNumber]);
    assert.equal(matRows.length, 1);
    const [scanRows] = await pool.query('SELECT * FROM scans_app WHERE lot_number = ?', [lotNumber]);
    assert.equal(scanRows.length, 1);

    // Audit log verification
    const [dupAudit] = await pool.query(
      "SELECT * FROM audit_logs_app WHERE event_type = 'DUPLICATE_SCAN_BLOCKED' AND lot_number = ?",
      [lotNumber]
    );
    assert.ok(dupAudit.length >= 1, 'Audit log recorded for DUPLICATE_SCAN_BLOCKED');
  });

  // ----------------------------------------------------------------------------------------
  // 5. GATE-ARRIVAL ENFORCEMENT BEFORE SUPERVISOR PICKUP
  // ----------------------------------------------------------------------------------------
  await t.test('5. Supervisor: Rejects pickup if lot never arrived at Gate', async () => {
    const nonExistentLot = `LOT-UNARRIVED-${uniq}`;

    const pickupAttempt = await call('/scans', {
      method: 'POST',
      token: supToken,
      body: {
        lotNumber: nonExistentLot,
        materialName: 'Ghost Item',
        status: 'completed',
        note: '[SUPERVISOR PICKUP] Attempt before gate arrival',
      },
    });

    assert.equal(pickupAttempt.status, 400);
    assert.equal(pickupAttempt.data.code, 'GATE_ENTRY_REQUIRED');

    // Audit log verification
    const [unauthAudit] = await pool.query(
      "SELECT * FROM audit_logs_app WHERE event_type = 'PICKUP_WITHOUT_GATE_ENTRY' AND lot_number = ?",
      [nonExistentLot]
    );
    assert.ok(unauthAudit.length >= 1, 'Audit log recorded for PICKUP_WITHOUT_GATE_ENTRY');
  });

  // ----------------------------------------------------------------------------------------
  // 6. SECURE SUPERVISOR PICKUP & AUTOMATIC NOTIFICATION ACKNOWLEDGMENT
  // ----------------------------------------------------------------------------------------
  await t.test('6. Supervisor: Secure pickup confirmation & notification acknowledgment', async () => {
    const lotNumber = `LOT-PICKUP-CONFIRM-${uniq}`;

    // Step A: Gate Scan
    const gateScan = await call('/scans', {
      method: 'POST',
      token: gateToken,
      body: {
        lotNumber,
        materialName: 'High-Grade Thread',
        status: 'pending',
        note: '[GATE ENTRY] Arrived at Factory Gate',
      },
    });
    assert.equal(gateScan.status, 201);

    // Step B: Supervisor Pickup
    const pickupRes = await call('/scans', {
      method: 'POST',
      token: supToken,
      body: {
        lotNumber,
        materialName: 'High-Grade Thread',
        status: 'completed',
        note: '[SUPERVISOR PICKUP] Verified and stored in Bay 3',
      },
    });
    assert.equal(pickupRes.status, 201);
    assert.equal(pickupRes.data.scan.status, 'completed');

    // Verify material status updated in database
    const [[material]] = await pool.query('SELECT * FROM materials_app WHERE lot_number = ?', [lotNumber]);
    assert.equal(material.status, 'completed');

    // Verify pending notification queue records for this lot are acknowledged
    const [queueRows] = await pool.query(
      "SELECT * FROM notification_queue_app WHERE lot_number = ? AND title LIKE '%Arrived at Gate%'",
      [lotNumber]
    );
    for (const q of queueRows) {
      assert.equal(q.status, 'acknowledged');
      assert.equal(q.acknowledged_by, supId);
      assert.ok(q.acknowledged_at !== null);
    }

    // Verify audit logs
    const [pickupAudit] = await pool.query(
      "SELECT * FROM audit_logs_app WHERE event_type = 'SUPERVISOR_PICKUP' AND lot_number = ?",
      [lotNumber]
    );
    assert.ok(pickupAudit.length >= 1, 'Audit log recorded for SUPERVISOR_PICKUP');
  });

  // ----------------------------------------------------------------------------------------
  // 7. DUPLICATE-PICKUP PREVENTION WITH CLEAR ATTRIBUTION
  // ----------------------------------------------------------------------------------------
  await t.test('7. Supervisor: Duplicate-pickup prevention with clear attribution', async () => {
    const lotNumber = `LOT-PICKUP-CONFIRM-${uniq}`; // already picked up in step 6

    const secondPickup = await call('/scans', {
      method: 'POST',
      token: supToken,
      body: {
        lotNumber,
        materialName: 'High-Grade Thread',
        status: 'completed',
        note: '[SUPERVISOR PICKUP] Accidental repeat pickup attempt',
      },
    });

    assert.equal(secondPickup.status, 409);
    assert.equal(secondPickup.data.code, 'DUPLICATE_PICKUP_BLOCKED');
    assert.ok(secondPickup.data.error.includes('already picked up'));

    // Verify audit log
    const [dupPickupAudit] = await pool.query(
      "SELECT * FROM audit_logs_app WHERE event_type = 'DUPLICATE_PICKUP_BLOCKED' AND lot_number = ?",
      [lotNumber]
    );
    assert.ok(dupPickupAudit.length >= 1, 'Audit log recorded for DUPLICATE_PICKUP_BLOCKED');
  });

  // ----------------------------------------------------------------------------------------
  // 8. OFFLINE SYNCHRONIZATION ENDPOINT (RECONNECT & RECONCILE)
  // ----------------------------------------------------------------------------------------
  await t.test('8. Offline Sync: Reconcile offline events and deliver missed updates', async () => {
    const offlineLot = `LOT-OFFLINE-${uniq}`;

    const syncPayload = {
      lastSyncTimestamp: new Date(Date.now() - 3600000).toISOString(),
      offlineScans: [
        {
          clientId: 'client-offline-01',
          lotNumber: offlineLot,
          materialName: 'Offline Canvas',
          status: 'pending',
          note: '[GATE ENTRY] Scanned during warehouse network outage',
          timestamp: new Date().toISOString(),
        },
      ],
      offlineAcks: [
        { lotNumber: `LOT-ESCALATE-${uniq}` },
      ],
    };

    const syncRes = await call('/notifications/sync', {
      method: 'POST',
      token: gateToken,
      body: syncPayload,
    });

    assert.equal(syncRes.status, 200);
    assert.equal(syncRes.data.success, true);
    assert.ok(syncRes.data.syncedScans.length >= 1);
    assert.equal(syncRes.data.syncedScans[0].status, 'success');
    assert.ok(Array.isArray(syncRes.data.missedNotifications));

    // Verify audit log for offline sync
    const [syncAudit] = await pool.query(
      "SELECT * FROM audit_logs_app WHERE event_type = 'OFFLINE_SYNC_COMPLETED' AND user_id = ?",
      [gateId]
    );
    assert.ok(syncAudit.length >= 1, 'Audit log recorded for OFFLINE_SYNC_COMPLETED');
  });

  // ----------------------------------------------------------------------------------------
  // 9. ADMIN AUDIT LOGS ENDPOINT (/scans/audit)
  // ----------------------------------------------------------------------------------------
  await t.test('9. Admin Audit API: Query audit logs with pagination and filters', async () => {
    const auditRes = await call('/scans/audit?limit=10', {
      method: 'GET',
      token: adminToken,
    });

    assert.equal(auditRes.status, 200);
    assert.ok(auditRes.data.items.length > 0);
    assert.ok(auditRes.data.total >= auditRes.data.items.length);

    // Filter by eventType
    const dupFilter = await call('/scans/audit?eventType=DUPLICATE_SCAN_BLOCKED', {
      method: 'GET',
      token: adminToken,
    });
    assert.equal(dupFilter.status, 200);
    for (const item of dupFilter.data.items) {
      assert.equal(item.eventType, 'DUPLICATE_SCAN_BLOCKED');
    }
  });

  // ----------------------------------------------------------------------------------------
  // 10. NOTIFICATION DELETION & CLEAR ALL API
  // ----------------------------------------------------------------------------------------
  await t.test('10. Notification Deletion: Delete individual notification and clear all', async () => {
    // Check initial user notifications
    const initialList = await call('/notifications', { token: gateToken });
    assert.equal(initialList.status, 200);
    assert.ok(initialList.data.items.length > 0);

    const firstId = initialList.data.items[0].id;

    // Delete single notification
    const deleteSingle = await call(`/notifications/${firstId}`, {
      method: 'DELETE',
      token: gateToken,
    });
    assert.equal(deleteSingle.status, 200);
    assert.equal(deleteSingle.data.ok, true);

    // Verify deleted item is no longer in user's list
    const afterDelete = await call('/notifications', { token: gateToken });
    assert.ok(!afterDelete.data.items.some(i => i.id === firstId));

    // Clear all notifications
    const clearRes = await call('/notifications/clear-all', {
      method: 'DELETE',
      token: gateToken,
    });
    assert.equal(clearRes.status, 200);
    assert.equal(clearRes.data.ok, true);

    // Verify list is now empty
    const emptyList = await call('/notifications', { token: gateToken });
    assert.equal(emptyList.status, 200);
    assert.equal(emptyList.data.items.length, 0);
  });
});

