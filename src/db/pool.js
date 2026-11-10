const mysql = require('mysql2/promise');
const { db } = require('../config/env');

const ssl = db.host && db.host !== 'localhost' && db.host !== '127.0.0.1'
  ? { rejectUnauthorized: false }
  : undefined;

module.exports = mysql.createPool({
  ...db,
  ssl,
  waitForConnections: true,
  connectionLimit: 10,
  timezone: 'Z',
});
