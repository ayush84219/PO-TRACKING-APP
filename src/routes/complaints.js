const router = require('express').Router();
const pool = require('../db/pool');
const { wrap } = require('../middleware/errors');
const { authenticate } = require('../middleware/auth');
const { enqueueNotification } = require('../services/notificationQueue');
const { sendPush } = require('../services/push');
const { emitToUsers } = require('../services/socketService');
const { getUsersByRole } = require('../services/userDirectory');

router.use(authenticate);

/**
 * GET /complaints - List all Query Box / Complaint items
 */
router.get('/', wrap(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, po_number AS poNumber, lot_number AS lotNumber, reporter_id AS reporterId,
            reporter_name AS reporterName, supervisor_name AS supervisorName,
            issue_category AS issueCategory, comment, status, created_at AS createdAt
     FROM complaints_app
     ORDER BY id DESC LIMIT 100`
  );
  res.json({ items: rows });
}));

/**
 * POST /complaints - Raise a Query Box message (Notifies Admin ONLY as a clean message)
 */
router.post('/', wrap(async (req, res) => {
  const { poNumber, lotNumber, supervisorName, issueCategory, comment } = req.body || {};
  if (!poNumber || !comment) {
    return res.status(400).json({ error: 'poNumber and comment are required' });
  }

  const cleanPo = String(poNumber).trim().toUpperCase();
  const cleanLot = lotNumber ? String(lotNumber).trim().toUpperCase() : cleanPo;
  const reporterName = req.user.name || 'Staff';
  const category = String(issueCategory || 'General Query').trim();
  const text = String(comment).trim();

  const [result] = await pool.query(
    `INSERT INTO complaints_app (po_number, lot_number, reporter_id, reporter_name, supervisor_name, issue_category, comment, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`,
    [cleanPo, cleanLot, req.user.id, reporterName, supervisorName || null, category, text]
  );

  const complaintId = result.insertId;

  // Notify Admin ONLY (Query Box message — clean notification, no emergency siren alarm)
  const admins = await getUsersByRole(['admin'], { excludeUserId: req.user.id });
  const adminIds = admins.map(a => a.id);

  const title = `💬 Query Box: ${category} (${cleanPo})`;
  const message = `${reporterName} raised a query for ${cleanPo}: "${text}"`;
  const eventId = `EVT-QUERY-${complaintId}-${Date.now()}`;

  for (const admin of admins) {
    await enqueueNotification({
      lotNumber: cleanPo,
      eventId,
      userId: admin.id,
      targetRole: admin.role,
      title,
      message,
      payload: {
        eventId,
        complaintId,
        lotNumber: cleanPo,
        category,
        reporterName,
        type: 'query_box',
        isEmergencyAlarm: false,
      },
    }).catch(() => {});
  }

  if (adminIds.length > 0) {
    emitToUsers(adminIds, 'new_notification', {
      eventId,
      eventType: 'QUERY_BOX',
      billNumber: cleanPo,
      supplierName: category,
      materialDetails: text,
      scannerName: reporterName,
      scannerId: req.user.id,
      scanTime: new Date().toISOString(),
      source: 'Query Box',
      title,
      message,
      status: 'pending',
      isEmergencyAlarm: false,
      timestamp: new Date().toISOString(),
    });

    sendPush(adminIds, title, message, {
      lotNumber: cleanPo,
      eventId,
      type: 'query_box',
      isEmergencyAlarm: false,
    });
  }

  res.status(201).json({
    ok: true,
    item: {
      id: String(complaintId),
      poNumber: cleanPo,
      lotNumber: cleanLot,
      reporterId: req.user.id,
      reporterName,
      supervisorName: supervisorName || '',
      issueCategory: category,
      comment: text,
      status: 'open',
      createdAt: new Date().toISOString(),
    },
  });
}));

/**
 * PATCH /complaints/:id/status - Resolve or update Query Box status
 */
router.patch('/:id/status', wrap(async (req, res) => {
  const id = parseInt(req.params.id);
  const { status } = req.body || {};
  if (!['open', 'in_review', 'resolved'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  await pool.query('UPDATE complaints_app SET status = ? WHERE id = ?', [status, id]);
  res.json({ ok: true, id, status });
}));

module.exports = router;
