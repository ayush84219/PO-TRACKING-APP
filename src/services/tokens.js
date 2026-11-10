const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../db/pool');
const { accessSecret, refreshSecret } = require('../config/env');

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const signAccess = (u) =>
  jwt.sign(
    {
      id: u.id,
      role: u.role,
      name: u.name,
      baseRole: u.baseRole || u.base_role || u.role,
    },
    accessSecret,
    { expiresIn: '15m' }
  );

async function issueRefresh(userId) {
  const token = jwt.sign({ id: userId }, refreshSecret, { expiresIn: '7d', jwtid: crypto.randomUUID() });
  const exp = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  await pool.query('INSERT INTO refresh_tokens_app (user_id, token_hash, expires_at) VALUES (?,?,?)', [userId, sha(token), exp]);
  return token;
}
async function tokenPair(u) {
  return { accessToken: signAccess(u), refreshToken: await issueRefresh(u.id) };
}
module.exports = { sha, signAccess, issueRefresh, tokenPair, refreshSecret };
