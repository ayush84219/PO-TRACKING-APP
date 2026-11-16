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
            COALESCE(u.plain_password, 'SupervisorPassword123!') AS plainPassword,
            (SELECT COUNT(*) FROM scans_app s WHERE s.scanned_by = u.id) AS scanCount
     FROM user_app u ORDER BY u.created_at DESC`);
  res.json({
    items: rows.map(r => ({
      ...r,
      isActive: !!r.isActive,
      scanCount: +r.scanCount,
      plainPassword: r.plainPassword,
    }))
  });
}));

router.post('/', wrap(async (req, res) => {
  const parsed = S.createUser.parse(req.body);
  const name = parsed.name.trim();
  const email = parsed.email.trim().toLowerCase();
  const role = parsed.role || 'supervisor';

  // If creating an Admin account, require and verify the ADMIN_SECRET_KEY from .env
  if (role === 'admin') {
    const expectedKey = process.env.ADMIN_SECRET_KEY || 'bill520';
    const providedKey = parsed.secretKey || parsed.adminSecretKey || req.body.secretKey || req.body.adminSecretKey;
    if (!providedKey || String(providedKey).trim() !== String(expectedKey).trim()) {
      throw new AppError(
        403,
        'Invalid Admin Secret Key. The secret key (e.g. bill520) configured in server .env is required to create an Admin account.',
        'invalid_secret_key'
      );
    }
  }

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
    'INSERT INTO user_app (name, email, password_hash, role, base_role, is_active, plain_password) VALUES (?, ?, ?, ?, ?, 1, ?)',
    [name, email, hash, role, role, rawPassword]
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
      plainPassword: rawPassword,
    },
    message: `${role.toUpperCase()} added successfully!`,
  });
}));

router.patch('/:id/password', wrap(async (req, res) => {
  const id = parseInt(req.params.id);
  const newPassword = (req.body.password && String(req.body.password).trim().length >= 6)
    ? String(req.body.password).trim()
    : `Sup@${Math.floor(1000 + Math.random() * 9000)}`;

  const hash = await bcrypt.hash(newPassword, 10);
  const [r] = await pool.query(
    'UPDATE user_app SET password_hash = ?, plain_password = ? WHERE id = ?',
    [hash, newPassword, id]
  );
  if (!r.affectedRows) throw new AppError(404, 'User not found', 'not_found');

  // Revoke active sessions for that user
  await pool.query('UPDATE refresh_tokens_app SET revoked = 1 WHERE user_id = ?', [id]).catch(() => {});

  const [userRows] = await pool.query('SELECT id, name, email, role FROM user_app WHERE id = ?', [id]);
  const targetUser = userRows[0] || {};

  res.json({
    ok: true,
    user: {
      id: targetUser.id,
      name: targetUser.name,
      email: targetUser.email,
      role: targetUser.role,
      plainPassword: newPassword,
    },
    newPassword,
    message: `Password for ${targetUser.name || 'User'} updated successfully!`,
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

router.delete('/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.user.id) {
    throw new AppError(400, "You cannot delete your own admin account", 'invalid_action');
  }

  const [userRows] = await pool.query('SELECT id, name, email, role, is_active FROM user_app WHERE id = ?', [id]);
  if (!userRows.length) {
    throw new AppError(404, 'User not found', 'not_found');
  }
  const targetUser = userRows[0];

  // Safety Requirement: User must be disabled first before permanently deleting!
  if (targetUser.is_active && !req.query.force) {
    throw new AppError(
      400,
      `User #${id} (${targetUser.name}) is currently Active. Please disable the account first before deleting it.`,
      'must_disable_first'
    );
  }

  // Clean up references in related tables to avoid foreign key constraints
  await pool.query('DELETE FROM refresh_tokens_app WHERE user_id = ?', [id]).catch(() => {});
  await pool.query('DELETE FROM user_notification_settings_app WHERE user_id = ?', [id]).catch(() => {});
  await pool.query('DELETE FROM notification_queue_app WHERE user_id = ?', [id]).catch(() => {});
  await pool.query('DELETE FROM po_alarm_events_app WHERE recipient_user_id = ?', [id]).catch(() => {});
  await pool.query('UPDATE scans_app SET scanned_by = NULL WHERE scanned_by = ?', [id]).catch(() => {});
  await pool.query('UPDATE materials_app SET last_scanned_by = NULL WHERE last_scanned_by = ?', [id]).catch(() => {});

  const [del] = await pool.query('DELETE FROM user_app WHERE id = ?', [id]);
  if (!del.affectedRows) {
    throw new AppError(404, 'User not found', 'not_found');
  }

  res.json({
    ok: true,
    deletedId: id,
    name: targetUser.name,
    message: `User #${id} (${targetUser.name}) permanently deleted.`,
  });
}));

module.exports = router;
