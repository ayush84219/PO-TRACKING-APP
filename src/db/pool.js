const mysql = require('mysql2/promise');
const { db } = require('../config/env');

const ssl = db.host && db.host !== 'localhost' && db.host !== '127.0.0.1'
  ? { rejectUnauthorized: false }
  : undefined;

module.exports = mysql.createPool({
  ...db,
  ssl,
  waitForConnections: true,
  connectionLimit: 5,        // Optimized for 10-user team (reduces server thread RAM)
  maxIdle: 2,                // Close extra idle connections
  idleTimeout: 30000,        // Close idle connections after 30s to save Railway memory
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  timezone: 'Z',
});
