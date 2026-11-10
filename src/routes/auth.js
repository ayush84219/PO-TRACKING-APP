const router = require('express').Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const S = require('../validators/schemas');
const { wrap, AppError } = require('../middleware/errors');
const { authenticate } = require('../middleware/auth');
const { sha, tokenPair, refreshSecret } = require('../services/tokens');

const pub = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  baseRole: u.base_role || u.baseRole || u.role,
});

router.post('/register', wrap(async (req, res) => {
  const { name, email, password, role } = S.register.parse(req.body);
  const userRole = role || 'gate';
  const [ex] = await pool.query('SELECT id FROM user_app WHERE email = ?', [email]);
  if (ex.length) throw new AppError(409, 'Email already registered', 'email_taken');
  const hash = await bcrypt.hash(password, 10);
  const [r] = await pool.query(
    'INSERT INTO user_app (name, email, password_hash, role, base_role) VALUES (?,?,?,?,?)',
    [name, email, hash, userRole, userRole]
  );
  const user = { id: r.insertId, name, email, role: userRole, baseRole: userRole };
  res.status(201).json({ user: pub(user), ...(await tokenPair(user)) });
}));

router.post('/login', wrap(async (req, res) => {
  const { email, password } = S.login.parse(req.body);
  const [rows] = await pool.query('SELECT * FROM user_app WHERE email = ?', [email]);
  const u = rows[0];
  if (!u || !(await bcrypt.compare(password, u.password_hash))) throw new AppError(401, 'Wrong email or password', 'bad_credentials');
  if (!u.is_active) throw new AppError(403, 'This account is disabled', 'disabled');
  res.json({ user: pub(u), ...(await tokenPair(u)) });
}));

router.post('/refresh', wrap(async (req, res) => {
  const { refreshToken } = S.refresh.parse(req.body);
  let payload;
  try { payload = jwt.verify(refreshToken, refreshSecret); } catch { throw new AppError(401, 'Invalid refresh token', 'unauthorized'); }
  const [rows] = await pool.query(
    'SELECT id FROM refresh_tokens_app WHERE token_hash = ? AND revoked = 0 AND expires_at > NOW()', [sha(refreshToken)]);
  if (!rows.length) throw new AppError(401, 'Refresh token revoked', 'unauthorized');
  await pool.query('UPDATE refresh_tokens_app SET revoked = 1 WHERE id = ?', [rows[0].id]); // rotation
  const [us] = await pool.query('SELECT * FROM user_app WHERE id = ? AND is_active = 1', [payload.id]);
  if (!us.length) throw new AppError(401, 'User not available', 'unauthorized');
  res.json({ user: pub(us[0]), ...(await tokenPair(us[0])) });
}));

router.post('/logout', wrap(async (req, res) => {
  const t = req.body && req.body.refreshToken;
  if (t) await pool.query('UPDATE refresh_tokens_app SET revoked = 1 WHERE token_hash = ?', [sha(t)]);
  res.json({ ok: true });
}));

router.get('/me', authenticate, wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT id, name, email, role, base_role FROM user_app WHERE id = ?', [req.user.id]);
  if (!rows.length) throw new AppError(404, 'User not found');
  res.json({ user: pub(rows[0]) });
}));

router.post('/switch-role', authenticate, wrap(async (req, res) => {
  const { role } = req.body || {};
  if (!['admin', 'supervisor', 'gate', 'store', 'user'].includes(role)) {
    throw new AppError(400, 'Invalid role', 'invalid_role');
  }
  const [rows] = await pool.query('SELECT id, name, email, role, base_role FROM user_app WHERE id = ?', [req.user.id]);
  if (!rows.length) throw new AppError(404, 'User not found');
  const u = rows[0];
  const baseRole = u.base_role || u.role;
  if (role === 'admin' && baseRole !== 'admin') {
    throw new AppError(403, 'Only administrators can switch to admin panel', 'forbidden');
  }
  await pool.query('UPDATE user_app SET role = ? WHERE id = ?', [role, req.user.id]);
  const updated = { ...u, role, base_role: baseRole };
  res.json({ user: pub(updated), ...(await tokenPair(updated)) });
}));

router.patch('/password', authenticate, wrap(async (req, res) => {
  const { currentPassword, newPassword } = S.password.parse(req.body);
  const [rows] = await pool.query('SELECT password_hash FROM user_app WHERE id = ?', [req.user.id]);
  if (!rows.length || !(await bcrypt.compare(currentPassword, rows[0].password_hash))) throw new AppError(400, 'Current password is wrong', 'bad_credentials');
  await pool.query('UPDATE user_app SET password_hash = ? WHERE id = ?', [await bcrypt.hash(newPassword, 10), req.user.id]);
  await pool.query('UPDATE refresh_tokens_app SET revoked = 1 WHERE user_id = ?', [req.user.id]);
  res.json({ ok: true });
}));

module.exports = router;
