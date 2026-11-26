const router = require('express').Router();
const pool = require('../db/pool');
const S = require('../validators/schemas');
const { wrap } = require('../middleware/errors');
const { authenticate, requireRole } = require('../middleware/auth');
const { sendPush } = require('../services/push');
const { enqueueNotification, acknowledgeLot } = require('../services/notificationQueue');
const { logAudit, queryAuditLogs } = require('../services/auditLogger');
const {
  sendGateScanNotification,
  sendStoreScanNotification,
  sendSupervisorScanNotification,
  sendGenericScanNotification,
} = require('../services/socketService');
const { binarySearchService } = require('../services/binarySearchService');

router.use(authenticate);

const SELECT = `SELECT s.id, s.lot_number AS lotNumber, COALESCE(m.material_name, 'Material Lot') AS materialName,
  s.status, s.scan_stage AS scanStage, s.note, s.event_id AS eventId,
  s.delivery_status AS deliveryStatus, s.delivered_at AS deliveredAt,
  s.acknowledged_at AS acknowledgedAt, s.acknowledged_by_name AS acknowledgedByName,
  s.created_at AS createdAt, s.scanned_by AS scannedById, COALESCE(u.name, 'Gate Officer') AS scannedByName, u.role AS scannedByRole
  FROM scans_app s LEFT JOIN materials_app m ON m.id = s.material_id LEFT JOIN user_app u ON u.id = s.scanned_by`;

const page = (q) => {
  const limit = Math.min(Math.max(parseInt(q.limit) || 20, 1), 100);
  const p = Math.max(parseInt(q.page) || 1, 1);
  return { limit, offset: (p - 1) * limit, page: p };
};

function formatScanTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(iso);
  }
}

/**
 * POST /scans
 * Universal scan endpoint handling:
 * 1. 2-Stage PO lifecycle: GATE_INWARD -> SUPERVISOR_PICKUP -> Closed
 * 2. 3-Stage RGP lifecycle: GATE_OUT -> GATE_IN -> SUPERVISOR_INWARD -> Closed
 * 3. Robust duplicate protection with attribution
 * 4. Audit logging & persistent notification queue
 */
router.post('/', wrap(async (req, res) => {
  const parsed = S.scan.parse(req.body);
  const rawLot = parsed.lotNumber.trim();
  const materialName = (parsed.materialName || '').trim();
  let status = parsed.status;
  const note = (parsed.note || '').trim();
  const me = req.user;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  const upperLot = rawLot.toUpperCase();
  const isRgp = upperLot.startsWith('RGP-') || upperLot.startsWith('RGP') || parsed.docType === 'RGP';
  const isZip = upperLot.startsWith('ZIP') || upperLot.includes('ZIP') || parsed.subType === 'ZIP' || parsed.docType === 'ZIP';
  const isDoori = upperLot.startsWith('DORI') || upperLot.startsWith('DOORI') || upperLot.includes('DORI') || upperLot.includes('DOORI') || parsed.subType === 'DORI' || parsed.docType === 'DORI';
  const isPoPattern = upperLot.startsWith('PO-') || /^\d{4,6}$/.test(rawLot) || parsed.docType === 'PO' || isZip || isDoori;

  // Preserve exact lot string for generic lots, normalize POs, Zip, Doori, and RGPs
  let docLot = rawLot;
  if (isRgp) {
    docLot = (upperLot.startsWith('RGP-') || upperLot.startsWith('RGP/'))
      ? upperLot
      : (upperLot.startsWith('RGP') ? upperLot : `RGP-${upperLot}`);
  } else if (isZip) {
    const cleanZip = upperLot.replace(/^ZIP[-/]?/i, '');
    docLot = upperLot.startsWith('ZIP-') ? upperLot : `ZIP-${cleanZip}`;
  } else if (isDoori) {
    const cleanDoori = upperLot.replace(/^(DOORI|DORI)[-/]?/i, '');
    docLot = (upperLot.startsWith('DORI-') || upperLot.startsWith('DOORI-')) ? upperLot : `DORI-${cleanDoori}`;
  } else if (upperLot.startsWith('PO-')) {
    docLot = upperLot;
  } else if (/^\d{4,6}$/.test(rawLot)) {
    docLot = `PO-${rawLot}`;
  }

  const isGateScan = (
    ((me.role === 'gate' || me.base_role === 'gate') || (note && note.includes('[GATE ENTRY]')) || parsed.scanStage === 'GATE_INWARD' || parsed.scanStage === 'GATE_IN')
  );

  const isStoreScan = (
    ((me.role === 'store' || me.base_role === 'store') || (note && note.includes('[STORE INWARD]')) || parsed.scanStage === 'STORE_INWARD')
  );

  const isSupervisorScan = (
    ((me.role === 'supervisor' || me.base_role === 'supervisor') || (note && note.includes('[SUPERVISOR PICKUP]'))) &&
    (status === 'completed' || status === 'pending' || (note && note.includes('[SUPERVISOR PICKUP]')))
  );

  let scanStage = parsed.scanStage;

  const conn = await pool.getConnection();
  let scanId = null;
  let eventId = null;
  let rescanned = false;
  let rescanTargets = [];
  let lastScan = null;

  try {
    await conn.beginTransaction();

    // Lock existing material record
    const [mats] = await conn.query(
      'SELECT * FROM materials_app WHERE lot_number = ? OR lot_number = ? FOR UPDATE',
      [docLot, rawLot]
    );
    const material = mats[0] || null;

    // =========================================================================
    // 1. RGP SPECIFIC WORKFLOW (3 STAGES - WITH PARTIAL RETURN SUPPORT)
    // =========================================================================
    if (isRgp) {
      const [rgpScans] = await conn.query(
        `SELECT s.id, s.scan_stage, s.status, s.note, s.created_at, u.name AS scannedByName
         FROM scans_app s LEFT JOIN user_app u ON u.id = s.scanned_by
         WHERE s.lot_number = ? OR s.lot_number = ? ORDER BY s.id ASC`,
        [docLot, rawLot]
      );

      const finalSupClose = rgpScans.find(s => s.scan_stage === 'SUPERVISOR_INWARD' && (s.status === 'completed' || (s.note && s.note.includes('FINAL'))));
      const lastRgpScan = rgpScans[rgpScans.length - 1] || null;
      const prevGateOut = rgpScans.find(s => s.scan_stage === 'GATE_OUT' || (s.note && s.note.includes('[GATE OUT]')));

      if (!scanStage) {
        if (me.role === 'supervisor' || isSupervisorScan) {
          scanStage = 'SUPERVISOR_INWARD';
        } else if (prevGateOut && (!lastRgpScan || lastRgpScan.scan_stage === 'GATE_OUT' || (lastRgpScan.scan_stage === 'SUPERVISOR_INWARD' && lastRgpScan.status === 'pending'))) {
          scanStage = 'GATE_IN';
        } else {
          scanStage = 'GATE_OUT';
        }
      }

      if (finalSupClose) {
        await conn.rollback();
        const officerName = finalSupClose.scannedByName || 'Supervisor';
        const scanTimeStr = formatScanTime(finalSupClose.created_at);
        return res.status(200).json({
          duplicate: true,
          code: 'ALREADY_CLOSED',
          alreadyReceived: true,
          message: `RGP ${docLot} has already been completely received and verified (Full Material Received by ${officerName} on ${scanTimeStr}). No further scans allowed.`,
          completedBy: officerName,
          completedAt: finalSupClose.created_at,
          scan: finalSupClose,
        });
      }

      if (scanStage === 'GATE_OUT') {
        if (prevGateOut) {
          await conn.rollback();
          const officer = prevGateOut.scannedByName || 'Gate Officer';
          const scanTimeStr = formatScanTime(prevGateOut.created_at);
          return res.status(200).json({
            duplicate: true,
            code: 'ALREADY_SCANNED',
            message: `RGP ${docLot} was already dispatched Gate Out by ${officer} on ${scanTimeStr}. Next step is Gate In when material returns.`,
            scan: prevGateOut,
          });
        }
        status = 'in_progress';
      } else if (scanStage === 'GATE_IN') {
        if (!prevGateOut) {
          await conn.rollback();
          return res.status(400).json({
            error: `RGP ${docLot} cannot be scanned Gate In. Material must be dispatched from factory (Gate Out) first.`,
            code: 'GATE_OUT_REQUIRED',
          });
        }
        // If current batch is already sitting at Gate waiting for supervisor inspection
        if (lastRgpScan && lastRgpScan.scan_stage === 'GATE_IN') {
          await conn.rollback();
          const officer = lastRgpScan.scannedByName || 'Gate Officer';
          const scanTimeStr = formatScanTime(lastRgpScan.created_at);
          return res.status(200).json({
            duplicate: true,
            code: 'ALREADY_SCANNED',
            message: `RGP ${docLot} was already scanned Gate In by ${officer} on ${scanTimeStr}. Awaiting supervisor inward inspection.`,
            scan: lastRgpScan,
          });
        }
        // Allow Gate In: status is either 'pending' (partial return) or 'completed' (full return)
        status = (parsed.status === 'completed') ? 'completed' : 'pending';
      } else if (scanStage === 'SUPERVISOR_INWARD') {
        if (!lastRgpScan || lastRgpScan.scan_stage !== 'GATE_IN') {
          await conn.rollback();
          return res.status(400).json({
            error: `RGP ${docLot} has no pending return at Gate. Gate Security must scan material return (Gate In) first.`,
            code: 'GATE_IN_REQUIRED',
          });
        }
        // If Gate In was pending OR supervisor selected pending, mark as Half Received (partial return)
        if (lastRgpScan.status === 'pending' || parsed.status === 'pending') {
          status = 'pending';
        } else {
          status = 'completed';
        }
      }
    }

    // =========================================================================
    // 2. PURCHASE ORDER (PO) WORKFLOW (WITH PARTIAL / HALF DELIVERY SUPPORT)
    // =========================================================================
    if (!isRgp && (isGateScan || isSupervisorScan || isPoPattern)) {
      const [allScans] = await conn.query(
        `SELECT s.id, s.scan_stage, s.status, s.note, s.created_at, u.name AS scannedByName
         FROM scans_app s LEFT JOIN user_app u ON u.id = s.scanned_by
         WHERE (s.lot_number = ? OR s.lot_number = ? OR (s.material_id = ? AND ? > 0))
         ORDER BY s.id ASC`,
        [docLot, rawLot, material ? material.id : -1, material ? material.id : -1]
      );

      lastScan = allScans[allScans.length - 1] || null;
      const finalClosedScan = allScans.find(
        s => s.scan_stage === 'SUPERVISOR_PICKUP' && (s.status === 'completed' || (s.note && s.note.includes('FINAL')))
      );

      // Rule 1: Once PO is completely Closed by Supervisor, no further Gate or Supervisor scans allowed
      if (finalClosedScan || (material && (material.status === 'Closed' || material.status === 'completed'))) {
        await conn.rollback();
        const compName = (finalClosedScan && finalClosedScan.scannedByName) || 'Supervisor';
        const compTime = formatScanTime(finalClosedScan ? finalClosedScan.created_at : material.last_scanned_at);
        return res.status(200).json({
          duplicate: true,
          code: 'ALREADY_CLOSED',
          alreadyReceived: true,
          message: `PO ${docLot} has already been completely received and verified (Full Material Received by ${compName} on ${compTime}). No further scans allowed.`,
          completedBy: compName,
          completedAt: finalClosedScan ? finalClosedScan.created_at : undefined,
          scan: finalClosedScan,
        });
      }

      // Rule 2: Gate Security Scanning (Step 1/3)
      if (isGateScan) {
        // If an uninspected shipment is already sitting at the gate right now
        if (lastScan && lastScan.scan_stage === 'GATE_INWARD') {
          await conn.rollback();
          const officer = lastScan.scannedByName || 'Gate Officer';
          const scanTimeStr = formatScanTime(lastScan.created_at);
          return res.status(200).json({
            duplicate: true,
            code: 'ALREADY_SCANNED',
            message: `PO ${docLot} was already scanned at Gate by ${officer} on ${scanTimeStr}. Awaiting Store collection.`,
            scan: lastScan,
          });
        }
        if (lastScan && lastScan.scan_stage === 'STORE_INWARD') {
          await conn.rollback();
          return res.status(200).json({
            duplicate: true,
            code: 'ALREADY_SCANNED',
            message: `PO ${docLot} is already collected and sitting in Store. Awaiting Supervisor verification.`,
            scan: lastScan,
          });
        }

        // If no previous scans, OR last scan was a partial supervisor pickup: ALLOW GATE SCAN!
        scanStage = 'GATE_INWARD';
        status = (parsed.status === 'completed') ? 'completed' : 'pending';
      }

      // Rule 3: Store Scanning (Step 2/3 - Collect Parcel from Gate)
      if (isStoreScan) {
        if (!lastScan || lastScan.scan_stage !== 'GATE_INWARD') {
          await conn.rollback();
          if (!lastScan) {
            return res.status(400).json({
              error: `Material ${docLot} has not arrived at the Gate. Gate Security must record entry first before Store can collect it.`,
              code: 'GATE_ENTRY_REQUIRED',
            });
          }
          if (lastScan.scan_stage === 'STORE_INWARD') {
            return res.status(200).json({
              duplicate: true,
              code: 'ALREADY_SCANNED',
              message: `Parcel ${docLot} was already collected by Store (${lastScan.scannedByName}). Ready for handover to Supervisor.`,
              scan: lastScan,
            });
          }
          return res.status(400).json({
            error: `Previous batch of ${docLot} was already inwarded. Waiting for next shipment to arrive at Gate.`,
            code: 'GATE_ENTRY_REQUIRED',
          });
        }

        scanStage = 'STORE_INWARD';
        status = lastScan.status || 'pending';
      }

      // Rule 4: Supervisor Scanning (Step 3/3 - Bill verification & Final Handover)
      if (isSupervisorScan) {
        if (!lastScan || lastScan.scan_stage !== 'STORE_INWARD') {
          await conn.rollback();
          if (!lastScan) {
            return res.status(400).json({
              error: `Material ${docLot} has not arrived at the Gate. Gate Security must record entry first.`,
              code: 'GATE_ENTRY_REQUIRED',
            });
          }
          if (lastScan.scan_stage === 'GATE_INWARD') {
            return res.status(400).json({
              error: `Parcel ${docLot} is currently at the Gate. Store person must collect and scan it first before Supervisor handover.`,
              code: 'STORE_COLLECTION_REQUIRED',
            });
          }
          return res.status(400).json({
            error: `Previous batch of ${docLot} was already received. Waiting for next shipment.`,
            code: 'GATE_ENTRY_REQUIRED',
          });
        }

        scanStage = 'SUPERVISOR_PICKUP';
        // If Gate marked pending OR supervisor marked pending -> Partial pickup (Half Received)
        if (lastScan.status === 'pending' || parsed.status === 'pending') {
          status = 'pending';
        } else {
          status = 'completed';
        }
      }
    }

    // =========================================================================
    // 4. RESCAN NOTIFICATION CHECK (Completed lots re-scanned by general users)
    // =========================================================================
    if (material && !isSupervisorScan) {
      const [done] = await conn.query(
        "SELECT scanned_by FROM scans_app WHERE material_id = ? AND (status = 'completed' OR status = 'Closed') ORDER BY created_at ASC, id ASC LIMIT 1",
        [material.id]
      );
      if (done.length) {
        rescanned = true;
        const [admins] = await conn.query("SELECT id FROM user_app WHERE role = 'admin' AND is_active = 1");
        rescanTargets = [...new Set([done[0].scanned_by, ...admins.map(a => a.id)])].filter(id => id !== me.id);
      }
    }

    // =========================================================================
    // 5. INSERT SCAN & UPDATE MATERIAL / PO / RGP STATUS
    // =========================================================================
    let materialId;
    let effectiveAppStatus = 'pending';
    if (isSupervisorScan) {
      effectiveAppStatus = (status === 'completed') ? 'Closed' : 'partially_received';
    } else if (isStoreScan) {
      effectiveAppStatus = 'in_store';
    } else if (isGateScan) {
      effectiveAppStatus = (status === 'pending') ? 'pending' : 'in_progress';
    } else {
      effectiveAppStatus = (status === 'completed') ? 'completed' : status;
    }

    if (!material) {
      const [mr] = await conn.query(
        'INSERT INTO materials_app (lot_number, material_name, status) VALUES (?,?,?)',
        [docLot, materialName || 'Unnamed material', effectiveAppStatus]
      );
      materialId = mr.insertId;
    } else {
      materialId = material.id;
      await conn.query(
        'UPDATE materials_app SET status = ?, scan_count = scan_count + 1, last_scanned_by = ?, last_scanned_at = NOW() WHERE id = ?',
        [effectiveAppStatus, me.id, materialId]
      );
    }

    const defaultNote = isRgp
      ? (scanStage === 'GATE_OUT' ? '[GATE OUT] Dispatched from factory gate' :
         scanStage === 'GATE_IN' ? (status === 'pending' ? '[GATE IN - PARTIAL] Returned half/partial to factory gate' : '[GATE IN - COMPLETE] Returned complete to factory gate') :
         (status === 'pending' ? '[SUPERVISOR INWARD - PARTIAL] Half/partial return verified by supervisor' : '[SUPERVISOR INWARD - FINAL] Material verified & RGP closed'))
      : (scanStage === 'GATE_INWARD' ? (status === 'pending' ? '[GATE ENTRY - PARTIAL] Half/partial material arrived at gate' : '[GATE ENTRY - COMPLETE] Full material arrived at gate') :
         scanStage === 'STORE_INWARD' ? `[STORE INWARD] Parcel collected from gate by Store (${me.name})` :
         scanStage === 'SUPERVISOR_PICKUP' ? (status === 'pending' ? '[SUPERVISOR PICKUP - PARTIAL] Half/partial material verified & received' : '[SUPERVISOR PICKUP - FINAL] Complete material verified & PO Closed') :
         null);

    eventId = isGateScan
      ? `EVT-GATE-${Date.now()}-${docLot}`
      : (isStoreScan ? `EVT-STORE-${Date.now()}-${docLot}` : `EVT-SUP-${Date.now()}-${docLot}`);

    const [sr] = await conn.query(
      'INSERT INTO scans_app (material_id, lot_number, event_id, scanned_by, status, delivery_status, scan_stage, note) VALUES (?,?,?,?,?,?,?,?)',
      [materialId, docLot, eventId, me.id, status, 'pending', scanStage || null, note || defaultNote]
    );
    scanId = sr.insertId;

    // Fetch vendor/supplier name & lot number for enriched notification payload
    let poVendor = 'Supplier';
    let lotNumberDisplay = docLot;
    try {
      const [poRows] = await conn.query(
        'SELECT vendor_name, design_name FROM purchase_orders_app WHERE po_number = ? OR po_number = ? LIMIT 1',
        [docLot, docLot.replace(/^PO-/, '')]
      );
      if (poRows.length) {
        if (poRows[0].vendor_name) poVendor = poRows[0].vendor_name;
        if (poRows[0].design_name) lotNumberDisplay = poRows[0].design_name;
      }
    } catch {}

    try {
      const [mainPo] = await conn.query(
        'SELECT vendorName, designName FROM purchase_orders WHERE poNumber = ? OR poNumber = ? OR id = ? LIMIT 1',
        [docLot, docLot.replace(/^PO-/, ''), docLot.replace(/[^0-9]/g, '')]
      );
      if (mainPo.length) {
        if (mainPo[0].vendorName) poVendor = mainPo[0].vendorName;
        if (mainPo[0].designName) lotNumberDisplay = mainPo[0].designName;
      }
    } catch {}

    if (lotNumberDisplay === docLot) {
      try {
        const [oldPo] = await conn.query(
          'SELECT supplier, lot_no FROM old_purchase_orders WHERE po_number = ? OR po_number = ? LIMIT 1',
          [docLot, docLot.replace(/^PO-/, '')]
        );
        if (oldPo.length) {
          if (oldPo[0].supplier) poVendor = oldPo[0].supplier;
          if (oldPo[0].lot_no) lotNumberDisplay = oldPo[0].lot_no;
        }
      } catch {}
    }

    // Sync PO status in purchase_orders & purchase_orders_app
    if (!isRgp && isPoPattern && !isZip && !isDoori) {
      const cleanPo = docLot.startsWith('PO-') ? docLot : `PO-${docLot}`;
      const rawPo = cleanPo.replace(/^PO-/, '');
      let poStatus = 'At Gate';
      if (isSupervisorScan) {
        poStatus = (status === 'completed') ? 'Closed' : 'Half Received';
      } else if (isStoreScan) {
        poStatus = 'In Store';
      } else if (isGateScan) {
        poStatus = (status === 'pending') ? 'At Gate (Half/Partial)' : 'At Gate (Complete)';
      }

      await conn.query(
        "UPDATE purchase_orders_app SET status = ? WHERE (po_number = ? OR po_number = ?) AND status != 'Cancelled'",
        [poStatus, cleanPo, rawPo]
      ).catch(() => {});
      // Preserving Project 1 purchase_orders table untouched
    }

    // Sync Zip table status
    if (isZip) {
      const cleanZipNum = upperLot.replace(/^ZIP[-/]?/i, '');
      if (isGateScan) {
        await conn.query(
          `UPDATE zip SET Gate_Entry_Person = ?, Gate_Entry_Date = NOW(), status = 'At Gate'
           WHERE po_number IN (?, ?) OR Lot_Number IN (?, ?)`,
          [me.name || 'Gate Security', docLot, `ZIP-${cleanZipNum}`, cleanZipNum, docLot]
        ).catch(() => {});
      } else if (isSupervisorScan) {
        await conn.query(
          `UPDATE zip SET Material_Received_By = ?, Material_Received_Date = NOW(), status = 'Received'
           WHERE po_number IN (?, ?) OR Lot_Number IN (?, ?)`,
          [me.name || 'Supervisor', docLot, `ZIP-${cleanZipNum}`, cleanZipNum, docLot]
        ).catch(() => {});
      }
    }

    // Sync Doori table status
    if (isDoori) {
      const cleanDooriNum = upperLot.replace(/^(DOORI|DORI)[-/]?/i, '');
      if (isGateScan) {
        await conn.query(
          `UPDATE doori SET Gate_Entry_Person = ?, Gate_Entry_Date = NOW(), status = 'At Gate'
           WHERE po_number IN (?, ?, ?) OR Lot_Number IN (?, ?)`,
          [me.name || 'Gate Security', docLot, `DORI-${cleanDooriNum}`, `DOORI-${cleanDooriNum}`, cleanDooriNum, docLot]
        ).catch(() => {});
      } else if (isSupervisorScan) {
        await conn.query(
          `UPDATE doori SET Material_Received_By = ?, Material_Received_Date = NOW(), status = 'Received'
           WHERE po_number IN (?, ?, ?) OR Lot_Number IN (?, ?)`,
          [me.name || 'Supervisor', docLot, `DORI-${cleanDooriNum}`, `DOORI-${cleanDooriNum}`, cleanDooriNum, docLot]
        ).catch(() => {});
      }
    }

    // Sync RGP status in rgp table
    if (isRgp) {
      let rgpDbStatus = 'Gate Out';
      if (scanStage === 'SUPERVISOR_INWARD') {
        rgpDbStatus = (status === 'completed') ? 'Closed' : 'Half Received';
      } else if (scanStage === 'GATE_IN') {
        rgpDbStatus = (status === 'pending') ? 'At Gate (Half/Partial Return)' : 'At Gate (Complete Return)';
      }
      // Preserving Project 1 rgp table untouched
    }

    await conn.commit();
    binarySearchService.notifyDataUpdated();

    // =========================================================================
    // 6. AUDIT LOG & NOTIFICATIONS
    // =========================================================================
    const auditEvent = isSupervisorScan
      ? (status === 'completed' ? 'SUPERVISOR_PICKUP_CLOSED' : 'SUPERVISOR_PICKUP_PARTIAL')
      : (isGateScan ? (status === 'pending' ? 'GATE_SCAN_PARTIAL' : 'GATE_SCAN_COMPLETE') : (isRgp ? `RGP_${scanStage}` : 'SCAN_LOGGED'));

    await logAudit({
      eventType: auditEvent,
      lotNumber: docLot,
      userId: me.id,
      userName: me.name,
      userRole: me.role,
      ipAddress: clientIp,
      details: { scanId, materialId, materialName, status, note, scanStage, rescanned },
    });

    // Lookup Assigned Supervisor for targeted alarm & notification routing
    let assignedSupervisorName = null;
    try {
      const cleanDigits = docLot.replace(/[^0-9]/g, '');
      const [supRow] = await pool.query(
        "SELECT supervisor FROM supervisor_details_app WHERE lot_number IN (?, ?, ?) LIMIT 1",
        [cleanDigits, docLot, docLot.replace(/^PO-/, '')]
      );
      if (supRow.length && supRow[0].supervisor) {
        assignedSupervisorName = supRow[0].supervisor;
      }
    } catch {}

    const [allAdmins] = await pool.query(
      "SELECT id, name, role FROM user_app WHERE (role = 'admin' OR base_role = 'admin') AND is_active = 1"
    );

    // =========================================================================
    // DISPATCH NOTIFICATIONS FOR ALL SCAN STAGES (FCM + In-App)
    // =========================================================================
    if (scanStage === 'GATE_OUT') {
      // 1. RGP Stage 1: Gate Out Dispatch
      const notifTitle = `📤 RGP Material Dispatched (${docLot})`;
      const notifMessage = `${materialName || 'RGP'} (${docLot}) dispatched through Factory Gate by ${me.name}.`;

      // Real-time Emergency Alarm dispatched to all recipient panels
      sendGateScanNotification({
        eventId,
        billNumber: docLot,
        supplierName: poVendor,
        materialDetails: materialName || 'RGP Material',
        scannerName: me.name,
        scanTime: new Date().toISOString(),
        billId: materialId,
        title: notifTitle,
        message: notifMessage,
        source: 'Gate',
        isEmergencyAlarm: true,
      });

      const [sups] = await pool.query(
        "SELECT id, name, role FROM user_app WHERE (role = 'supervisor' OR base_role = 'supervisor') AND is_active = 1"
      );
      let targetSups = sups;
      if (assignedSupervisorName) {
        const supKey = assignedSupervisorName.trim().toLowerCase();
        const matched = sups.filter(s => (s.name || '').toLowerCase().includes(supKey) || supKey.includes((s.name || '').toLowerCase()));
        if (matched.length > 0) targetSups = matched;
      }

      const recipientMap = new Map();
      [...targetSups, ...allAdmins].forEach(u => recipientMap.set(u.id, u));
      const targets = Array.from(recipientMap.values());

      for (const target of targets) {
        await enqueueNotification({
          lotNumber: docLot,
          eventId,
          userId: target.id,
          targetRole: target.role,
          title: notifTitle,
          message: notifMessage,
          payload: { eventId, lotNumber: docLot, materialName, gateOfficerName: me.name, type: 'rgp_gate_out' },
        }).catch(() => {});
      }
      if (targets.length > 0) {
        sendPush(targets.map(s => s.id), notifTitle, notifMessage, { lotNumber: docLot, eventId, type: 'rgp_gate_out' });
      }

    } else if (isGateScan || scanStage === 'GATE_INWARD' || scanStage === 'GATE_IN') {
      // 2. PO Step 1 Gate Inward OR RGP Step 2 Gate In (Material Gate Par Aa Gya)
      const isPartial = status === 'pending';
      const isRgpItem = isRgp || scanStage === 'GATE_IN';
      const notifTitle = isRgpItem
        ? (isPartial ? `⚠️ Half Material Received in Gate (${docLot})` : `🚨 Successfully Received Material in Gate (${docLot})`)
        : (isPartial
            ? `⚠️ Half Material Received in Gate (${docLot})`
            : `🚨 Successfully Received Material in Gate (${docLot})`);

      const supNote = assignedSupervisorName ? ` | Assigned: ${assignedSupervisorName}` : '';
      const notifMessage = isRgpItem
        ? (isPartial
            ? `Half return material received in gate (Partial return). RGP No: ${docLot} | Scanned by ${me.name}. (Party: ${poVendor})${supNote}. Waiting for balance return.`
            : `Successfully received return material in gate. RGP No: ${docLot} | Scanned by ${me.name}. (Party: ${poVendor})${supNote}. Awaiting supervisor inward.`)
        : (isPartial
            ? `Half material received in gate (Partial delivery). PO No: ${docLot} | Lot No: ${lotNumberDisplay} | Scanned by ${me.name}. (Supplier: ${poVendor}, Material: ${materialName || 'Material'})${supNote}. Waiting for remaining delivery.`
            : `Successfully received material in gate. PO No: ${docLot} | Lot No: ${lotNumberDisplay} | Scanned by ${me.name}. (Supplier: ${poVendor}, Material: ${materialName || 'Material'})${supNote}. Ready for Store collection.`);

      // Real-time Socket.IO notification immediately delivered to Store Person and Supervisor
      sendGateScanNotification({
        eventId,
        billNumber: docLot,
        supplierName: poVendor,
        materialDetails: materialName || 'Material Lot',
        scannerName: me.name,
        scannerId: me.id,
        scanTime: new Date().toISOString(),
        billId: materialId,
        title: notifTitle,
        message: notifMessage,
        source: 'Gate',
        isEmergencyAlarm: true,
      });

      const [sups] = await pool.query(
        "SELECT id, name, role FROM user_app WHERE (role = 'supervisor' OR base_role = 'supervisor') AND is_active = 1 AND id != ?",
        [me.id]
      );
      let targetSups = sups;
      if (assignedSupervisorName) {
        const supKey = assignedSupervisorName.trim().toLowerCase();
        const matched = sups.filter(s => (s.name || '').toLowerCase().includes(supKey) || supKey.includes((s.name || '').toLowerCase()));
        if (matched.length > 0) targetSups = matched;
      }

      const [stores] = await pool.query(
        "SELECT id, name, role FROM user_app WHERE (role = 'store' OR base_role = 'store') AND is_active = 1 AND id != ?",
        [me.id]
      );

      const recipientMap = new Map();
      [...stores, ...targetSups, ...allAdmins].forEach(u => {
        if (u.id !== me.id) recipientMap.set(u.id, u);
      });
      const targets = Array.from(recipientMap.values());

      for (const target of targets) {
        await enqueueNotification({
          lotNumber: docLot,
          eventId,
          userId: target.id,
          targetRole: target.role,
          title: notifTitle,
          message: notifMessage,
          payload: {
            eventId,
            lotNumber: docLot,
            lotNo: lotNumberDisplay,
            materialName,
            supplierName: poVendor,
            verifiedStage: isPartial ? 'Gate Partial Verified' : 'Gate Full Verified',
            gateOfficerName: me.name,
            gateOfficerId: me.id,
            scanId,
            deliveryType: isPartial ? 'partial' : 'complete',
            type: 'MATERIAL_RECEIVED_AT_GATE',
            source: 'Gate',
          },
        }).catch(() => {});
      }

      if (targets.length > 0) {
        sendPush(targets.map(s => s.id), notifTitle, notifMessage, {
          lotNumber: docLot,
          eventId,
          type: 'gate_arrival',
          isEmergencyAlarm: true,
        });
      }

    } else if (isStoreScan || scanStage === 'STORE_INWARD') {
      // Step 2: Store Inward & Collection from Gate
      const supNote = assignedSupervisorName ? ` | Assigned: ${assignedSupervisorName}` : '';
      const storeTitle = `📦 Successfully Received Material in Store (${docLot})`;
      const storeMessage = `Successfully received material in store. PO No: ${docLot} | Lot No: ${lotNumberDisplay} | Received by Store Officer ${me.name}. (Supplier: ${poVendor}, Material: ${materialName || 'Material'})${supNote}. Please verify the bill.`;

      // Real-time Socket.IO notification immediately delivered to Supervisor
      sendStoreScanNotification({
        eventId,
        billNumber: docLot,
        supplierName: poVendor,
        materialDetails: materialName || 'Material Lot',
        scannerName: me.name,
        scannerId: me.id,
        scanTime: new Date().toISOString(),
        billId: materialId,
        gateOfficerName: lastScan ? lastScan.scannedByName : 'Gate Officer',
        title: storeTitle,
        message: storeMessage,
        isEmergencyAlarm: true,
      });

      const [sups] = await pool.query(
        "SELECT id, name, role FROM user_app WHERE (role = 'supervisor' OR base_role = 'supervisor') AND is_active = 1 AND id != ?",
        [me.id]
      );
      let targetSups = sups;
      if (assignedSupervisorName) {
        const supKey = assignedSupervisorName.trim().toLowerCase();
        const matched = sups.filter(s => (s.name || '').toLowerCase().includes(supKey) || supKey.includes((s.name || '').toLowerCase()));
        if (matched.length > 0) targetSups = matched;
      }

      const [gates] = await pool.query(
        "SELECT id, name, role FROM user_app WHERE (role = 'gate' OR base_role = 'gate') AND is_active = 1 AND id != ?",
        [me.id]
      );

      const recipientMap = new Map();
      [...targetSups, ...gates, ...allAdmins].forEach(u => {
        if (u.id !== me.id) recipientMap.set(u.id, u);
      });
      const targets = Array.from(recipientMap.values());

      for (const target of targets) {
        await enqueueNotification({
          lotNumber: docLot,
          eventId,
          userId: target.id,
          targetRole: target.role,
          title: storeTitle,
          message: storeMessage,
          payload: {
            eventId,
            lotNumber: docLot,
            lotNo: lotNumberDisplay,
            materialName,
            supplierName: poVendor,
            verifiedStage: 'Store Collected',
            storePersonName: me.name,
            storePersonId: me.id,
            scanId,
            type: 'STORE_SCANNED',
            source: 'Store',
          },
        }).catch(() => {});
      }

      if (targets.length > 0) {
        sendPush(targets.map(s => s.id), storeTitle, storeMessage, {
          lotNumber: docLot,
          eventId,
          type: 'store_inward',
          isEmergencyAlarm: true,
        });
      }

    } else if (isSupervisorScan || scanStage === 'SUPERVISOR_PICKUP' || scanStage === 'SUPERVISOR_INWARD') {
      // 3. Supervisor Step: PO Step 3 OR RGP Step 3
      await acknowledgeLot(docLot, me.id, me.name, me.role).catch(() => {});

      const isPartialReceipt = status === 'pending';
      const isRgpItem = isRgp || scanStage === 'SUPERVISOR_INWARD';

      const pickupTitle = isRgpItem
        ? (isPartialReceipt ? `📦 Supervisor Half Received RGP No: ${docLot}` : `✅ Supervisor Received RGP No: ${docLot}`)
        : (isPartialReceipt
            ? `📦 Supervisor Half Received PO No: ${docLot}`
            : `✅ Supervisor Received PO No: ${docLot}`);

      const pickupMessage = isRgpItem
        ? (isPartialReceipt
            ? `Supervisor half received RGP No: ${docLot}. Half return material verified by Supervisor ${me.name}. Waiting for balance return.`
            : `Supervisor received RGP No: ${docLot}. Complete return material verified & RGP officially CLOSED by Supervisor ${me.name}.`)
        : (isPartialReceipt
            ? `Supervisor half received PO No: ${docLot} | Lot No: ${lotNumberDisplay}. Half/partial delivery verified & received by Supervisor ${me.name}. Waiting for remaining delivery.`
            : `Supervisor received PO No: ${docLot} | Lot No: ${lotNumberDisplay}. Complete material verified & PO officially CLOSED by Supervisor ${me.name}.`);

      // Real-time Socket.IO notification to Gate, Store, and Admin
      sendSupervisorScanNotification({
        eventId,
        billNumber: docLot,
        scannerName: me.name,
        scannerId: me.id,
        scanTime: new Date().toISOString(),
        isClosed: !isPartialReceipt,
        materialDetails: materialName,
        title: pickupTitle,
        message: pickupMessage,
        isEmergencyAlarm: true,
      });

      const [gates] = await pool.query(
        "SELECT id, name, role FROM user_app WHERE (role = 'gate' OR base_role = 'gate') AND is_active = 1 AND id != ?",
        [me.id]
      );
      const [stores] = await pool.query(
        "SELECT id, name, role FROM user_app WHERE (role = 'store' OR base_role = 'store') AND is_active = 1 AND id != ?",
        [me.id]
      );

      const recipientMap = new Map();
      [...gates, ...stores, ...allAdmins].forEach(u => {
        if (u.id !== me.id) recipientMap.set(u.id, u);
      });
      const targets = Array.from(recipientMap.values());

      for (const target of targets) {
        await enqueueNotification({
          lotNumber: docLot,
          eventId,
          userId: target.id,
          targetRole: target.role,
          title: pickupTitle,
          message: pickupMessage,
          payload: {
            eventId,
            lotNumber: docLot,
            materialName,
            verifiedStage: isPartialReceipt ? 'Supervisor Half Received' : 'Supervisor Closed',
            supervisorName: me.name,
            supervisorId: me.id,
            scanId,
            receiptType: isPartialReceipt ? 'partial' : 'complete',
            type: 'supervisor_pickup',
            source: 'Supervisor',
          },
        }).catch(() => {});
      }

      if (targets.length > 0) {
        sendPush(targets.map((g) => g.id), pickupTitle, pickupMessage, {
          lotNumber: docLot,
          type: 'supervisor_pickup',
          isEmergencyAlarm: true,
        });
      }
    } else {
      // Fallback for ANY other scan (custom lot, raw materials, admin scan, etc.)
      // Guarantees that EVERY SINGLE SCAN triggers the emergency alarm and push notification!
      const genTitle = `🚨 Material Scanned (${docLot})`;
      const genMessage = `Material ${docLot} (${materialName || 'Material'}) was scanned by ${me.name}.`;

      sendGenericScanNotification({
        eventId,
        billNumber: docLot,
        scannerName: me.name,
        scanStage: scanStage || 'SCAN',
        materialDetails: materialName || 'Material Lot',
        title: genTitle,
        message: genMessage,
        source: me.role === 'gate' ? 'Gate' : (me.role === 'store' ? 'Store' : 'Supervisor'),
        isEmergencyAlarm: true,
      });

      const [otherUsers] = await pool.query(
        "SELECT id, name, role FROM user_app WHERE is_active = 1 AND id != ?",
        [me.id]
      );
      for (const target of otherUsers) {
        await enqueueNotification({
          lotNumber: docLot,
          eventId,
          userId: target.id,
          targetRole: target.role,
          title: genTitle,
          message: genMessage,
          payload: {
            eventId,
            lotNumber: docLot,
            materialName,
            scannerName: me.name,
            scanId,
            type: 'material_scan',
          },
        }).catch(() => {});
      }
      if (otherUsers.length > 0) {
        sendPush(otherUsers.map(u => u.id), genTitle, genMessage, { lotNumber: docLot, eventId, type: 'scan' });
      }
    }

    if (rescanned && rescanTargets.length) {
      const rescanTitle = 'Lot scanned again';
      const rescanMsg = `Lot ${docLot} has been scanned again by ${me.name}`;
      await pool.query(
        'INSERT INTO notifications_app (user_id, title, message, lot_number) VALUES ?',
        [rescanTargets.map(id => [id, rescanTitle, rescanMsg, docLot])]
      ).catch(() => {});
      sendPush(rescanTargets, rescanTitle, rescanMsg, { lotNumber: docLot, type: 'rescan' });
    }

  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  const [rows] = await pool.query(`${SELECT} WHERE s.id = ?`, [scanId]);
  return res.status(201).json({
    scan: rows[0],
    eventId,
    duplicate: false,
    rescanned,
    stage: scanStage,
    closed: scanStage === 'SUPERVISOR_PICKUP' || scanStage === 'SUPERVISOR_INWARD',
    message: `Scan successfully recorded for ${docLot}.`,
  });
}));

/**
 * GET /scans/tracking-summary
 * Live tracking data for all POs and RGPs
 */
router.get('/tracking-summary', wrap(async (req, res) => {
  let pos = [];
  try {
    const [p1] = await pool.query(
      `SELECT id, poNumber AS po_number, vendorName AS vendor_name, designName AS design_name,
              designCategory AS design_category, items, status, date,
              supervisorName AS supervisor_name, preparedBy AS prepared_by,
              requisitionRaisedBy AS requisition_raised_by
       FROM purchase_orders ORDER BY id DESC LIMIT 100`
    );
    pos = p1;
  } catch {}
  if (!pos.length) {
    try {
      const [p2] = await pool.query(
        `SELECT id, po_number, vendor_name, design_name, items, status, created_at AS date,
                supervisor AS supervisor_name
         FROM purchase_orders_app ORDER BY id DESC LIMIT 100`
      );
      pos = p2;
    } catch {}
  }

  let rgps = [];
  try {
    const [r1] = await pool.query(
      `SELECT id, rgpNo, vendor, rgpType, department, purpose, expectedReturnDate,
              vehicleNo, entries, status, date, createdAt, preparedBy, authorizedBy
       FROM rgp ORDER BY id DESC LIMIT 100`
    );
    rgps = r1;
  } catch (err) {
    console.error('Error fetching rgp in tracking-summary:', err.message);
  }

  // Also fetch recent entries from old_rgp table
  try {
    const [rOld] = await pool.query(
      `SELECT rgp_no, date, rgp_type, department, vendor, purpose,
              item_description, quantity_sent, uom, expected_return_date,
              vehicle_no, authorized_by, prepared_by, status, items_json
       FROM old_rgp ORDER BY rgp_no DESC LIMIT 60`
    );
    const existingRgpNos = new Set(rgps.map(r => (r.rgpNo || '').toUpperCase()));
    for (const o of rOld) {
      const oNum = (o.rgp_no || '').toUpperCase();
      if (!existingRgpNos.has(oNum)) {
        existingRgpNos.add(oNum);
        let entries = [];
        try {
          if (o.items_json) {
            const parsed = typeof o.items_json === 'string' ? JSON.parse(o.items_json) : o.items_json;
            if (Array.isArray(parsed) && parsed.length) {
              entries = parsed.map(it => ({
                lotNo: it['Lot No'] || 'N/A',
                itemDesc: it['Description'] || o.item_description || 'Item',
                qty1: Number(it['Qty1'] || o.quantity_sent || 1),
                qty2: Number(it['Qty2'] || 0),
                uom: it['UOM'] || o.uom || 'PCS',
                department: it['Department'] || o.department,
                purpose: it['Purpose'] || o.purpose,
              }));
            }
          }
        } catch {}
        if (!entries.length) {
          entries = [{
            lotNo: 'N/A',
            itemDesc: o.item_description || o.purpose || 'Item',
            qty1: Number(o.quantity_sent) || 1,
            qty2: 0,
            uom: o.uom || 'PCS',
            department: o.department,
            purpose: o.purpose,
          }];
        }
        rgps.push({
          id: o.rgp_no,
          rgpNo: o.rgp_no,
          vendor: o.vendor,
          rgpType: o.rgp_type,
          department: o.department,
          purpose: o.purpose,
          expectedReturnDate: o.expected_return_date,
          vehicleNo: o.vehicle_no || '',
          entries,
          status: o.status,
          date: o.date,
          createdAt: o.date,
          preparedBy: o.prepared_by,
          authorizedBy: o.authorized_by,
          isOldRgp: true,
        });
      }
    }
  } catch (err) {
    console.error('Error fetching old_rgp in tracking-summary:', err.message);
  }

  // Fetch recent Zip orders (Live & Old)
  try {
    const [zRows] = await pool.query(
      `SELECT id, COALESCE(po_number, CONCAT('ZIP-', Lot_Number)) AS po_number,
              Supplier_Name AS vendor_name, Style AS design_name,
              'ZIP' AS design_category, Total_Pieces AS total_quantity,
              Issue_Date AS date, Supervisor AS supervisor_name,
              status, Lot_Number, Gate_Entry_Person, Gate_Entry_Date,
              Material_Received_By, Material_Received_Date
       FROM zip ORDER BY id DESC LIMIT 50`
    );
    for (const z of zRows) {
      pos.push({
        id: `ZIP-${z.id}`,
        po_number: z.po_number,
        vendor_name: z.vendor_name || 'Zip Supplier',
        design_name: z.design_name || `Zip Lot ${z.Lot_Number}`,
        design_category: 'ZIP',
        items: JSON.stringify([{ name: z.design_name || 'Zip', qty: z.total_quantity || 1, unit: 'PCS' }]),
        status: z.status || (z.Material_Received_Date ? 'Received' : (z.Gate_Entry_Date ? 'At Gate' : 'Pending')),
        date: z.date,
        supervisor_name: z.supervisor_name || 'Supervisor',
        subType: 'ZIP',
        lot_number: z.Lot_Number,
        gate_person: z.Gate_Entry_Person,
        gate_date: z.Gate_Entry_Date,
        received_by: z.Material_Received_By,
        received_date: z.Material_Received_Date,
      });
    }
  } catch (err) {
    console.error('Error fetching zip in tracking-summary:', err.message);
  }

  // Fetch recent Doori orders (Live & Old)
  try {
    const [dRows] = await pool.query(
      `SELECT id, COALESCE(po_number, CONCAT('DORI-', Lot_Number)) AS po_number,
              Supplier_Name AS vendor_name, Style AS design_name,
              'DORI' AS design_category, Total_Pieces AS total_quantity,
              Issue_Date AS date, Supervisor AS supervisor_name,
              status, Lot_Number, Gate_Entry_Person, Gate_Entry_Date,
              Material_Received_By, Material_Received_Date
       FROM doori ORDER BY id DESC LIMIT 50`
    );
    for (const d of dRows) {
      pos.push({
        id: `DORI-${d.id}`,
        po_number: d.po_number,
        vendor_name: d.vendor_name || 'Doori Supplier',
        design_name: d.design_name || `Doori Lot ${d.Lot_Number}`,
        design_category: 'DORI',
        items: JSON.stringify([{ name: d.design_name || 'Doori', qty: d.total_quantity || 1, unit: 'PCS' }]),
        status: d.status || (d.Material_Received_Date ? 'Received' : (d.Gate_Entry_Date ? 'At Gate' : 'Pending')),
        date: d.date,
        supervisor_name: d.supervisor_name || 'Supervisor',
        subType: 'DORI',
        lot_number: d.Lot_Number,
        gate_person: d.Gate_Entry_Person,
        gate_date: d.Gate_Entry_Date,
        received_by: d.Material_Received_By,
        received_date: d.Material_Received_Date,
      });
    }
  } catch (err) {
    console.error('Error fetching doori in tracking-summary:', err.message);
  }

  const [allScans] = await pool.query(
    `SELECT s.id, s.lot_number AS lotNumber, s.scan_stage AS scanStage, s.status, s.note,
            s.event_id AS eventId, s.delivery_status AS deliveryStatus,
            s.delivered_at AS deliveredAt, s.acknowledged_at AS acknowledgedAt,
            s.acknowledged_by_name AS acknowledgedByName,
            s.created_at AS createdAt, s.scanned_by AS scannedById, COALESCE(u.name, 'Officer') AS scannedByName, u.role AS scannedByRole
     FROM scans_app s LEFT JOIN user_app u ON u.id = s.scanned_by ORDER BY s.id ASC`
  );

  const scansByLot = {};
  for (const scan of allScans) {
    const key = (scan.lotNumber || '').toUpperCase();
    if (!scansByLot[key]) scansByLot[key] = [];
    scansByLot[key].push(scan);

    const rawKey = key.replace(/^(PO-|RGP[-/]?)/, '');
    if (rawKey && rawKey !== key) {
      if (!scansByLot[rawKey]) scansByLot[rawKey] = [];
      scansByLot[rawKey].push(scan);
    }
    const digitsOnly = key.replace(/[^0-9]/g, '');
    if (digitsOnly && digitsOnly !== key && digitsOnly !== rawKey) {
      if (!scansByLot[digitsOnly]) scansByLot[digitsOnly] = [];
      scansByLot[digitsOnly].push(scan);
    }
  }

  const poItems = pos.map((po) => {
    const poNum = po.po_number || `PO-${po.id}`;
    const cleanNum = poNum.toUpperCase();
    const rawNum = cleanNum.replace(/^PO-/, '');
    const lotScans = scansByLot[cleanNum] || scansByLot[rawNum] || [];

    const gateInwardScan = lotScans.find(
      s => s.scanStage === 'GATE_INWARD' || (s.note && s.note.includes('[GATE ENTRY]')) || s.status === 'pending'
    );
    const storeScan = lotScans.find(
      s => s.scanStage === 'STORE_INWARD' || (s.note && s.note.includes('[STORE INWARD]'))
    );
    const supervisorScan = lotScans.find(
      s => s.scanStage === 'SUPERVISOR_PICKUP' || (s.note && s.note.includes('[SUPERVISOR PICKUP]')) || s.status === 'completed'
    );

    const lastScan = lotScans[lotScans.length - 1] || null;
    const hasFinalClosed = lotScans.some(
      s => s.scanStage === 'SUPERVISOR_PICKUP' && (s.status === 'completed' || (s.note && s.note.includes('FINAL')))
    );

    let currentStage = 'GENERATED';
    let statusDisplay = 'Open';
    let progressPercent = 10;
    let currentStep = 0;

    if (hasFinalClosed || po.received_date || po.received_by || po.status === 'Received') {
      currentStage = 'CLOSED';
      statusDisplay = 'Closed';
      progressPercent = 100;
      currentStep = 3;
    } else if (lastScan && (lastScan.scanStage === 'STORE_INWARD' || (lastScan.note && lastScan.note.includes('[STORE INWARD]')))) {
      currentStage = 'AT_STORE';
      statusDisplay = 'In Store (Awaiting Supervisor)';
      progressPercent = 66;
      currentStep = 2;
    } else if ((lastScan && (lastScan.scanStage === 'GATE_INWARD' || (lastScan.note && lastScan.note.includes('[GATE ENTRY]')))) || po.gate_date || po.gate_person || po.status === 'At Gate') {
      currentStage = 'AT_GATE';
      statusDisplay = (lastScan && lastScan.status === 'pending') ? 'At Gate (Half/Partial)' : 'At Gate (Complete)';
      progressPercent = 33;
      currentStep = 1;
    } else if (lastScan && lastScan.scanStage === 'SUPERVISOR_PICKUP') {
      currentStage = 'PARTIAL_RECEIVED';
      statusDisplay = 'Half Received';
      progressPercent = 50;
      currentStep = 2;
    }

    let totalQty = 0;
    let unit = 'PCS';
    let itemsCount = 0;
    if (po.items) {
      try {
        const parsedItems = typeof po.items === 'string' ? JSON.parse(po.items) : po.items;
        if (Array.isArray(parsedItems)) {
          itemsCount = parsedItems.length;
          totalQty = parsedItems.reduce((acc, it) => acc + (Number(it.qty) || 0), 0);
          if (parsedItems[0] && parsedItems[0].unit) unit = parsedItems[0].unit;
        }
      } catch {}
    }

    return {
      id: `po-${po.id}`,
      docType: 'PO',
      poNumber: poNum,
      lotNumber: poNum,
      vendor: po.vendor_name || 'Vendor',
      designName: po.design_name || '',
      designCategory: po.design_category || '',
      supervisor: po.supervisor_name || '',
      supervisorName: po.supervisor_name || '',
      requestedBy: po.prepared_by ? `${po.prepared_by}${po.requisition_raised_by ? ` (Requisition: ${po.requisition_raised_by})` : ''}` : (po.requisition_raised_by || ''),
      date: po.date,
      status: statusDisplay,
      currentStage,
      totalStages: 3,
      currentStep,
      progressPercent,
      totalQuantity: totalQty || 1,
      unit,
      itemsCount,
      subType: po.subType || 'PO',
      gateInwardScan: gateInwardScan
        ? {
            officer: gateInwardScan.scannedByName,
            time: gateInwardScan.createdAt,
            note: gateInwardScan.note,
            status: gateInwardScan.status,
            eventId: gateInwardScan.eventId,
            deliveryStatus: gateInwardScan.deliveryStatus,
            deliveredAt: gateInwardScan.deliveredAt,
            acknowledgedAt: gateInwardScan.acknowledgedAt,
            acknowledgedByName: gateInwardScan.acknowledgedByName,
          }
        : (po.gate_person || po.gate_date ? {
            officer: po.gate_person || 'Gate Security',
            time: po.gate_date || po.date,
            note: 'Gate entry recorded in system',
            status: 'completed',
          } : null),
      storeScan: storeScan
        ? {
            officer: storeScan.scannedByName,
            time: storeScan.createdAt,
            note: storeScan.note,
            status: storeScan.status,
            eventId: storeScan.eventId,
          }
        : null,
      supervisorScan: supervisorScan
        ? {
            officer: supervisorScan.scannedByName,
            time: supervisorScan.createdAt,
            note: supervisorScan.note,
            status: supervisorScan.status,
            eventId: supervisorScan.eventId,
            deliveryStatus: supervisorScan.deliveryStatus,
            deliveredAt: supervisorScan.deliveredAt,
            acknowledgedAt: supervisorScan.acknowledgedAt,
            acknowledgedByName: supervisorScan.acknowledgedByName,
          }
        : (po.received_by || po.received_date ? {
            officer: po.received_by || po.supervisor_name || 'Supervisor',
            time: po.received_date,
            note: 'Material received and verified in warehouse',
            status: 'completed',
          } : null),
      historyCount: lotScans.length,
    };
  });

  const rgpItems = rgps.map((rgp) => {
    const rgpNo = (rgp.rgpNo || `RGP-${rgp.id}`).toUpperCase();
    const rawNum = rgpNo.replace(/^(RGP[-/]?)/, '');
    const cleanDigits = rgpNo.replace(/[^0-9]/g, '');
    const lotScans = scansByLot[rgpNo] || scansByLot[rawNum] || scansByLot[cleanDigits] || [];

    const gateOutScan = lotScans.find(s => s.scanStage === 'GATE_OUT' || (s.note && s.note.includes('[GATE OUT]')));
    const gateInScan = lotScans.find(s => s.scanStage === 'GATE_IN' || (s.note && s.note.includes('[GATE IN]')));
    const supervisorScan = lotScans.find(s => s.scanStage === 'SUPERVISOR_INWARD' || (s.note && s.note.includes('[SUPERVISOR INWARD]')));

    const lastRgpScan = lotScans[lotScans.length - 1] || null;
    const hasFinalRgpClosed = lotScans.some(
      s => s.scanStage === 'SUPERVISOR_INWARD' && (s.status === 'completed' || (s.note && s.note.includes('FINAL')))
    );

    let currentStage = 'GENERATED';
    let statusDisplay = 'Open';
    let progressPercent = 10;
    let currentStep = 0;

    if (hasFinalRgpClosed) {
      currentStage = 'CLOSED';
      statusDisplay = 'Closed';
      progressPercent = 100;
      currentStep = 3;
    } else if (lastRgpScan && lastRgpScan.scanStage === 'GATE_IN') {
      currentStage = 'GATE_IN';
      statusDisplay = lastRgpScan.status === 'pending' ? 'At Gate (Half/Partial Return)' : 'At Gate (Complete Return)';
      progressPercent = lastRgpScan.status === 'pending' ? 60 : 80;
      currentStep = 2;
    } else if (lastRgpScan && lastRgpScan.scanStage === 'SUPERVISOR_INWARD') {
      currentStage = 'PARTIAL_RECEIVED';
      statusDisplay = 'Half Received (Partial Return)';
      progressPercent = 50;
      currentStep = 2;
    } else if (lastRgpScan && lastRgpScan.scanStage === 'GATE_OUT') {
      currentStage = 'GATE_OUT';
      statusDisplay = 'Gate Out';
      progressPercent = 33;
      currentStep = 1;
    }

    let totalQty = 0;
    let unit = 'PCS';
    let itemsCount = 0;
    if (rgp.entries) {
      try {
        const ents = typeof rgp.entries === 'string' ? JSON.parse(rgp.entries) : rgp.entries;
        if (Array.isArray(ents)) {
          itemsCount = ents.length;
          totalQty = ents.reduce((acc, it) => acc + (Number(it.qty1) || Number(it.qty2) || 0), 0);
          if (ents[0] && ents[0].uom) unit = ents[0].uom;
        }
      } catch {}
    }

    return {
      id: `rgp-${rgp.id}`,
      docType: 'RGP',
      rgpNumber: rgpNo,
      lotNumber: rgpNo,
      vendor: rgp.vendor || 'Vendor',
      purpose: rgp.purpose || 'Job Work',
      department: rgp.department || '',
      vehicleNo: rgp.vehicleNo || '',
      date: rgp.date,
      expectedReturnDate: rgp.expectedReturnDate,
      isOldRgp: Boolean(rgp.isOldRgp),
      status: currentStage === 'CLOSED' ? 'Closed' : (currentStage === 'GATE_IN' ? 'At Gate' : (currentStage === 'GATE_OUT' ? 'Gate Out' : 'Open')),
      currentStage,
      totalStages: 3,
      currentStep: currentStage === 'CLOSED' ? 3 : (currentStage === 'GATE_IN' ? 2 : (currentStage === 'GATE_OUT' ? 1 : 0)),
      progressPercent: currentStage === 'CLOSED' ? 100 : (currentStage === 'GATE_IN' ? 66 : (currentStage === 'GATE_OUT' ? 33 : 10)),
      totalQuantity: totalQty || 1,
      unit,
      itemsCount,
      gateOutScan: gateOutScan
        ? {
            officer: gateOutScan.scannedByName,
            time: gateOutScan.createdAt,
            note: gateOutScan.note,
            status: gateOutScan.status,
            eventId: gateOutScan.eventId,
            deliveryStatus: gateOutScan.deliveryStatus,
            deliveredAt: gateOutScan.deliveredAt,
            acknowledgedAt: gateOutScan.acknowledgedAt,
            acknowledgedByName: gateOutScan.acknowledgedByName,
          }
        : null,
      gateInScan: gateInScan
        ? {
            officer: gateInScan.scannedByName,
            time: gateInScan.createdAt,
            note: gateInScan.note,
            status: gateInScan.status,
            eventId: gateInScan.eventId,
            deliveryStatus: gateInScan.deliveryStatus,
            deliveredAt: gateInScan.deliveredAt,
            acknowledgedAt: gateInScan.acknowledgedAt,
            acknowledgedByName: gateInScan.acknowledgedByName,
          }
        : null,
      supervisorScan: supervisorScan
        ? {
            officer: supervisorScan.scannedByName,
            time: supervisorScan.createdAt,
            note: supervisorScan.note,
            status: supervisorScan.status,
            eventId: supervisorScan.eventId,
            deliveryStatus: supervisorScan.deliveryStatus,
            deliveredAt: supervisorScan.deliveredAt,
            acknowledgedAt: supervisorScan.acknowledgedAt,
            acknowledgedByName: supervisorScan.acknowledgedByName,
          }
        : null,
      historyCount: lotScans.length,
    };
  });

  res.json({
    pos: poItems,
    rgps: rgpItems,
    totalPos: poItems.length,
    totalRgps: rgpItems.length,
    activePos: poItems.filter(p => p.currentStage !== 'CLOSED').length,
    closedPos: poItems.filter(p => p.currentStage === 'CLOSED').length,
    activeRgps: rgpItems.filter(r => r.currentStage !== 'CLOSED').length,
    closedRgps: rgpItems.filter(r => r.currentStage === 'CLOSED').length,
  });
}));

/**
 * POST /scans/close-po
 */
router.post('/close-po', requireRole('admin'), wrap(async (req, res) => {
  const { poNumber, reason } = req.body;
  if (!poNumber) return res.status(400).json({ error: 'poNumber is required' });

  const cleanPo = poNumber.toUpperCase().startsWith('PO-') ? poNumber.toUpperCase() : `PO-${poNumber.toUpperCase()}`;
  const rawPo = cleanPo.replace(/^PO-/, '');

  await pool.query("UPDATE purchase_orders SET status = 'Closed' WHERE poNumber = ? OR poNumber = ?", [cleanPo, rawPo]);
  await pool.query("UPDATE purchase_orders_app SET status = 'Closed' WHERE po_number = ? OR po_number = ?", [cleanPo, rawPo]).catch(() => {});
  await pool.query("UPDATE materials_app SET status = 'Closed' WHERE lot_number = ? OR lot_number = ?", [cleanPo, rawPo]).catch(() => {});

  await logAudit({
    eventType: 'MANUAL_PO_CLOSED',
    lotNumber: cleanPo,
    userId: req.user.id,
    userName: req.user.name,
    userRole: req.user.role,
    details: { reason: reason || 'Manual Admin Closure' },
  });

  res.json({ success: true, message: `PO ${cleanPo} successfully closed.` });
}));

/**
 * POST /scans/close-rgp
 */
router.post('/close-rgp', requireRole('admin'), wrap(async (req, res) => {
  const { rgpNo, reason } = req.body;
  if (!rgpNo) return res.status(400).json({ error: 'rgpNo is required' });

  const cleanRgp = rgpNo.toUpperCase().startsWith('RGP-') ? rgpNo.toUpperCase() : `RGP-${rgpNo.toUpperCase()}`;
  const rawRgp = cleanRgp.replace(/^RGP-/, '');

  await pool.query("UPDATE rgp SET status = 'Closed' WHERE rgpNo = ? OR rgpNo = ?", [cleanRgp, rawRgp]);
  await pool.query("UPDATE materials_app SET status = 'Closed' WHERE lot_number = ? OR lot_number = ?", [cleanRgp, rawRgp]).catch(() => {});

  await logAudit({
    eventType: 'MANUAL_RGP_CLOSED',
    lotNumber: cleanRgp,
    userId: req.user.id,
    userName: req.user.name,
    userRole: req.user.role,
    details: { reason: reason || 'Manual Admin Closure' },
  });

  res.json({ success: true, message: `RGP ${cleanRgp} successfully closed.` });
}));

/**
 * GET /scans/audit
 */
router.get('/audit', requireRole('admin'), wrap(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
  const p = Math.max(parseInt(req.query.page) || 1, 1);
  const offset = (p - 1) * limit;

  const result = await queryAuditLogs({
    limit,
    offset,
    eventType: req.query.eventType,
    lotNumber: req.query.lotNumber,
    userId: req.query.userId ? parseInt(req.query.userId) : undefined,
  });

  res.json({
    items: result.items,
    total: result.total,
    page: p,
    hasMore: offset + result.items.length < result.total,
  });
}));

router.get('/my', wrap(async (req, res) => {
  const { limit, offset, page: p } = page(req.query);
  const where = ['s.scanned_by = ?']; const args = [req.user.id];
  if (req.query.status) { where.push('s.status = ?'); args.push(S.status.parse(req.query.status)); }
  const [items] = await pool.query(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY s.created_at DESC, s.id DESC LIMIT ? OFFSET ?`, [...args, limit, offset]);
  const [[stats]] = await pool.query(
    `SELECT COUNT(*) AS total, SUM(status='completed' OR status='Closed') AS completed, SUM(status='in_progress') AS inProgress, SUM(status='pending') AS pending
     FROM scans_app WHERE scanned_by = ?`, [req.user.id]);
  res.json({ items, page: p, hasMore: items.length === limit,
    stats: { total: +stats.total, completed: +(stats.completed || 0), inProgress: +(stats.inProgress || 0), pending: +(stats.pending || 0) } });
}));

router.get('/', requireRole('admin'), wrap(async (req, res) => {
  const { limit, offset, page: p } = page(req.query);
  const where = ['1=1']; const args = [];
  if (req.query.q) { where.push('s.lot_number LIKE ?'); args.push(`%${String(req.query.q).slice(0, 100)}%`); }
  if (req.query.status) { where.push('s.status = ?'); args.push(S.status.parse(req.query.status)); }
  if (req.query.userId) { where.push('s.scanned_by = ?'); args.push(parseInt(req.query.userId)); }
  if (req.query.from) { where.push('s.created_at >= ?'); args.push(new Date(req.query.from)); }
  if (req.query.to) { const t = new Date(req.query.to); t.setUTCHours(23, 59, 59, 999); where.push('s.created_at <= ?'); args.push(t); }
  const [items] = await pool.query(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY s.created_at DESC, s.id DESC LIMIT ? OFFSET ?`, [...args, limit, offset]);
  res.json({ items, page: p, hasMore: items.length === limit });
}));

module.exports = router;
