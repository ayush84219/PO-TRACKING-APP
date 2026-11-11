const router = require('express').Router();
const pool = require('../db/pool');
const { wrap } = require('../middleware/errors');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// GET /pos - list purchase orders
router.get('/', wrap(async (req, res) => {
  const { search, status, limit = 50, page = 1 } = req.query;
  const l = Math.min(Math.max(parseInt(limit) || 50, 1), 100);
  const p = Math.max(parseInt(page) || 1, 1);
  const offset = (p - 1) * l;

  let where = ['1=1'];
  let params = [];

  if (search) {
    where.push('(poNumber LIKE ? OR vendorName LIKE ? OR designName LIKE ?)');
    const s = `%${search.trim()}%`;
    params.push(s, s, s);
  }

  if (status) {
    where.push('status = ?');
    params.push(status);
  }

  let items = [];
  let count = 0;

  try {
    const [rows] = await pool.query(
      `SELECT id, id AS externalId, poNumber, vendorName,
              designName, designCategory, items,
              subtotal, taxRate, tax, total, date AS orderDate,
              deliveryDate, status, cancellation_reason AS cancellationReason,
              cancelled_by AS cancelledBy, cancelled_at AS cancelledAt,
              requisitionRaisedBy, preparedBy, approvedBy, remarks, supervisorName
       FROM purchase_orders
       WHERE ${where.join(' AND ')}
       ORDER BY id DESC
       LIMIT ? OFFSET ?`,
      [...params, l, offset]
    );
    items = rows;

    const [[countRow]] = await pool.query(
      `SELECT COUNT(*) AS count FROM purchase_orders WHERE ${where.join(' AND ')}`,
      params
    );
    count = countRow?.count || items.length;
  } catch (err) {
    // Fallback if legacy snake_case table
    const [rows] = await pool.query(
      `SELECT * FROM purchase_orders WHERE 1=1 ORDER BY id DESC LIMIT ? OFFSET ?`,
      [l, offset]
    );
    items = rows;
    count = items.length;
  }

  res.json({
    items: items.map(i => {
      let parsedItems = [];
      try {
        parsedItems = typeof i.items === 'string' ? JSON.parse(i.items) : (i.items || []);
      } catch {}
      return {
        ...i,
        poNumber: i.poNumber || i.po_number,
        vendorName: i.vendorName || i.vendor_name,
        designName: i.designName || i.design_name,
        supervisorName: i.supervisorName || i.supervisor_name,
        requestedBy: i.preparedBy ? `${i.preparedBy}${i.requisitionRaisedBy ? ` (Requisition: ${i.requisitionRaisedBy})` : ''}` : (i.requisitionRaisedBy || ''),
        items: parsedItems,
      };
    }),
    total: count,
    page: p,
    limit: l
  });
}));

// GET /pos/:poNumber - get single PO by number (e.g. PO-11001 or 11001 or lot 62115)
router.get('/:poNumber', wrap(async (req, res) => {
  const raw = req.params.poNumber.trim();
  const poNum = raw.toUpperCase().startsWith('PO-') ? raw : `PO-${raw}`;
  const digitsOnly = raw.replace(/[^0-9]/g, '');

  let rows = [];

  // 1. Try camelCase columns (actual production schema)
  try {
    const [r1] = await pool.query(
      `SELECT id, id AS externalId, poNumber, vendorName,
              designName, designCategory, items,
              subtotal, taxRate, tax, total, date AS orderDate,
              deliveryDate, status, cancellation_reason AS cancellationReason,
              cancelled_by AS cancelledBy, cancelled_at AS cancelledAt,
              requisitionRaisedBy, preparedBy, approvedBy, remarks, supervisorName
       FROM purchase_orders
       WHERE poNumber = ? OR poNumber = ? OR designName = ? OR id = ?
       LIMIT 1`,
      [raw, poNum, raw, digitsOnly || -1]
    );
    if (r1.length) rows = r1;
  } catch {}

  // 2. Try generic SELECT *
  if (!rows.length) {
    try {
      const [r2] = await pool.query(
        `SELECT * FROM purchase_orders
         WHERE poNumber = ? OR poNumber = ? OR designName = ? OR id = ?
         LIMIT 1`,
        [raw, poNum, raw, digitsOnly || -1]
      );
      if (r2.length) rows = r2;
    } catch {}
  }

  // 3. Try snake_case columns
  if (!rows.length) {
    try {
      const [r3] = await pool.query(
        `SELECT * FROM purchase_orders
         WHERE po_number = ? OR po_number = ? OR id = ?
         LIMIT 1`,
        [raw, poNum, digitsOnly || -1]
      );
      if (r3.length) rows = r3;
    } catch {}
  }

  if (!rows.length) {
    return res.status(404).json({ error: `Purchase Order '${raw}' not found` });
  }

  const po = rows[0];
  let parsedItems = [];
  try {
    parsedItems = typeof po.items === 'string' ? JSON.parse(po.items) : (po.items || []);
  } catch {}

  res.json({
    ...po,
    poNumber: po.poNumber || po.po_number || poNum,
    vendorName: po.vendorName || po.vendor_name || '',
    designName: po.designName || po.design_name || '',
    supervisorName: po.supervisorName || po.supervisor_name || '',
    requestedBy: po.preparedBy ? `${po.preparedBy}${po.requisitionRaisedBy ? ` (Requisition: ${po.requisitionRaisedBy})` : ''}` : (po.requisitionRaisedBy || ''),
    items: parsedItems,
  });
}));

// POST /pos/check-db - Manually trigger check for new POs in database & push notifications to all panels
router.post('/check-db', wrap(async (req, res) => {
  const { checkNewPurchaseOrders } = require('../services/poWatcher');
  const detected = await checkNewPurchaseOrders();
  res.json({ ok: true, detectedCount: detected.length, detected });
}));

module.exports = router;

