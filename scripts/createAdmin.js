// Usage: npm run create-admin -- "Admin Name" admin@example.com StrongPassword123
const bcrypt = require('bcrypt');
const pool = require('../src/db/pool');
(async () => {
  const [name, email, password] = process.argv.slice(2);
  if (!name || !email || !password || password.length < 8) {
    console.error('Usage: npm run create-admin -- "Name" email password(min 8 chars)');
    process.exit(1);
  }
  const hash = await bcrypt.hash(password, 12);
  await pool.query(
    "INSERT INTO user_app (name, email, password_hash, role) VALUES (?,?,?,'admin') ON DUPLICATE KEY UPDATE role='admin', password_hash=VALUES(password_hash), is_active=1",
    [name, email.toLowerCase(), hash]);
  console.log(`Admin ready: ${email}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
