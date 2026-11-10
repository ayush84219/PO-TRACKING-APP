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
    where.push('(po_number LIKE ? OR vendor_name LIKE ? OR design_name LIKE ?)');
    const s = `%${search.trim()}%`;
    params.push(s, s, s);
  }

  if (status) {
    where.push('status = ?');
    params.push(status);
  }

  const [items] = await pool.query(
    `SELECT id, external_id AS externalId, po_number AS poNumber, vendor_name AS vendorName,
            design_name AS designName, design_category AS designCategory, items,
            subtotal, tax_rate AS taxRate, tax, total, order_date AS orderDate,
            delivery_date AS deliveryDate, status, cancellation_reason AS cancellationReason,
            cancelled_by AS cancelledBy, cancelled_at AS cancelledAt, created_at AS createdAt
     FROM purchase_orders
     WHERE ${where.join(' AND ')}
     ORDER BY id ASC
     LIMIT ? OFFSET ?`,
    [...params, l, offset]
  );

  const [[{ count }]] = await pool.query(
    `SELECT COUNT(*) AS count FROM purchase_orders WHERE ${where.join(' AND ')}`,
    params
  );

  res.json({
    items: items.map(i => ({
      ...i,
      items: typeof i.items === 'string' ? JSON.parse(i.items) : (i.items || [])
    })),
    total: count,
    page: p,
    limit: l
  });
}));

// GET /pos/:poNumber - get single PO by number (e.g. PO-11001 or 11001)
router.get('/:poNumber', wrap(async (req, res) => {
  const raw = req.params.poNumber.trim();
  const poNum = raw.toUpperCase().startsWith('PO-') ? raw : `PO-${raw}`;

  const [rows] = await pool.query(
    `SELECT id, external_id AS externalId, po_number AS poNumber, vendor_name AS vendorName,
            design_name AS designName, design_category AS designCategory, items,
            subtotal, tax_rate AS taxRate, tax, total, order_date AS orderDate,
            delivery_date AS deliveryDate, status, cancellation_reason AS cancellationReason,
            cancelled_by AS cancelledBy, cancelled_at AS cancelledAt, created_at AS createdAt
     FROM purchase_orders
     WHERE po_number = ? OR po_number = ? OR external_id = ?
     LIMIT 1`,
    [raw, poNum, raw]
  );

  if (!rows.length) {
    return res.status(404).json({ error: `Purchase Order '${raw}' not found` });
  }

  const po = rows[0];
  res.json({
    ...po,
    items: typeof po.items === 'string' ? JSON.parse(po.items) : (po.items || [])
  });
}));

// POST /pos/check-db - Manually trigger check for new POs in database & push notifications to all panels
router.post('/check-db', wrap(async (req, res) => {
  const { checkNewPurchaseOrders } = require('../services/poWatcher');
  const detected = await checkNewPurchaseOrders();
  res.json({ ok: true, detectedCount: detected.length, detected });
}));

module.exports = router;

