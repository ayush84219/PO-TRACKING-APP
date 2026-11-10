// Usage: node scripts/seedDemoUsers.js
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const bcrypt = require('bcrypt');
const pool = require('../src/db/pool');

(async () => {
  console.log('Seeding demo accounts into database...');
  const adminHash = await bcrypt.hash('AdminPassword123!', 12);
  const userHash = await bcrypt.hash('UserPassword123!', 12);
  const supHash = await bcrypt.hash('SupervisorPassword123!', 12);
  const gateHash = await bcrypt.hash('GatePassword123!', 12);

  await pool.query(
    "INSERT INTO user_app (name, email, password_hash, role, is_active) VALUES ('Admin User', 'admin@materialscan.com', ?, 'admin', 1) " +
    "ON DUPLICATE KEY UPDATE role='admin', password_hash=VALUES(password_hash), is_active=1",
    [adminHash]
  );
  console.log('✅ Admin Account:  admin@materialscan.com / AdminPassword123!');

  await pool.query(
    "INSERT INTO user_app (name, email, password_hash, role, is_active) VALUES ('Admin Operations', 'admin@billtracking.com', ?, 'admin', 1) " +
    "ON DUPLICATE KEY UPDATE role='admin', password_hash=VALUES(password_hash), is_active=1",
    [adminHash]
  );
  console.log('✅ Admin Account:  admin@billtracking.com / AdminPassword123!');

  await pool.query(
    "INSERT INTO user_app (name, email, password_hash, role, is_active) VALUES ('Amit Kumar (Warehouse A)', 'supervisor@billtracking.com', ?, 'supervisor', 1) " +
    "ON DUPLICATE KEY UPDATE role='supervisor', password_hash=VALUES(password_hash), is_active=1",
    [supHash]
  );
  console.log('✅ Supervisor Account: supervisor@billtracking.com / SupervisorPassword123!');

  await pool.query(
    "INSERT INTO user_app (name, email, password_hash, role, is_active) VALUES ('Ramesh Security (Gate 1)', 'gate@billtracking.com', ?, 'gate', 1) " +
    "ON DUPLICATE KEY UPDATE role='gate', password_hash=VALUES(password_hash), is_active=1",
    [gateHash]
  );
  console.log('✅ Gate Account:   gate@billtracking.com / GatePassword123!');

  const storeHash = await bcrypt.hash('StorePassword123!', 12);
  await pool.query(
    "INSERT INTO user_app (name, email, password_hash, role, is_active) VALUES ('Store Manager (Main Store)', 'store@billtracking.com', ?, 'store', 1) " +
    "ON DUPLICATE KEY UPDATE role='store', password_hash=VALUES(password_hash), is_active=1",
    [storeHash]
  );
  console.log('✅ Store Account:  store@billtracking.com / StorePassword123!');

  await pool.query(
    "INSERT INTO user_app (name, email, password_hash, role, is_active) VALUES ('Demo Operator', 'user@materialscan.com', ?, 'user', 1) " +
    "ON DUPLICATE KEY UPDATE role='user', password_hash=VALUES(password_hash), is_active=1",
    [userHash]
  );
  console.log('✅ User Account:   user@materialscan.com / UserPassword123!');

  process.exit(0);
})().catch((e) => {
  console.error('Error seeding demo accounts:', e.message);
  process.exit(1);
});
