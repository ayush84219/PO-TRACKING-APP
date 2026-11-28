const pool = require('../db/pool');

/**
 * Detect standardized bill type from bill/PO number.
 * @param {string} billNo
 * @returns {'RGP'|'DORI_PO'|'ZIP_PO'|'PO'|'OTHER'}
 */
function detectBillType(billNo) {
  const upper = String(billNo || '').trim().toUpperCase();
  if (upper.startsWith('RGP')) return 'RGP';
  if (upper.startsWith('DORI') || upper.startsWith('DOORI')) return 'DORI_PO';
  if (upper.startsWith('ZIP')) return 'ZIP_PO';
  if (upper.startsWith('PO') || /^\d+$/.test(upper)) return 'PO';
  return 'OTHER';
}

/**
 * Upsert a consolidated row in `scanner_details_app` for any bill/PO/RGP scan.
 * Keeps one row per bill with gate_out (RGP only), gate_in, store_scan, supervisor_scan, and status.
 *
 * @param {object} conn - MySQL connection or pool
 * @param {object} params
 */
async function upsertScannerDetail(conn, {
  poNo,
  billType,
  materialName = null,
  supplierName = null,
  assignedSupervisor = null,
  scanStage = null,
  scannedByName = 'Staff',
  scanTime = null,
  isComplete = false,
}) {
  if (!poNo) return;

  const db = conn || pool;
  const normalizedPoNo = String(poNo).trim().toUpperCase();
  const resolvedType = billType || detectBillType(normalizedPoNo);
  const ts = scanTime ? new Date(scanTime) : new Date();
  const scanner = String(scannedByName || 'Staff').trim().slice(0, 255);
  const status = isComplete ? 'complete' : 'pending';

  const stage = String(scanStage || '').trim().toUpperCase();
  const isGateOut = resolvedType === 'RGP' && stage === 'GATE_OUT';
  const isGateIn = stage === 'GATE_IN' || stage === 'GATE_INWARD';
  const isStore = stage === 'STORE_INWARD';
  const isSupervisor = stage === 'SUPERVISOR_PICKUP' || stage === 'SUPERVISOR_INWARD';

  await db.query(
    `INSERT INTO scanner_details_app (
      po_no, bill_type, material_name, supplier_name, assigned_supervisor,
      gate_out, gate_out_at,
      gate_in, gate_in_at,
      store_scan, store_scan_at,
      supervisor_scan, supervisor_scan_at,
      current_stage, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      bill_type = IF(VALUES(bill_type) != 'OTHER', VALUES(bill_type), bill_type),
      material_name = COALESCE(VALUES(material_name), material_name),
      supplier_name = COALESCE(VALUES(supplier_name), supplier_name),
      assigned_supervisor = COALESCE(VALUES(assigned_supervisor), assigned_supervisor),
      gate_out = COALESCE(VALUES(gate_out), gate_out),
      gate_out_at = COALESCE(VALUES(gate_out_at), gate_out_at),
      gate_in = COALESCE(VALUES(gate_in), gate_in),
      gate_in_at = COALESCE(VALUES(gate_in_at), gate_in_at),
      store_scan = COALESCE(VALUES(store_scan), store_scan),
      store_scan_at = COALESCE(VALUES(store_scan_at), store_scan_at),
      supervisor_scan = COALESCE(VALUES(supervisor_scan), supervisor_scan),
      supervisor_scan_at = COALESCE(VALUES(supervisor_scan_at), supervisor_scan_at),
      current_stage = COALESCE(VALUES(current_stage), current_stage),
      status = IF(status = 'complete' OR VALUES(status) = 'complete', 'complete', 'pending')`,
    [
      normalizedPoNo,
      resolvedType,
      materialName ? String(materialName).slice(0, 255) : null,
      supplierName ? String(supplierName).slice(0, 255) : null,
      assignedSupervisor ? String(assignedSupervisor).slice(0, 100) : null,
      isGateOut ? scanner : null,
      isGateOut ? ts : null,
      isGateIn ? scanner : null,
      isGateIn ? ts : null,
      isStore ? scanner : null,
      isStore ? ts : null,
      isSupervisor ? scanner : null,
      isSupervisor ? ts : null,
      stage || null,
      status,
    ]
  );
}

module.exports = {
  detectBillType,
  upsertScannerDetail,
};
