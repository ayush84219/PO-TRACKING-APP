const router = require('express').Router();
const pool = require('../db/pool');
const { wrap } = require('../middleware/errors');
const { authenticate, requireRole } = require('../middleware/auth');

router.get('/summary', authenticate, requireRole('admin'), wrap(async (req, res) => {
  const [[totalsRows], [days], [top], [recent]] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(status='completed'), 0) AS completed,
              COALESCE(SUM(status='in_progress'), 0) AS inProgress,
              COALESCE(SUM(status='pending'), 0) AS pending
       FROM scans_app`
    ),
    pool.query(
      `SELECT DATE(created_at) AS day, COUNT(*) AS count
       FROM scans_app
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
       GROUP BY DATE(created_at)`
    ),
    pool.query(
      `SELECT u.id, u.name, COUNT(*) AS count
       FROM scans_app s
       JOIN user_app u ON u.id = s.scanned_by
       GROUP BY u.id, u.name
       ORDER BY count DESC
       LIMIT 5`
    ),
    pool.query(
      `SELECT s.id, s.lot_number AS lotNumber, s.status, s.created_at AS createdAt,
              COALESCE(u.name, 'Gate Officer') AS scannedByName
       FROM scans_app s
       LEFT JOIN user_app u ON u.id = s.scanned_by
       ORDER BY s.created_at DESC, s.id DESC
       LIMIT 8`
    ),
  ]);

  const t = (totalsRows && totalsRows[0]) || { total: 0, completed: 0, inProgress: 0, pending: 0 };

  const map = new Map((days || []).map(d => [new Date(d.day).toISOString().slice(0, 10), +d.count]));
  const perDay = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    const k = d.toISOString().slice(0, 10);
    perDay.push({ day: k, count: map.get(k) || 0 });
  }

  res.json({
    totals: {
      total: +(t.total || 0),
      completed: +(t.completed || 0),
      inProgress: +(t.inProgress || 0),
      pending: +(t.pending || 0),
    },
    perDay,
    topScanners: (top || []).map(x => ({ ...x, count: +x.count })),
    recent: recent || [],
  });
}));

module.exports = router;
