const test = require('node:test');
const assert = require('node:assert');
const app = require('../src/app');
const pool = require('../src/db/pool');

let server, base;
const uniq = Date.now();
const call = async (path, { method = 'GET', body, token } = {}) => {
  const r = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

test.before(async () => {
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close();
  await pool.end();
});

test('role-based registration and panel switching permissions', async () => {
  // 1. Register as gate user
  const gateReg = await call('/auth/register', {
    method: 'POST',
    body: { name: 'Gate Officer', email: `gate_${uniq}@t.com`, password: 'password123', role: 'gate' },
  });
  assert.equal(gateReg.status, 201);
  assert.equal(gateReg.data.user.role, 'gate');
  assert.equal(gateReg.data.user.baseRole, 'gate');

  // 2. Gate user tries to switch to admin -> Should fail with 403 Forbidden
  const gateSwitch = await call('/auth/switch-role', {
    method: 'POST',
    token: gateReg.data.accessToken,
    body: { role: 'admin' },
  });
  assert.equal(gateSwitch.status, 403);

  // 3. Register as admin user
  const adminReg = await call('/auth/register', {
    method: 'POST',
    body: { name: 'Master Admin', email: `admin_${uniq}@t.com`, password: 'password123', role: 'admin' },
  });
  assert.equal(adminReg.status, 201);
  assert.equal(adminReg.data.user.role, 'admin');
  assert.equal(adminReg.data.user.baseRole, 'admin');

  // 4. Admin user switches to supervisor -> Should succeed
  const adminSwitchToSup = await call('/auth/switch-role', {
    method: 'POST',
    token: adminReg.data.accessToken,
    body: { role: 'supervisor' },
  });
  assert.equal(adminSwitchToSup.status, 200);
  assert.equal(adminSwitchToSup.data.user.role, 'supervisor');
  assert.equal(adminSwitchToSup.data.user.baseRole, 'admin');

  // 5. Admin (currently viewing supervisor) switches back to admin -> Should succeed because baseRole is admin
  const adminSwitchBack = await call('/auth/switch-role', {
    method: 'POST',
    token: adminSwitchToSup.data.accessToken,
    body: { role: 'admin' },
  });
  assert.equal(adminSwitchBack.status, 200);
  assert.equal(adminSwitchBack.data.user.role, 'admin');
  assert.equal(adminSwitchBack.data.user.baseRole, 'admin');
});

