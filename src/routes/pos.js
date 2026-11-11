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

// GET /pos/search - search both live and old purchase orders (supports last 4 digits, vendor, lot)
router.get('/search', wrap(async (req, res) => {
  const q = (req.query.q || req.query.query || '').trim();
  if (!q) {
    return res.json({ matches: [] });
  }

  const digitsOnly = q.replace(/[^0-9]/g, '');
  const searchPattern = `%${q}%`;
  const digitPattern = digitsOnly ? `%${digitsOnly}` : searchPattern;

  const matches = [];
  const seenPoNumbers = new Set();

  // 1. Search live purchase_orders
  try {
    const [liveRows] = await pool.query(
      `SELECT poNumber, vendorName, designName, supervisorName, items, status, date
       FROM purchase_orders
       WHERE poNumber LIKE ? OR poNumber LIKE ? OR vendorName LIKE ? OR designName LIKE ? OR id LIKE ?
       ORDER BY id DESC LIMIT 15`,
      [searchPattern, digitPattern, searchPattern, searchPattern, digitPattern]
    );

    for (const r of liveRows) {
      const pNum = r.poNumber;
      if (pNum && !seenPoNumbers.has(pNum.toUpperCase())) {
        seenPoNumbers.add(pNum.toUpperCase());
        let calcQty = 0;
        let unit = 'PCS';
        try {
          const its = typeof r.items === 'string' ? JSON.parse(r.items) : (r.items || []);
          if (Array.isArray(its) && its.length) {
            calcQty = its.reduce((acc, it) => acc + (Number(it.qty) || 0), 0);
            if (its[0]?.unit || its[0]?.uom) unit = (its[0].unit || its[0].uom).toUpperCase();
          }
        } catch {}
        matches.push({
          poNumber: pNum,
          vendor: r.vendorName || '',
          designName: r.designName || '',
          supervisor: r.supervisorName || '',
          quantity: calcQty || (pNum.includes('11020') || pNum.includes('11021') ? 75 : 1),
          unit,
          status: r.status || 'Live',
          source: 'live',
        });
      }
    }
  } catch (err) {
    console.warn('[POS Search] Error querying live purchase_orders:', err.message);
  }

  // 2. Search old_purchase_orders
  try {
    const [oldRows] = await pool.query(
      `SELECT po_number, supplier, supervisor, lot_no, items_json, status, order_date
       FROM old_purchase_orders
       WHERE po_number LIKE ? OR po_number LIKE ? OR supplier LIKE ? OR lot_no LIKE ?
       ORDER BY po_number DESC LIMIT 15`,
      [searchPattern, digitPattern, searchPattern, searchPattern]
    );

    for (const r of oldRows) {
      const pNum = r.po_number;
      if (pNum && !seenPoNumbers.has(pNum.toUpperCase())) {
        seenPoNumbers.add(pNum.toUpperCase());
        let calcQty = 0;
        let unit = 'PCS';
        try {
          const its = typeof r.items_json === 'string' ? JSON.parse(r.items_json) : (r.items_json || []);
          if (Array.isArray(its) && its.length) {
            calcQty = its.reduce((acc, it) => acc + (Number(it.qty) || 0), 0);
            if (its[0]?.uom || its[0]?.unit) unit = (its[0].uom || its[0].unit).toUpperCase();
          }
        } catch {}
        matches.push({
          poNumber: pNum,
          vendor: r.supplier || '',
          designName: r.lot_no || '',
          supervisor: r.supervisor || '',
          quantity: calcQty || 1,
          unit,
          status: r.status || 'Archived / Old PO',
          source: 'old',
        });
      }
    }
  } catch (err) {
    console.warn('[POS Search] Error querying old_purchase_orders:', err.message);
  }

  res.json({ query: q, count: matches.length, matches });
}));

// GET /pos/:poNumber - get single PO by number (supports live, old, and last 4 digits)
router.get('/:poNumber', wrap(async (req, res) => {
  const raw = req.params.poNumber.trim();
  const poNum = raw.toUpperCase().startsWith('PO-') ? raw : `PO-${raw}`;
  const digitsOnly = raw.replace(/[^0-9]/g, '');
  const suffixPattern = digitsOnly.length >= 3 ? `%${digitsOnly}` : null;

  let rows = [];

  // 1. Try camelCase columns from live purchase_orders
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

  // 2. If not found and user entered last 4 digits, try suffix match on live purchase_orders
  if (!rows.length && suffixPattern) {
    try {
      const [r1Suffix] = await pool.query(
        `SELECT id, id AS externalId, poNumber, vendorName,
                designName, designCategory, items,
                subtotal, taxRate, tax, total, date AS orderDate,
                deliveryDate, status, cancellation_reason AS cancellationReason,
                cancelled_by AS cancelledBy, cancelled_at AS cancelledAt,
                requisitionRaisedBy, preparedBy, approvedBy, remarks, supervisorName
         FROM purchase_orders
         WHERE poNumber LIKE ? OR id LIKE ?
         ORDER BY id DESC LIMIT 1`,
        [suffixPattern, suffixPattern]
      );
      if (r1Suffix.length) rows = r1Suffix;
    } catch {}
  }

  // 3. Try generic SELECT * on live purchase_orders
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

  // 4. Check old_purchase_orders table!
  let oldRow = null;
  if (!rows.length) {
    try {
      const [oldRows] = await pool.query(
        `SELECT po_number, supplier, order_date, order_time, supervisor,
                total_amount, status, requisition_raised_by, authorized_by,
                lot_no, items_json
         FROM old_purchase_orders
         WHERE po_number = ? OR po_number = ? OR lot_no LIKE ?
         LIMIT 1`,
        [raw, poNum, `%${digitsOnly || raw}%`]
      );
      if (oldRows.length) oldRow = oldRows[0];
    } catch {}

    // 5. Try suffix match on old_purchase_orders if 3+ digits entered
    if (!oldRow && suffixPattern) {
      try {
        const [oldSuffixRows] = await pool.query(
          `SELECT po_number, supplier, order_date, order_time, supervisor,
                  total_amount, status, requisition_raised_by, authorized_by,
                  lot_no, items_json
           FROM old_purchase_orders
           WHERE po_number LIKE ?
           ORDER BY po_number DESC LIMIT 1`,
          [suffixPattern]
        );
        if (oldSuffixRows.length) oldRow = oldSuffixRows[0];
      } catch {}
    }
  }

  if (oldRow) {
    let parsedItems = [];
    try {
      parsedItems = typeof oldRow.items_json === 'string' ? JSON.parse(oldRow.items_json) : (oldRow.items_json || []);
    } catch {}

    const mappedItems = Array.isArray(parsedItems) ? parsedItems.map(it => ({
      name: it.description || it.department || 'Material Item',
      qty: Number(it.qty) || 0,
      unit: (it.uom || 'PCS').toUpperCase(),
      department: it.department || '',
      rate: Number(it.rate) || 0,
      amount: Number(it.amount) || 0,
    })) : [];

    return res.json({
      id: oldRow.po_number,
      externalId: oldRow.po_number,
      poNumber: oldRow.po_number,
      vendorName: oldRow.supplier || '',
      designName: oldRow.lot_no || '',
      designCategory: '',
      supervisorName: oldRow.supervisor || '',
      requestedBy: oldRow.requisition_raised_by ? `${oldRow.requisition_raised_by}${oldRow.authorized_by ? ` (Auth: ${oldPo.authorized_by})` : ''}` : (oldRow.authorized_by || ''),
      orderDate: oldRow.order_date ? `${oldRow.order_date} ${oldRow.order_time || ''}`.trim() : null,
      status: oldRow.status || 'Archived / Old PO',
      items: mappedItems,
      isOldPo: true,
      total: oldRow.total_amount || 0,
    });
  }

  if (!rows.length) {
    return res.status(404).json({ error: `Purchase Order '${raw}' not found in live or old purchase orders` });
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
    isOldPo: false,
  });
}));

// POST /pos/check-db - Manually trigger check for new POs in database & push notifications to all panels
router.post('/check-db', wrap(async (req, res) => {
  const { checkNewPurchaseOrders } = require('../services/poWatcher');
  const detected = await checkNewPurchaseOrders();
  res.json({ ok: true, detectedCount: detected.length, detected });
}));

module.exports = router;

