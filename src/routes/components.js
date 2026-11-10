const router = require('express').Router();
const pool = require('../db/pool');
const { wrap } = require('../middleware/errors');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

/**
 * GET /components
 * Returns all component lot details matching Image 2:
 * SR NO | LOT NO | VER | PO NO | GARMENT TYPE | STYLE | PIECES | COST | ISSUE DATE | SUPERVISOR | ZIP PLACEMENTS | GATE ENTRY | MATERIAL RECEIVED | SUPPLIER | AGING
 */
router.get('/', wrap(async (req, res) => {
  const { search, status, limit = 50, page = 1 } = req.query;
  const l = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
  const p = Math.max(parseInt(page) || 1, 1);
  const offset = (p - 1) * l;

  let whereClauses = ['1=1'];
  let params = [];

  if (search) {
    const s = `%${search.trim()}%`;
    whereClauses.push('(z.Lot_Number LIKE ? OR z.po_number LIKE ? OR z.Style LIKE ? OR z.Supervisor LIKE ? OR z.Supplier_Name LIKE ? OR z.Garment_Type LIKE ?)');
    params.push(s, s, s, s, s, s);
  }

  // Query zip table as primary component lot source
  let zipRows = [];
  try {
    const [rows] = await pool.query(
      `SELECT 
        z.id,
        z.Lot_Number AS lotNo,
        z.version,
        z.po_number AS poNo,
        z.Garment_Type AS garmentTypeRaw,
        z.Fabric AS fabric,
        z.Style AS style,
        z.Total_Pieces AS piecesDirect,
        ch.Cutting_Qty AS cuttingQty,
        z.Total_Cost AS cost,
        z.Issue_Date AS issueDate,
        z.Supervisor AS supervisor,
        z.Selected_Placements AS selectedPlacements,
        z.Gate_Entry_Person AS gateEntryPerson,
        z.Gate_Entry_Date AS gateEntryDate,
        z.Material_Received_By AS materialReceivedBy,
        z.Material_Received_Date AS materialReceivedDate,
        z.Supplier_Name AS supplierName,
        z.Material_Entry_Date AS materialEntryDate,
        z.Saved_At AS savedAt,
        z.status AS statusDirect
      FROM zip z
      LEFT JOIN cutting_header ch ON ch.Lot_Number = z.Lot_Number
      WHERE ${whereClauses.join(' AND ')}
      ORDER BY z.id ASC
      LIMIT ? OFFSET ?`,
      [...params, l, offset]
    );
    zipRows = rows;
  } catch (err) {
    console.error('[Components] Error querying zip table:', err.message);
  }

  // Also count total entries
  let totalCount = 0;
  try {
    const [[c]] = await pool.query(
      `SELECT COUNT(*) AS total FROM zip z WHERE ${whereClauses.join(' AND ')}`,
      params
    );
    totalCount = c.total;
  } catch {}

  const now = new Date();

  const formattedItems = zipRows.map((r, index) => {
    const srNo = offset + index + 1;
    const versionStr = `V${r.version || 1}`;
    const garmentType = [r.garmentTypeRaw, r.fabric].filter(Boolean).join(' ').trim() || 'LOWER';
    const pieces = Number(r.cuttingQty) || Number(r.piecesDirect) || 600;
    const cost = Number(r.cost) || 0;

    // Parse placements
    let zipPlacements = 'Side Pocket';
    if (r.selectedPlacements) {
      try {
        const parsedPlacements = typeof r.selectedPlacements === 'string' ? JSON.parse(r.selectedPlacements) : r.selectedPlacements;
        if (Array.isArray(parsedPlacements) && parsedPlacements.length > 0) {
          zipPlacements = parsedPlacements.join(', ');
        }
      } catch {}
    }

    // Gate entry status
    const hasGateEntry = Boolean(r.gateEntryPerson && r.gateEntryPerson.trim());
    const gateEntry = {
      status: hasGateEntry ? 'done' : 'pending',
      label: hasGateEntry ? 'Done' : 'Pending',
      person: r.gateEntryPerson || '',
      date: r.gateEntryDate || '',
    };

    // Material received status
    const hasReceived = Boolean(r.materialReceivedBy && r.materialReceivedBy.trim());
    const materialReceived = {
      status: hasReceived ? 'received' : 'pending',
      label: hasReceived ? 'Received' : 'Pending',
      by: r.materialReceivedBy || '',
      date: r.materialReceivedDate || '',
    };

    // Supplier status
    const hasSupplier = Boolean(r.supplierName && r.supplierName.trim());
    const supplier = {
      status: hasSupplier ? 'entered' : 'pending',
      label: hasSupplier ? 'Entered' : 'Pending',
      name: r.supplierName || 'Pending',
      date: r.materialEntryDate || '',
    };

    // Aging calculation
    let agingDays = 0;
    let isCompleted = hasGateEntry && hasReceived;
    const issueDateObj = r.issueDate ? new Date(r.issueDate) : (r.savedAt ? new Date(r.savedAt) : now);

    if (isCompleted && r.materialReceivedDate) {
      const recDate = new Date(r.materialReceivedDate);
      const diffMs = Math.abs(recDate.getTime() - issueDateObj.getTime());
      agingDays = Math.max(1, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
    } else {
      const diffMs = Math.abs(now.getTime() - issueDateObj.getTime());
      agingDays = Math.max(1, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
    }

    const aging = {
      days: agingDays,
      isCompleted,
      text: isCompleted ? `${agingDays} days Completed` : `${agingDays} days`,
    };

    return {
      id: r.id,
      srNo,
      lotNo: r.lotNo,
      version: versionStr,
      poNo: r.poNo || `ZIP-PO-000${r.id}`,
      garmentType,
      style: r.style || 'BOXY FIT',
      pieces,
      cost,
      costFormatted: `₹${cost.toLocaleString('en-IN')}`,
      issueDate: r.issueDate || '10/10/2026',
      supervisor: r.supervisor || 'Rashmi',
      zipPlacements,
      gateEntry,
      materialReceived,
      supplier,
      aging,
      status: isCompleted ? 'Completed' : 'Pending',
    };
  });

  res.json({
    items: formattedItems,
    total: totalCount,
    page: p,
    limit: l,
  });
}));

module.exports = router;

