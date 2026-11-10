const path = require('path');
const fs = require('fs');

const envCandidates = [
  path.resolve(__dirname, '../../.env'),
  path.resolve(__dirname, '../.env'),
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), 'backend/.env'),
  path.resolve(process.cwd(), 'MaterialScan/backend/.env'),
];

for (const p of envCandidates) {
  if (fs.existsSync(p)) {
    require('dotenv').config({ path: p });
    break;
  }
}
require('dotenv').config();

// Support both standard DB_* and Railway MYSQL_* / MYSQL_URL variables
let dbHost = process.env.DB_HOST || process.env.MYSQLHOST || process.env.MYSQL_HOST || 'localhost';
let dbPort = Number(process.env.DB_PORT || process.env.MYSQLPORT || process.env.MYSQL_PORT || 3306);
let dbUser = process.env.DB_USER || process.env.MYSQLUSER || process.env.MYSQL_USER;
let dbPassword = process.env.DB_PASSWORD !== undefined ? process.env.DB_PASSWORD : (process.env.MYSQLPASSWORD !== undefined ? process.env.MYSQLPASSWORD : (process.env.MYSQL_PASSWORD || ''));
let dbName = process.env.DB_NAME || process.env.MYSQLDATABASE || process.env.MYSQL_DATABASE;

const rawUrl = process.env.MYSQL_URL || process.env.DATABASE_URL;
if (rawUrl) {
  try {
    const u = new URL(rawUrl);
    // If the host is internal or missing, prefer the public proxy host from MYSQL_URL
    if (u.hostname && (!dbHost || dbHost === 'localhost' || dbHost.includes('.internal'))) {
      dbHost = u.hostname;
    }
    if (u.port) dbPort = Number(u.port);
    if (u.username) dbUser = decodeURIComponent(u.username);
    if (u.password !== undefined) dbPassword = decodeURIComponent(u.password);
    if (u.pathname && u.pathname.length > 1) dbName = u.pathname.slice(1);
  } catch (e) {
    // fallback to individual vars
  }
}

if (!dbUser) dbUser = 'root';
if (!dbName) dbName = 'materialscan';

module.exports = {
  port: process.env.PORT || 3000,
  db: {
    host: dbHost,
    port: dbPort,
    user: dbUser,
    password: dbPassword,
    database: dbName,
  },
  accessSecret: process.env.JWT_ACCESS_SECRET || 'fallback_access_secret_materialscan_2026',
  refreshSecret: process.env.JWT_REFRESH_SECRET || 'fallback_refresh_secret_materialscan_2026',
  oneSignal: { appId: process.env.ONESIGNAL_APP_ID, apiKey: process.env.ONESIGNAL_REST_API_KEY },
};
