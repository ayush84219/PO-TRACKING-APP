const router = require('express').Router();
const pool = require('../db/pool');
const { wrap, AppError } = require('../middleware/errors');
const { authenticate, requireRole } = require('../middleware/auth');

router.use(authenticate);

/**
 * GET /materials/lookup/:lot
 * Universal lookup endpoint for both POs and RGPs.
 * Accurately determines:
 * 1. Document type: 'RGP' or 'PO'
 * 2. Real-time workflow stage:
 *    - PO: GENERATED -> AT_GATE -> CLOSED (2-step scan)
 *    - RGP: GENERATED -> GATE_OUT -> GATE_IN -> CLOSED (3-step scan)
 * 3. Next allowed scan stage
 * 4. Scan history with officer attribution and timestamps
 */
router.get('/lookup/:lot', wrap(async (req, res) => {
  const lot = (req.params.lot || '').trim();
  if (!lot) return res.json({ exists: false });

  const upperLot = lot.toUpperCase();
  const cleanPo = upperLot.startsWith('PO-') ? upperLot : `PO-${upperLot}`;
  const rawPo = upperLot.replace(/^PO-/, '');
  const digitsOnly = lot.replace(/[^0-9]/g, '');

  // =========================================================================
  // 1. CHECK IF LOOKUP IS AN RGP (Returnable Gate Pass)
  // =========================================================================
  const isExplicitRgp = upperLot.startsWith('RGP-') || upperLot.startsWith('RGP');
  const isExplicitPo = upperLot.startsWith('PO-') || upperLot.startsWith('PO');
  let rgpRecords = [];
  if (isExplicitRgp) {
    try {
      const cleanRgp = upperLot.startsWith('RGP-') ? upperLot : `RGP-${upperLot.replace(/^RGP-?/, '')}`;
      const rawRgp = cleanRgp.replace(/^RGP-/, '');
      const [r1] = await pool.query(
        'SELECT id, rgpNo, date, vendor, rgpType, department, purpose, expectedReturnDate, vehicleNo, preparedBy, authorizedBy, entries, status FROM rgp WHERE rgpNo = ? OR rgpNo = ? LIMIT 1',
        [cleanRgp, rawRgp]
      );
      if (r1.length) rgpRecords = r1;
    } catch (err) {
      console.error('Error querying rgp table:', err.message);
    }
  }

  if (isExplicitRgp) {
    const rgp = rgpRecords[0] || null;
    const rgpNumber = rgp ? rgp.rgpNo : (upperLot.startsWith('RGP-') ? upperLot : `RGP-${upperLot}`);

    const cleanRgpDigits = rgpNumber.replace(/[^0-9]/g, '');

    // Query scan history for this RGP from scans_app
    const [scans] = await pool.query(
      `SELECT s.id, s.scan_stage, s.status, s.note, s.created_at AS createdAt,
              s.event_id AS eventId, s.delivery_status AS deliveryStatus,
              s.delivered_at AS deliveredAt, s.acknowledged_at AS acknowledgedAt,
              s.acknowledged_by_name AS acknowledgedByName,
              s.scanned_by AS scannedById, COALESCE(u.name, 'Officer') AS scannedByName, u.role AS scannedByRole
       FROM scans_app s
       LEFT JOIN user_app u ON u.id = s.scanned_by
       WHERE s.lot_number IN (?, ?, ?, ?) OR s.lot_number = ?
       ORDER BY s.id ASC`,
      [rgpNumber, cleanRgpDigits, `RGP-${cleanRgpDigits}`, `PO-${cleanRgpDigits}`, rgp ? rgp.id : -1]
    );

    const gateOutScan = scans.find(s => s.scan_stage === 'GATE_OUT' || (s.note && s.note.includes('[GATE OUT]')));
    const gateInScan = scans.find(s => s.scan_stage === 'GATE_IN' || (s.note && s.note.includes('[GATE IN]')));
    const supervisorScan = scans.find(s => s.scan_stage === 'SUPERVISOR_INWARD' || (s.note && s.note.includes('[SUPERVISOR INWARD]')));

    // Check if acknowledged in notification_queue_app or scans_app for this RGP
    if (gateInScan && gateInScan.deliveryStatus !== 'acknowledged') {
      try {
        const [ackQ] = await pool.query(
          `SELECT acknowledged_by_name, acknowledged_at FROM notification_queue_app 
           WHERE (lot_number IN (?, ?, ?, ?) OR event_id = ?) AND status = 'acknowledged' 
           ORDER BY id DESC LIMIT 1`,
          [rgpNumber, cleanRgpDigits, `RGP-${cleanRgpDigits}`, `PO-${cleanRgpDigits}`, gateInScan.eventId || '']
        );
        if (ackQ.length) {
          gateInScan.deliveryStatus = 'acknowledged';
          gateInScan.acknowledgedByName = ackQ[0].acknowledged_by_name || gateInScan.acknowledgedByName;
          gateInScan.acknowledgedAt = ackQ[0].acknowledged_at || gateInScan.acknowledgedAt;
        }
      } catch {}
    }

    const lastRgpScan = scans[scans.length - 1] || null;
    const hasFinalRgpClose = scans.some(
      s => s.scan_stage === 'SUPERVISOR_INWARD' && (s.status === 'completed' || (s.note && s.note.includes('FINAL')))
    );

    let currentStage = 'GENERATED';
    let nextAllowedScan = 'GATE_OUT';
    let statusDisplay = 'Open';

    if (hasFinalRgpClose) {
      currentStage = 'CLOSED';
      nextAllowedScan = null;
      statusDisplay = 'Closed';
    } else if (lastRgpScan && lastRgpScan.scan_stage === 'GATE_IN') {
      currentStage = 'GATE_IN';
      nextAllowedScan = 'SUPERVISOR_INWARD';
      statusDisplay = lastRgpScan.status === 'pending' ? 'At Gate (Half/Partial Return)' : 'At Gate (Complete Return)';
    } else if (lastRgpScan && lastRgpScan.scan_stage === 'GATE_OUT') {
      currentStage = 'GATE_OUT';
      nextAllowedScan = 'GATE_IN';
      statusDisplay = 'Gate Out';
    } else if (lastRgpScan && lastRgpScan.scan_stage === 'SUPERVISOR_INWARD') {
      currentStage = 'PARTIAL_RECEIVED';
      nextAllowedScan = 'GATE_IN';
      statusDisplay = 'Half Received (Partial Return)';
    }

    let itemsList = [];
    let totalQty = 0;
    let unit = 'PCS';

    if (rgp && rgp.entries) {
      try {
        const ents = typeof rgp.entries === 'string' ? JSON.parse(rgp.entries) : rgp.entries;
        if (Array.isArray(ents)) {
          itemsList = ents.map(e => ({
            name: e.itemDesc || `${rgp.rgpType || 'Material'} (${e.lotNo || ''})`,
            qty: Number(e.qty1) || Number(e.qty2) || 0,
            unit: e.uom || 'PCS',
            lotNo: e.lotNo,
            department: e.department,
            purpose: e.purpose,
          }));
          totalQty = itemsList.reduce((acc, it) => acc + it.qty, 0);
          if (itemsList[0] && itemsList[0].unit) unit = itemsList[0].unit;
        }
      } catch {}
    }

    // Lookup supervisor from supervisor_details_app based on any lot number inside RGP entries
    let resolvedSupervisor = 'Sanjay';
    if (itemsList.length > 0) {
      for (const item of itemsList) {
        if (item.lotNo && item.lotNo !== 'N/A') {
          const cleanLotNum = item.lotNo.replace(/[^0-9]/g, '');
          const [supMatch] = await pool.query(
            'SELECT supervisor FROM supervisor_details_app WHERE lot_number = ? OR lot_number = ? LIMIT 1',
            [item.lotNo, cleanLotNum]
          ).catch(() => [[]]);
          if (supMatch && supMatch.length && supMatch[0].supervisor) {
            resolvedSupervisor = supMatch[0].supervisor;
            break;
          }
        }
      }
    }

    const materialTitle = rgp
      ? `${rgp.rgpType || 'Material'} (${rgp.purpose || 'RGP'}) - ${rgp.vendor}`
      : `RGP ${rgpNumber}`;

    return res.json({
      exists: true,
      docType: 'RGP',
      rgpNumber,
      poNumber: null,
      lotNumber: rgpNumber,
      materialName: materialTitle,
      vendor: rgp ? rgp.vendor : '',
      purpose: rgp ? rgp.purpose : '',
      department: rgp ? rgp.department : '',
      vehicleNo: rgp ? rgp.vehicleNo : '',
      date: rgp ? rgp.date : null,
      expectedReturnDate: rgp ? rgp.expectedReturnDate : null,
      status: statusDisplay,
      expectedQuantity: totalQty || 1,
      expectedUnit: unit,
      items: itemsList,
      currentStage,
      nextAllowedScan,
      isFullyReceived: currentStage === 'CLOSED',
      isPartialReceived: currentStage === 'PARTIAL_RECEIVED',
      closedBy: (hasFinalRgpClose && hasFinalRgpClose.scannedByName) || null,
      closedAt: (hasFinalRgpClose && hasFinalRgpClose.createdAt) || null,
      scanHistory: scans,
      gateOutScan: gateOutScan || null,
      gateInScan: gateInScan || null,
      supervisorScan: supervisorScan || null,
      supervisor: resolvedSupervisor,
    });
  }

  // =========================================================================
  // 2. CHECK IF LOOKUP IS A PURCHASE ORDER (PO) OR MATERIAL LOT
  // =========================================================================
  // Check materials_app table
  const [materials] = await pool.query(
    'SELECT id, lot_number AS lotNumber, material_name AS materialName, status FROM materials_app WHERE lot_number = ? OR lot_number = ?',
    [lot, cleanPo]
  );

  // Check purchase_orders or purchase_orders_app
  let pos = [];
  try {
    const [p1] = await pool.query(
      'SELECT poNumber AS po_number, id AS external_id, vendorName AS vendor_name, designName AS design_name, designCategory AS design_category, items, status, date FROM purchase_orders WHERE poNumber = ? OR poNumber = ? OR id = ? LIMIT 1',
      [cleanPo, rawPo, digitsOnly || -1]
    );
    if (p1.length) pos = p1;
  } catch {}
  if (!pos.length) {
    try {
      const [p2] = await pool.query(
        'SELECT po_number, external_id, vendor_name, design_name, items, status FROM purchase_orders_app WHERE po_number = ? OR po_number = ? OR external_id = ? LIMIT 1',
        [cleanPo, rawPo, digitsOnly || -1]
      );
      if (p2.length) pos = p2;
    } catch {}
  }

  // Check supervisor_details_app
  let sups = [];
  try {
    const [s1] = await pool.query(
      'SELECT * FROM supervisor_details_app WHERE lot_number = ? OR lot_number = ? OR lot_number = ? OR lot_number = ? LIMIT 1',
      [lot, rawPo, cleanPo, digitsOnly || -1]
    );
    if (s1.length) sups = s1;
  } catch {}

  const po = pos[0] || null;
  const sup = sups[0] || null;
  const mat = materials[0] || null;

  if (po || sup || mat) {
    const poNumber = po ? po.po_number : cleanPo;

    // Query scan history for this PO from scans_app
    const [scans] = await pool.query(
      `SELECT s.id, s.scan_stage, s.status, s.note, s.created_at AS createdAt,
              s.event_id AS eventId, s.delivery_status AS deliveryStatus,
              s.delivered_at AS deliveredAt, s.acknowledged_at AS acknowledgedAt,
              s.acknowledged_by_name AS acknowledgedByName,
              s.scanned_by AS scannedById, COALESCE(u.name, 'Officer') AS scannedByName, u.role AS scannedByRole
       FROM scans_app s
       LEFT JOIN user_app u ON u.id = s.scanned_by
       WHERE s.lot_number IN (?, ?, ?, ?, ?) OR s.material_id = ?
       ORDER BY s.id ASC`,
      [poNumber, rawPo, lot, cleanPo, digitsOnly || '', mat ? mat.id : -1]
    );

    const gateInwardScans = scans.filter(s => s.scan_stage === 'GATE_INWARD' || (s.note && s.note.includes('[GATE ENTRY]')));
    const gateInwardScan = gateInwardScans.length ? gateInwardScans[gateInwardScans.length - 1] : null;
    const storeScans = scans.filter(s => s.scan_stage === 'STORE_INWARD' || (s.note && s.note.includes('[STORE INWARD]')));
    const storeScan = storeScans.length ? storeScans[storeScans.length - 1] : null;
    const supervisorScans = scans.filter(s => s.scan_stage === 'SUPERVISOR_PICKUP' || (s.note && s.note.includes('[SUPERVISOR PICKUP]')));
    const supervisorScan = supervisorScans.length ? supervisorScans[supervisorScans.length - 1] : null;

    // Check if acknowledged in notification_queue_app or scans_app for this lot
    if (gateInwardScan && gateInwardScan.deliveryStatus !== 'acknowledged') {
      try {
        const [ackQ] = await pool.query(
          `SELECT acknowledged_by_name, acknowledged_at FROM notification_queue_app 
           WHERE (lot_number IN (?, ?, ?, ?, ?) OR event_id = ?) AND status = 'acknowledged' 
           ORDER BY id DESC LIMIT 1`,
          [poNumber, rawPo, lot, cleanPo, digitsOnly || '', gateInwardScan.eventId || '']
        );
        if (ackQ.length) {
          gateInwardScan.deliveryStatus = 'acknowledged';
          gateInwardScan.acknowledgedByName = ackQ[0].acknowledged_by_name || gateInwardScan.acknowledgedByName;
          gateInwardScan.acknowledgedAt = ackQ[0].acknowledged_at || gateInwardScan.acknowledgedAt;
        }
      } catch {}
    }

    const lastScan = scans[scans.length - 1] || null;
    const hasFinalClosed = scans.some(
      s => s.scan_stage === 'SUPERVISOR_PICKUP' && (s.status === 'completed' || (s.note && s.note.includes('FINAL')))
    );

    let currentStage = 'GENERATED';
    let nextAllowedScan = 'GATE_INWARD';
    let statusDisplay = 'Open';

    if (hasFinalClosed || (mat && (mat.status === 'Closed' || mat.status === 'completed'))) {
      currentStage = 'CLOSED';
      nextAllowedScan = null;
      statusDisplay = 'Closed';
    } else if (lastScan && lastScan.scan_stage === 'GATE_INWARD') {
      currentStage = 'AT_GATE';
      nextAllowedScan = 'STORE_INWARD'; // Step 2: Store person collects parcel from gate
      statusDisplay = lastScan.status === 'pending' ? 'At Gate (Half/Partial)' : 'At Gate (Complete)';
    } else if (lastScan && lastScan.scan_stage === 'STORE_INWARD') {
      currentStage = 'AT_STORE';
      nextAllowedScan = 'SUPERVISOR_PICKUP'; // Step 3: Supervisor verifies and closes PO
      statusDisplay = 'In Store (Awaiting Supervisor)';
    } else if (lastScan && lastScan.scan_stage === 'SUPERVISOR_PICKUP') {
      currentStage = 'PARTIAL_RECEIVED';
      nextAllowedScan = 'GATE_INWARD'; // Gate scanner is active for remaining deliveries!
      statusDisplay = 'Half Received';
    }

    let itemsList = [];
    let expectedQuantity = null;
    let expectedUnit = 'PCS';

    if (po && po.items) {
      try {
        const its = typeof po.items === 'string' ? JSON.parse(po.items) : po.items;
        if (Array.isArray(its) && its.length) {
          itemsList = its;
          expectedQuantity = its.reduce((acc, it) => acc + (Number(it.qty) || 0), 0);
          expectedUnit = its[0].unit || 'PCS';
        }
      } catch {}
    }

    if (!expectedQuantity && sup) {
      expectedQuantity = sup.cutting_qty || sup.stitching_issue_qty;
    }

    let matName = '';
    if (po) {
      const parts = [po.design_name, po.vendor_name].filter(Boolean);
      matName = itemsList.length > 0
        ? `${itemsList.map(i => i.name).join(', ')} - ${po.vendor_name || 'Vendor'}`
        : (parts.length ? parts.join(' - ') : `Purchase Order ${poNumber}`);
    } else if (sup) {
      const parts = [sup.garment_type, sup.style, sup.brand ? `[${sup.brand}]` : '', sup.fabric].filter(Boolean);
      matName = parts.join(' - ');
    } else if (mat && mat.materialName) {
      matName = mat.materialName;
    } else {
      matName = `PO Lot ${poNumber}`;
    }

    let resolvedSupervisor = sup ? sup.supervisor : null;
    if (!resolvedSupervisor) {
      try {
        const [notifRow] = await pool.query(
          'SELECT supervisor_name FROM notified_po_app WHERE po_number = ? OR po_number = ? LIMIT 1',
          [poNumber, rawPo]
        );
        if (notifRow.length && notifRow[0].supervisor_name) {
          resolvedSupervisor = notifRow[0].supervisor_name;
        }
      } catch {}
    }
    if (!resolvedSupervisor) {
      try {
        const [activeSups] = await pool.query(
          "SELECT name FROM user_app WHERE (role = 'supervisor' OR base_role = 'supervisor') AND is_active = 1 LIMIT 1"
        );
        if (activeSups.length && activeSups[0].name) {
          resolvedSupervisor = activeSups[0].name;
        }
      } catch {}
    }
    if (!resolvedSupervisor) resolvedSupervisor = 'Sanjay';

    return res.json({
      exists: true,
      docType: 'PO',
      poNumber,
      rgpNumber: null, // Distinct: PO does NOT have an RGP number
      lotNumber: poNumber,
      materialName: matName,
      vendor: po ? po.vendor_name : (sup ? sup.brand : ''),
      designName: po ? po.design_name : (sup ? sup.style : ''),
      status: statusDisplay,
      expectedQuantity: expectedQuantity || 1,
      expectedUnit,
      items: itemsList,
      currentStage,
      nextAllowedScan,
      isFullyReceived: currentStage === 'CLOSED',
      isPartialReceived: currentStage === 'PARTIAL_RECEIVED',
      closedBy: (finalClosedScan && finalClosedScan.scannedByName) || null,
      closedAt: (finalClosedScan && finalClosedScan.createdAt) || null,
      scanHistory: scans,
      gateInwardScan: gateInwardScan || null,
      storeScan: storeScan || null,
      supervisorScan: supervisorScan || null,
      supervisor: resolvedSupervisor,
      supervisorDetails: sup || null,
    });
  }

  return res.json({ exists: false });
}));

// Any logged-in user: get all lot -> supervisor mappings from supervisor_details_app
router.get('/supervisor-lots', wrap(async (req, res) => {
  let rows = [];
  try {
    const [r1] = await pool.query(
      'SELECT lot_number AS lotNumber, supervisor, fabric, garment_type AS garmentType, style, brand, cutting_qty AS cuttingQty FROM supervisor_details_app ORDER BY lot_number ASC'
    );
    rows = r1;
  } catch {
    try {
      const [r2] = await pool.query(
        'SELECT lot_number AS lotNumber, supervisor, fabric, garment_type AS garmentType, style, brand, cutting_qty AS cuttingQty FROM supervisor_details ORDER BY lot_number ASC'
      );
      rows = r2;
    } catch {}
  }
  res.json({ items: rows });
}));

// Admin: lot detail + full history
router.get('/:lot', requireRole('admin'), wrap(async (req, res) => {
  const [mats] = await pool.query(
    `SELECT m.id, m.lot_number AS lotNumber, m.material_name AS materialName, m.status, m.scan_count AS scanCount,
            m.last_scanned_at AS lastScannedAt, u.name AS lastScannedByName
     FROM materials_app m LEFT JOIN user_app u ON u.id = m.last_scanned_by WHERE m.lot_number = ?`, [req.params.lot]);
  if (!mats.length) throw new AppError(404, 'Lot not found', 'not_found');
  const [scans] = await pool.query(
    `SELECT s.id, s.scan_stage AS scanStage, s.status, s.note, s.created_at AS createdAt, u.name AS scannedByName
     FROM scans_app s JOIN user_app u ON u.id = s.scanned_by WHERE s.material_id = ? ORDER BY s.created_at ASC, s.id ASC`, [mats[0].id]);
  let seenCompleted = false;
  const history = scans.map(s => { const isRescan = seenCompleted; if (s.status === 'completed' || s.status === 'Closed') seenCompleted = true; return { ...s, isRescan }; });
  res.json({ material: mats[0], history: history.reverse() });
}));

module.exports = router;
