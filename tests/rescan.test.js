// Needs a running MySQL with schema.sql loaded and a valid .env.   Run: npm test
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
test.after(async () => { server.close(); await pool.end(); });

test('rescan of a completed lot notifies original scanner; admin routes are protected', async () => {
  const a = await call('/auth/register', { method: 'POST', body: { name: 'Ann', email: `ann${uniq}@t.com`, password: 'password123' } });
  const b = await call('/auth/register', { method: 'POST', body: { name: 'Bob', email: `bob${uniq}@t.com`, password: 'password123' } });
  const lot = `T-${uniq}`;

  const first = await call('/scans', { method: 'POST', token: a.data.accessToken, body: { lotNumber: lot, materialName: 'Test', status: 'completed' } });
  assert.equal(first.status, 201);
  assert.equal(first.data.rescanned, false);

  const second = await call('/scans', { method: 'POST', token: b.data.accessToken, body: { lotNumber: lot, status: 'in_progress' } });
  assert.equal(second.data.rescanned, true);

  const n = await call('/notifications', { token: a.data.accessToken });
  assert.ok(n.data.items.some(i => i.message === `Lot ${lot} has been scanned again by Bob`));

  const mine = await call('/scans/my', { token: b.data.accessToken });
  assert.equal(mine.data.items.length, 1);
  assert.equal((await call('/scans', { token: b.data.accessToken })).status, 403);
  assert.equal((await call('/scans/my')).status, 401);
});

test('lot that was never completed does not notify', async () => {
  const a = await call('/auth/register', { method: 'POST', body: { name: 'Cy', email: `cy${uniq}@t.com`, password: 'password123' } });
  const lot = `N-${uniq}`;
  await call('/scans', { method: 'POST', token: a.data.accessToken, body: { lotNumber: lot, materialName: 'X', status: 'pending' } });
  const again = await call('/scans', { method: 'POST', token: a.data.accessToken, body: { lotNumber: lot, status: 'in_progress' } });
  assert.equal(again.data.rescanned, false);
});
