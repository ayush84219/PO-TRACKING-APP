require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const pool = require('../src/db/pool');

(async () => {
  console.log('Modifying users table role enum...');
  await pool.query("ALTER TABLE users MODIFY COLUMN role ENUM('admin','supervisor','gate','user') NOT NULL DEFAULT 'user'");
  console.log('Promoting Ayush (ay104061@gmail.com) to admin...');
  await pool.query("UPDATE users SET role = 'admin' WHERE email = 'ay104061@gmail.com'");
  
  // Also seed demo accounts so demo buttons on LoginScreen work seamlessly
  const bcrypt = require('bcrypt');
  const adminHash = await bcrypt.hash('AdminPassword123!', 12);
  const supHash = await bcrypt.hash('SupervisorPassword123!', 12);
  const gateHash = await bcrypt.hash('GatePassword123!', 12);

  await pool.query(
    "INSERT INTO users (name, email, password_hash, role, is_active) VALUES ('Admin Operations', 'admin@billtracking.com', ?, 'admin', 1) " +
    "ON DUPLICATE KEY UPDATE role='admin', password_hash=VALUES(password_hash), is_active=1",
    [adminHash]
  );
  await pool.query(
    "INSERT INTO users (name, email, password_hash, role, is_active) VALUES ('Amit Kumar (Warehouse A)', 'supervisor@billtracking.com', ?, 'supervisor', 1) " +
    "ON DUPLICATE KEY UPDATE role='supervisor', password_hash=VALUES(password_hash), is_active=1",
    [supHash]
  );
  await pool.query(
    "INSERT INTO users (name, email, password_hash, role, is_active) VALUES ('Ramesh Security (Gate 1)', 'gate@billtracking.com', ?, 'gate', 1) " +
    "ON DUPLICATE KEY UPDATE role='gate', password_hash=VALUES(password_hash), is_active=1",
    [gateHash]
  );

  const [users] = await pool.query('SELECT id, name, email, role, is_active FROM users');
  console.log('Current users in DB:', users);
  process.exit(0);
})().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
