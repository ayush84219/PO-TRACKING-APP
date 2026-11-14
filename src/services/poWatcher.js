const pool = require('../db/pool');
const { sendPush } = require('./push');
const { enqueueNotification } = require('./notificationQueue');
const { getIO } = require('./socketService');

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
               p.items, p.date
        FROM purchase_orders p
        WHERE p.poNumber NOT IN (SELECT po_number FROM notified_po_app WHERE po_number IS NOT NULL)
        ORDER BY p.id ASC
        LIMIT 10
      `);
      newPOs = rows;
    } catch (e) {
      console.error('[PO Watcher] Error querying purchase_orders:', e.message);
      return [];
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
      const formattedPo = cleanDigits.startsWith('PO-') ? cleanDigits : `PO-${cleanDigits}`;
      const vendor = po.vendor_name || 'Vendor';
      const lotNo = po.design_name || cleanDigits;

      // Parse quantity and items
      let totalQty = 1;
      let unit = 'PCS';
      let itemsSummary = po.design_name || 'Materials';

      if (po.items) {
        try {
          const parsed = typeof po.items === 'string' ? JSON.parse(po.items) : po.items;
          if (Array.isArray(parsed) && parsed.length > 0) {
            totalQty = parsed.reduce((acc, it) => acc + (Number(it.qty) || 0), 0);
            if (parsed[0].unit) unit = parsed[0].unit;
            itemsSummary = parsed.map(it => it.name).filter(Boolean).slice(0, 3).join(', ') || itemsSummary;
          }
        } catch {}
      }

      // Lookup assigned supervisor from supervisor_details_app
      let assignedSupervisor = null;
      try {
        const [supMatch] = await pool.query(
          "SELECT supervisor FROM supervisor_details_app WHERE lot_number IN (?, ?, ?) LIMIT 1",
          [cleanDigits, formattedPo, rawNum]
        );
        if (supMatch.length && supMatch[0].supervisor) {
          assignedSupervisor = supMatch[0].supervisor;
        }
      } catch {}

      if (!assignedSupervisor) assignedSupervisor = defaultSupName;

      console.log(`[POWatcher] 📋 Detected NEW PO Bill: ${formattedPo} (Vendor: ${vendor}, Lot: ${lotNo}, Supervisor: ${assignedSupervisor}, Qty: ${totalQty} ${unit})`);

      const poTitle = `📋 New PO No: ${formattedPo} Generated | Lot No: ${lotNo}`;
      const poBaseMsg = `New PO No: ${formattedPo} Generated | Lot No: ${lotNo}\nSupplier: ${vendor} • Material: ${itemsSummary} (${totalQty} ${unit})\nAssigned: ${assignedSupervisor}. Standby for arrival.`;

      // 4. Dispatch notification to EVERY user in ALL PANELS (Gate, Store, Supervisor, Admin)
      for (const u of allUsers) {
        let title = poTitle;
        let message = poBaseMsg;

        if (u.role === 'gate') {
          title = poTitle;
          message = `New PO No: ${formattedPo} Generated | Lot No: ${lotNo}\nSupplier: ${vendor} • Material: ${itemsSummary} (${totalQty} ${unit})\nKeep on standby for material arrival at gate.`;
        } else if (u.role === 'store') {
          title = poTitle;
          message = `New PO No: ${formattedPo} Generated | Lot No: ${lotNo}\nSupplier: ${vendor} • Material: ${itemsSummary} (${totalQty} ${unit})\nAssigned to Supervisor: ${assignedSupervisor}.`;
        } else if (u.role === 'supervisor') {
          title = poTitle;
          message = `New PO No: ${formattedPo} Generated | Lot No: ${lotNo}\nSupplier: ${vendor} • Material: ${itemsSummary} (${totalQty} ${unit})\nAssigned to: ${assignedSupervisor}.`;
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
            isEmergencyAlarm: false, // Normal notification!
          },
        }).catch(() => {});
      }

      // 5. Send push notifications to mobile devices
      const userIds = allUsers.map(u => u.id);
      if (userIds.length > 0) {
        sendPush(
          userIds,
          poTitle,
          poBaseMsg,
          {
            lotNumber: formattedPo,
            lotNo,
            type: 'po_generated',
            supervisor: assignedSupervisor,
            isEmergencyAlarm: false,
          }
        );
      }

      // 6. Broadcast Real-time Normal Notification to ALL connected panels via Socket.IO
      const io = getIO();
      if (io) {
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

        io.emit('new_notification', socketPayload);
        io.emit('po:new', {
          poNumber: formattedPo,
          vendorName: vendor,
          designName: po.design_name,
          designCategory: po.design_category,
          totalQty,
          unit,
        });
        console.log(`[POWatcher] 📡 Socket.IO broadcast sent to all panels for ${formattedPo}`);
      }

      // 7. Mark PO as notified in notified_po_app
      await pool.query(
        `INSERT IGNORE INTO notified_po_app (po_number, vendor_name, supervisor_name) VALUES (?, ?, ?)`,
        [formattedPo, vendor, assignedSupervisor]
      ).catch(() => {});

      if (rawNum !== formattedPo) {
        await pool.query(
          `INSERT IGNORE INTO notified_po_app (po_number, vendor_name, supervisor_name) VALUES (?, ?, ?)`,
          [rawNum, vendor, assignedSupervisor]
        ).catch(() => {});
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
