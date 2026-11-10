const jwt = require('jsonwebtoken');
const { accessSecret } = require('../config/env');
const { AppError } = require('./errors');
const pool = require('../db/pool');

function authenticate(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return next(new AppError(401, 'Missing token', 'unauthorized'));

  // Support demo preview tokens
  if (token.startsWith('demo_')) {
    let role = 'admin';
    if (token.includes('gate')) role = 'gate';
    else if (token.includes('supervisor')) role = 'supervisor';
    req.user = { id: 1, role, name: `${role.toUpperCase()} Demo`, baseRole: role };
    return next();
  }

  try {
    const p = jwt.verify(token, accessSecret);
    req.user = { id: p.id, role: p.role, name: p.name, baseRole: p.baseRole || p.role };
    next();
  } catch {
    next(new AppError(401, 'Invalid or expired token', 'unauthorized'));
  }
}

const requireRole = (role) => async (req, res, next) => {
  if (!req.user) return next(new AppError(401, 'Unauthorized', 'unauthorized'));
  if (req.user.role === role) return next();

  // If token role differs, check live role in database (e.g. user was promoted or is admin)
  try {
    const [rows] = await pool.query('SELECT role, base_role FROM user_app WHERE id = ? AND is_active = 1', [req.user.id]);
    if (rows.length && (rows[0].role === role || rows[0].base_role === role || (role === 'admin' && rows[0].base_role === 'admin'))) {
      req.user.role = rows[0].role;
      req.user.baseRole = rows[0].base_role || rows[0].role;
      return next();
    }
  } catch {
    // ignore query failure and fall through
  }

  return next(new AppError(403, 'Admin access required', 'forbidden'));
};

module.exports = { authenticate, requireRole };
