const router = require('express').Router();
const bcrypt = require('bcrypt');
const pool = require('../db/pool');
const S = require('../validators/schemas');
const { wrap, AppError } = require('../middleware/errors');
const { authenticate, requireRole } = require('../middleware/auth');

router.use(authenticate, requireRole('admin'));

router.get('/', wrap(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT u.id, u.name, u.email, u.role, u.is_active AS isActive, u.created_at AS createdAt,
            (SELECT COUNT(*) FROM scans_app s WHERE s.scanned_by = u.id) AS scanCount
     FROM user_app u ORDER BY u.created_at DESC`);
  res.json({ items: rows.map(r => ({ ...r, isActive: !!r.isActive, scanCount: +r.scanCount })) });
}));

router.post('/', wrap(async (req, res) => {
  const parsed = S.createUser.parse(req.body);
  const name = parsed.name.trim();
  const email = parsed.email.trim().toLowerCase();
  const role = parsed.role || 'supervisor';

  // Check if email already registered
  const [existing] = await pool.query('SELECT id FROM user_app WHERE email = ?', [email]);
  if (existing.length > 0) {
    throw new AppError(409, `User with email "${email}" already exists`, 'email_taken');
  }

  // Use provided password or auto-generate one
  const rawPassword = (parsed.password && parsed.password.trim().length >= 6)
    ? parsed.password.trim()
    : `Sup@${Math.floor(1000 + Math.random() * 9000)}`;

  const hash = await bcrypt.hash(rawPassword, 10);

  const [result] = await pool.query(
    'INSERT INTO user_app (name, email, password_hash, role, base_role, is_active) VALUES (?, ?, ?, ?, ?, 1)',
    [name, email, hash, role, role]
  );

  res.status(201).json({
    ok: true,
    user: {
      id: result.insertId,
      name,
      email,
      role,
      isActive: true,
      scanCount: 0,
      createdAt: new Date().toISOString(),
      tempPassword: rawPassword,
    },
    message: `${role.toUpperCase()} added successfully!`,
  });
}));

router.patch('/:id/role', wrap(async (req, res) => {
  const { role } = S.role.parse(req.body);
  const id = parseInt(req.params.id);
  if (id === req.user.id) throw new AppError(400, "You can't change your own role", 'invalid');
  const [r] = await pool.query('UPDATE user_app SET role = ? WHERE id = ?', [role, id]);
  if (!r.affectedRows) throw new AppError(404, 'User not found', 'not_found');
  res.json({ ok: true });
}));

router.patch('/:id/active', wrap(async (req, res) => {
  const { isActive } = S.active.parse(req.body);
  const id = parseInt(req.params.id);
  if (id === req.user.id) throw new AppError(400, "You can't disable yourself", 'invalid');
  const [r] = await pool.query('UPDATE user_app SET is_active = ? WHERE id = ?', [isActive ? 1 : 0, id]);
  if (!r.affectedRows) throw new AppError(404, 'User not found', 'not_found');
  if (!isActive) await pool.query('UPDATE refresh_tokens_app SET revoked = 1 WHERE user_id = ?', [id]);
  res.json({ ok: true });
}));
module.exports = router;
