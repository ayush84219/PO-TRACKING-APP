const pool = require('../db/pool');
const { sendPush } = require('./push');
const { enqueueNotification } = require('./notificationQueue');
const { getIO, emitToUsers } = require('./socketService');
const { triggerPoAlarm } = require('./poAlarmService');
const { resolveSupervisorUsers, getUsersByRole } = require('./userDirectory');

let watcherTimer = null;
let isChecking = false;

/**
 * Check for newly generated POs in purchase_orders and dispatch notifications to ALL PANELS:
 * - Gate Security (gate)
 * - Store Department (store)
 * - Warehouse Supervisor (supervisor)
 * - Administrator (admin)
 */
async function checkNewPurchaseOrders() {
  if (isChecking) return [];
  isChecking = true;

  const detectedPOs = [];

  try {
    // Query newly generated POs not yet notified using primary key index
    let newPOs = [];
    try {
      const [rows] = await pool.query(`
        SELECT p.id, p.poNumber AS po_number, p.vendorName AS vendor_name,
               p.designName AS design_name, p.designCategory AS design_category,
               p.items, p.date, 'PO' AS po_type
        FROM purchase_orders p
        WHERE p.poNumber NOT IN (SELECT po_number FROM notified_po_app WHERE po_number IS NOT NULL)
        ORDER BY p.id ASC
        LIMIT 10
      `);
      newPOs = rows;
    } catch (e) {
      console.error('[PO Watcher] Error querying purchase_orders:', e.message);
    }

    // Also check new Zip orders
    try {
      const [zipRows] = await pool.query(`
        SELECT z.id, COALESCE(NULLIF(TRIM(z.po_number), ''), CONCAT('ZIP-', z.Lot_Number)) AS po_number,
               z.Supplier_Name AS vendor_name, z.Style AS design_name,
               'ZIP' AS design_category, z.Total_Pieces AS quantity,
               z.Issue_Date AS date, z.Supervisor AS supervisor,
               'ZIP' AS po_type, z.Lot_Number AS lot_number
        FROM zip z
        WHERE COALESCE(NULLIF(TRIM(z.po_number), ''), CONCAT('ZIP-', z.Lot_Number)) IS NOT NULL
          AND COALESCE(NULLIF(TRIM(z.po_number), ''), CONCAT('ZIP-', z.Lot_Number)) != ''
          AND COALESCE(NULLIF(TRIM(z.po_number), ''), CONCAT('ZIP-', z.Lot_Number)) NOT IN (SELECT po_number FROM notified_po_app WHERE po_number IS NOT NULL)
        ORDER BY z.id ASC
        LIMIT 5
      `);
      if (zipRows && zipRows.length) newPOs.push(...zipRows);
    } catch (e) {
      console.warn('[PO Watcher] Error querying zip:', e.message);
    }

    // Also check new Doori orders
    try {
      const [dooriRows] = await pool.query(`
        SELECT d.id, COALESCE(NULLIF(TRIM(d.po_number), ''), CONCAT('DORI-', d.Lot_Number)) AS po_number,
               d.Supplier_Name AS vendor_name, d.Style AS design_name,
               'DORI' AS design_category, d.Total_Pieces AS quantity,
               d.Issue_Date AS date, d.Supervisor AS supervisor,
               'DORI' AS po_type, d.Lot_Number AS lot_number
        FROM doori d
        WHERE COALESCE(NULLIF(TRIM(d.po_number), ''), CONCAT('DORI-', d.Lot_Number)) IS NOT NULL
          AND COALESCE(NULLIF(TRIM(d.po_number), ''), CONCAT('DORI-', d.Lot_Number)) != ''
          AND COALESCE(NULLIF(TRIM(d.po_number), ''), CONCAT('DORI-', d.Lot_Number)) NOT IN (SELECT po_number FROM notified_po_app WHERE po_number IS NOT NULL)
        ORDER BY d.id ASC
        LIMIT 5
      `);
      if (dooriRows && dooriRows.length) newPOs.push(...dooriRows);
    } catch (e) {
      console.warn('[PO Watcher] Error querying doori:', e.message);
    }

    if (!newPOs.length) return [];

    // 3. Fetch ALL active users across ALL panels (gate, store, supervisor, admin)
    const [allUsers] = await pool.query(
      "SELECT id, name, role, email FROM user_app WHERE is_active = 1"
    );

    const supervisors = allUsers.filter(u => u.role === 'supervisor' || u.base_role === 'supervisor');
    const defaultSupName = supervisors.length > 0 ? supervisors[0].name : 'Amit Kumar (Warehouse A)';

    for (const po of newPOs) {
      const rawNum = String(po.po_number || po.id || '').trim();
      const cleanDigits = rawNum.replace(/[^0-9]/g, '') || rawNum;
      let formattedPo = cleanDigits.startsWith('PO-') ? cleanDigits : `PO-${cleanDigits}`;
      if (po.po_type === 'ZIP') {
        formattedPo = rawNum.startsWith('ZIP-') ? rawNum : `ZIP-${cleanDigits}`;
      } else if (po.po_type === 'DORI') {
        formattedPo = (rawNum.startsWith('DORI-') || rawNum.startsWith('DOORI-')) ? rawNum : `DORI-${cleanDigits}`;
      }

      const vendor = po.vendor_name || (po.po_type === 'ZIP' ? 'Zip Supplier' : (po.po_type === 'DORI' ? 'Doori Supplier' : 'Vendor'));
      const lotNo = po.lot_number || po.design_name || cleanDigits;

      // Parse quantity and items
      let totalQty = Number(po.quantity) || 1;
      let unit = 'PCS';
      let itemsSummary = po.design_name || (po.po_type === 'ZIP' ? 'Zip Material' : (po.po_type === 'DORI' ? 'Doori Material' : 'Materials'));

      if (po.items) {
        try {
          const parsed = typeof po.items === 'string' ? JSON.parse(po.items) : po.items;
          if (Array.isArray(parsed) && parsed.length > 0) {
            totalQty = parsed.reduce((acc, it) => acc + (Number(it.qty) || 0), 0);
            if (parsed[0].unit) unit = parsed[0].unit;
            itemsSummary = parsed.map(it => it.name).filter(Boolean).slice(0, 3).join(', ') || itemsSummary;
          }
        } catch { }
      }

      // Lookup assigned supervisor from supervisor_details_app or PO row
      let assignedSupervisor = po.supervisor || null;
      if (!assignedSupervisor) {
        try {
          const [supMatch] = await pool.query(
            "SELECT supervisor FROM supervisor_details_app WHERE lot_number IN (?, ?, ?) LIMIT 1",
            [cleanDigits, formattedPo, rawNum]
          );
          if (supMatch.length && supMatch[0].supervisor) {
            assignedSupervisor = supMatch[0].supervisor;
          }
        } catch { }
      }

      if (!assignedSupervisor) assignedSupervisor = defaultSupName;

      const poTypeLabel = po.po_type === 'ZIP' ? 'Zip PO' : (po.po_type === 'DORI' ? 'Doori PO' : 'PO');
      console.log(`[POWatcher] 📋 Detected NEW ${poTypeLabel}: ${formattedPo} (Vendor: ${vendor}, Lot: ${lotNo}, Supervisor: ${assignedSupervisor}, Qty: ${totalQty} ${unit})`);

      const poTitle = po.po_type === 'ZIP'
        ? `📋 New Zip PO: ${formattedPo} Generated | Lot No: ${lotNo}`
        : (po.po_type === 'DORI'
          ? `📋 New Doori PO: ${formattedPo} Generated | Lot No: ${lotNo}`
          : `📋 New PO No: ${formattedPo} Generated | Lot No: ${lotNo}`);
      const poBaseMsg = `New ${poTypeLabel} No: ${formattedPo} Generated | Lot No: ${lotNo}\nSupplier: ${vendor} • Material: ${itemsSummary} (${totalQty} ${unit})\nAssigned: ${assignedSupervisor}. Standby for arrival at gate.`;

      // 4. Target Security (Gate) and ONLY the Specific Assigned Supervisor (NEVER Admin, NEVER other Supervisors)
      const gateUsers = await getUsersByRole(['gate']);
      const matchedSups = await resolveSupervisorUsers(assignedSupervisor);
      const poTargetMap = new Map();
      [...gateUsers, ...matchedSups].forEach((u) => {
        const uid = u.user_id || u.id;
        poTargetMap.set(uid, { ...u, id: uid });
      });
      const poTargetUsers = Array.from(poTargetMap.values());
      const poTargetIds = poTargetUsers.map(u => u.id);

      for (const u of poTargetUsers) {
        let title = poTitle;
        let message = poBaseMsg;

        if (u.role === 'gate') {
          title = poTitle;
          message = `New PO No: ${formattedPo} Generated | Lot No: ${lotNo}\nSupplier: ${vendor} • Material: ${itemsSummary} (${totalQty} ${unit})\nSecurity: Keep on standby for material arrival at gate.`;
        } else if (u.role === 'supervisor') {
          title = poTitle;
          message = `New PO No: ${formattedPo} Generated | Lot No: ${lotNo}\nSupplier: ${vendor} • Material: ${itemsSummary} (${totalQty} ${unit})\nSupervisor: Assigned to ${assignedSupervisor}. Standby for gate inward.`;
        }

        await enqueueNotification({
          lotNumber: formattedPo,
          userId: u.id,
          targetRole: u.role,
          title,
          message,
          payload: {
            poNumber: formattedPo,
            lotNo,
            vendor,
            items: itemsSummary,
            totalQuantity: totalQty,
            unit,
            supervisor: assignedSupervisor,
            type: 'po_generated',
            isEmergencyAlarm: false,
          },
        }).catch(() => { });
      }

      // 5. Trigger Smart PO Alert and Alarm Notification (Uber/Rapido style, OPEN PO & STOP ALARM actions)
      await triggerPoAlarm({
        poNumber: formattedPo,
        vendorName: vendor,
        amount: po.total || (po.subtotal ? Number(po.subtotal) + Number(po.tax || 0) : null),
        orderDate: po.date || new Date(),
        items: itemsSummary,
        designName: po.design_name,
        triggeredBy: 'PO Generator',
        assignedSupervisor,
      }).catch((err) => console.error('[POWatcher] Error triggering Smart PO Alarm:', err.message));

      // 6. Schedule Active Material Alarm 15s after PO generation to alert Security & Supervisor to stay active!
      setTimeout(() => {
        const standbyAlarmTitle = `🚨 ALARM: Material Standby (PO ${formattedPo})`;
        const standbyAlarmBody = `PO No: ${formattedPo} (Lot ${lotNo}) approaching Gate!\nSupplier: ${vendor} • ${itemsSummary}\nSecurity & Supervisor: Be active for parcel arrival!`;

        console.log(`[POWatcher] ⏰ Triggering 15s Standby Alarm for ${formattedPo} (Gate & Supervisor)...`);

        // Send high-priority emergency alarm push outside the app
        sendPush(
          poTargetIds,
          standbyAlarmTitle,
          standbyAlarmBody,
          {
            lotNumber: formattedPo,
            lotNo,
            type: 'po_standby_alarm',
            isEmergencyAlarm: true,
          }
        );

        // Emit continuous in-app siren alarm ONLY to targeted Gate & Assigned Supervisor user IDs
        if (poTargetIds.length > 0) {
          emitToUsers(poTargetIds, 'new_notification', {
            eventId: `EVT-ALARM-PO-${cleanDigits}-${Date.now()}`,
            eventType: 'MATERIAL_STANDBY_ALARM',
            isEmergencyAlarm: true,
            billNumber: formattedPo,
            lotNo,
            supplierName: vendor,
            materialDetails: `${itemsSummary} (${totalQty} ${unit})`,
            scannerName: assignedSupervisor,
            scanTime: new Date().toISOString(),
            billId: formattedPo,
            source: 'PO Standby Alarm',
            title: standbyAlarmTitle,
            message: standbyAlarmBody,
            status: 'pending',
            timestamp: new Date().toISOString(),
          });
        }
      }, 15000); // 15-second alarm trigger!

      // 6. Broadcast Real-time Normal Notification ONLY to targeted Gate & Assigned Supervisor (never Admin!)
      if (poTargetIds.length > 0) {
        const socketPayload = {
          eventId: `EVT-PO-${cleanDigits}-${Date.now()}`,
          eventType: 'PO_GENERATED',
          isEmergencyAlarm: false, // Normal notification! No continuous emergency siren
          billNumber: formattedPo,
          lotNo,
          supplierName: vendor,
          materialDetails: `${itemsSummary} (${totalQty} ${unit})`,
          designName: po.design_name || '',
          designCategory: po.design_category || '',
          scannerName: assignedSupervisor,
          scanTime: new Date().toISOString(),
          billId: formattedPo,
          source: 'ERP / Database',
          title: poTitle,
          message: poBaseMsg,
          status: 'delivered',
          timestamp: new Date().toISOString(),
        };

        emitToUsers(poTargetIds, 'new_notification', socketPayload);
        emitToUsers(poTargetIds, 'po:new', {
          poNumber: formattedPo,
          vendorName: vendor,
          designName: po.design_name,
          designCategory: po.design_category,
          totalQty,
          unit,
        });
        console.log(`[POWatcher] 📡 Socket.IO targeted notification sent to user IDs [${poTargetIds.join(', ')}] for ${formattedPo}`);
      }

      // 7. Mark PO as notified in notified_po_app
      await pool.query(
        `INSERT IGNORE INTO notified_po_app (po_number, vendor_name, supervisor_name) VALUES (?, ?, ?)`,
        [formattedPo, vendor, assignedSupervisor]
      ).catch(() => { });

      if (rawNum !== formattedPo) {
        await pool.query(
          `INSERT IGNORE INTO notified_po_app (po_number, vendor_name, supervisor_name) VALUES (?, ?, ?)`,
          [rawNum, vendor, assignedSupervisor]
        ).catch(() => { });
      }

      detectedPOs.push({ formattedPo, vendor, totalQty, unit });
    }
  } catch (err) {
    console.error('[POWatcher] Error in watcher tick:', err.message);
  } finally {
    isChecking = false;
  }

  return detectedPOs;
}

/**
 * Start periodic PO watcher (checks every 45 seconds to reduce database CPU/RAM)
 */
function startPoWatcher(intervalMs = 45000) {
  if (watcherTimer) return;
  // Run first check 3 seconds after startup
  setTimeout(() => {
    checkNewPurchaseOrders();
  }, 3000);
  watcherTimer = setInterval(checkNewPurchaseOrders, intervalMs);
  console.log(`[POWatcher] Background watcher started (check interval: ${intervalMs}ms).`);
}

/**
 * Stop periodic PO watcher
 */
function stopPoWatcher() {
  if (watcherTimer) {
    clearInterval(watcherTimer);
    watcherTimer = null;
    console.log('[POWatcher] Background watcher stopped.');
  }
}

module.exports = {
  startPoWatcher,
  stopPoWatcher,
  checkNewPurchaseOrders,
};
