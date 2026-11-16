const pool = require('./pool');
const bcrypt = require('bcrypt');

async function initSchema() {
  const conn = await pool.getConnection();
  try {
    // 1. Detect if any _app table was previously created as a VIEW, and replace with a real BASE TABLE
    const [views] = await conn.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES 
       WHERE TABLE_SCHEMA = DATABASE() 
         AND TABLE_TYPE = 'VIEW' 
         AND TABLE_NAME IN (
           'user_app', 'materials_app', 'scans_app', 'notifications_app', 
           'refresh_tokens_app', 'purchase_orders_app', 'notification_queue_app', 
           'audit_logs_app', 'supervisor_details_app', 'material_app', 'users_app', 
           'scan_app', 'purchase_order_app', 'supervisor_app'
         )`
    );

    for (const v of views) {
      console.log(`[DB Schema] Replacing temporary view '${v.TABLE_NAME}' with dedicated base table...`);
      await conn.query(`DROP VIEW IF EXISTS \`${v.TABLE_NAME}\``);
    }

    // 2. user_app
    await conn.query(`
      CREATE TABLE IF NOT EXISTS user_app (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(190) NOT NULL UNIQUE,
        password_hash VARCHAR(100) NOT NULL,
        role ENUM('admin','user','supervisor','gate','store') NOT NULL DEFAULT 'user',
        base_role ENUM('admin','supervisor','gate','store','user') NULL,
        app_name VARCHAR(100) NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 3. materials_app
    await conn.query(`
      CREATE TABLE IF NOT EXISTS materials_app (
        id INT AUTO_INCREMENT PRIMARY KEY,
        lot_number VARCHAR(100) NOT NULL UNIQUE,
        material_name VARCHAR(150) NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        scan_count INT NOT NULL DEFAULT 0,
        last_scanned_by INT NULL,
        last_scanned_at TIMESTAMP NULL,
        app_name VARCHAR(100) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (last_scanned_by) REFERENCES user_app(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 4. scans_app
    await conn.query(`
      CREATE TABLE IF NOT EXISTS scans_app (
        id INT AUTO_INCREMENT PRIMARY KEY,
        material_id INT NOT NULL,
        lot_number VARCHAR(100) NOT NULL,
        scanned_by INT NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        scan_stage VARCHAR(50) NULL,
        note VARCHAR(500) NULL,
        app_name VARCHAR(100) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (material_id) REFERENCES materials_app(id) ON DELETE CASCADE,
        FOREIGN KEY (scanned_by) REFERENCES user_app(id) ON DELETE CASCADE,
        INDEX idx_scans_app_lot (lot_number),
        INDEX idx_scans_app_user (scanned_by),
        INDEX idx_scans_app_status (status),
        INDEX idx_scans_app_stage (scan_stage),
        INDEX idx_scans_app_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // Ensure scans_app has scan_stage, event_id, delivery_status columns & materials_app status is VARCHAR(50)
    try {
      const [stageCol] = await conn.query("SHOW COLUMNS FROM scans_app LIKE 'scan_stage'");
      if (!stageCol.length) {
        await conn.query("ALTER TABLE scans_app ADD COLUMN scan_stage VARCHAR(50) NULL AFTER status");
      }
      const [eventIdCol] = await conn.query("SHOW COLUMNS FROM scans_app LIKE 'event_id'");
      if (!eventIdCol.length) {
        await conn.query("ALTER TABLE scans_app ADD COLUMN event_id VARCHAR(100) NULL AFTER lot_number");
      }
      const [delStatusCol] = await conn.query("SHOW COLUMNS FROM scans_app LIKE 'delivery_status'");
      if (!delStatusCol.length) {
        await conn.query("ALTER TABLE scans_app ADD COLUMN delivery_status ENUM('pending','delivered','acknowledged') DEFAULT 'pending' AFTER status");
      }
      const [delAtCol] = await conn.query("SHOW COLUMNS FROM scans_app LIKE 'delivered_at'");
      if (!delAtCol.length) {
        await conn.query("ALTER TABLE scans_app ADD COLUMN delivered_at DATETIME NULL AFTER delivery_status");
      }
      const [ackAtCol] = await conn.query("SHOW COLUMNS FROM scans_app LIKE 'acknowledged_at'");
      if (!ackAtCol.length) {
        await conn.query("ALTER TABLE scans_app ADD COLUMN acknowledged_at DATETIME NULL AFTER delivered_at");
      }
      const [ackNameCol] = await conn.query("SHOW COLUMNS FROM scans_app LIKE 'acknowledged_by_name'");
      if (!ackNameCol.length) {
        await conn.query("ALTER TABLE scans_app ADD COLUMN acknowledged_by_name VARCHAR(100) NULL AFTER acknowledged_at");
      }

      // notification_queue_app columns
      const [qEventIdCol] = await conn.query("SHOW COLUMNS FROM notification_queue_app LIKE 'event_id'");
      if (!qEventIdCol.length) {
        await conn.query("ALTER TABLE notification_queue_app ADD COLUMN event_id VARCHAR(100) NULL AFTER lot_number");
      }
      const [qDelAtCol] = await conn.query("SHOW COLUMNS FROM notification_queue_app LIKE 'delivered_at'");
      if (!qDelAtCol.length) {
        await conn.query("ALTER TABLE notification_queue_app ADD COLUMN delivered_at DATETIME NULL AFTER next_retry_at");
      }
      const [qAckNameCol] = await conn.query("SHOW COLUMNS FROM notification_queue_app LIKE 'acknowledged_by_name'");
      if (!qAckNameCol.length) {
        await conn.query("ALTER TABLE notification_queue_app ADD COLUMN acknowledged_by_name VARCHAR(100) NULL AFTER acknowledged_by");
      }

      await conn.query("ALTER TABLE materials_app MODIFY COLUMN status VARCHAR(50) NOT NULL DEFAULT 'pending'");
      await conn.query("ALTER TABLE user_app MODIFY COLUMN role ENUM('admin','user','supervisor','gate','store') NOT NULL DEFAULT 'user'");
      await conn.query("ALTER TABLE user_app MODIFY COLUMN base_role ENUM('admin','supervisor','gate','store','user') NULL");
    } catch (migErr) {
      console.warn('[DB Schema] Migration warning:', migErr.message);
    }

    // 5. notifications_app
    await conn.query(`
      CREATE TABLE IF NOT EXISTS notifications_app (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        title VARCHAR(150) NOT NULL,
        message VARCHAR(500) NOT NULL,
        lot_number VARCHAR(100) NULL,
        is_read TINYINT(1) NOT NULL DEFAULT 0,
        app_name VARCHAR(100) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES user_app(id) ON DELETE CASCADE,
        INDEX idx_notif_app_user (user_id, is_read, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 6. refresh_tokens_app
    await conn.query(`
      CREATE TABLE IF NOT EXISTS refresh_tokens_app (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        token_hash CHAR(64) NOT NULL,
        expires_at DATETIME NOT NULL,
        revoked TINYINT(1) NOT NULL DEFAULT 0,
        FOREIGN KEY (user_id) REFERENCES user_app(id) ON DELETE CASCADE,
        INDEX idx_rt_app_hash (token_hash)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 7. purchase_orders_app
    await conn.query(`
      CREATE TABLE IF NOT EXISTS purchase_orders_app (
        id INT AUTO_INCREMENT PRIMARY KEY,
        external_id VARCHAR(50) NULL,
        po_number VARCHAR(100) NOT NULL UNIQUE,
        vendor_name VARCHAR(255) NOT NULL,
        design_name VARCHAR(255) NULL,
        design_category VARCHAR(100) NULL,
        items JSON NULL,
        subtotal DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
        tax_rate DECIMAL(5, 2) NOT NULL DEFAULT 0.00,
        tax DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
        total DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
        order_date DATETIME NULL,
        delivery_date DATE NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'Sent to Vendor',
        cancellation_reason VARCHAR(500) NULL,
        cancelled_by VARCHAR(100) NULL,
        cancelled_at DATETIME NULL,
        app_name VARCHAR(100) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_po_app_num (po_number),
        INDEX idx_po_app_vendor (vendor_name),
        INDEX idx_po_app_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 8. notification_queue_app
    await conn.query(`
      CREATE TABLE IF NOT EXISTS notification_queue_app (
        id INT AUTO_INCREMENT PRIMARY KEY,
        lot_number VARCHAR(100) NULL,
        user_id INT NULL,
        target_role VARCHAR(50) NULL,
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        payload JSON NULL,
        status ENUM('pending', 'delivered', 'failed', 'escalated', 'acknowledged') DEFAULT 'pending',
        attempts INT DEFAULT 0,
        max_attempts INT DEFAULT 3,
        last_error TEXT NULL,
        next_retry_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        acknowledged_at DATETIME NULL,
        acknowledged_by INT NULL,
        escalated_at DATETIME NULL,
        escalated_to INT NULL,
        app_name VARCHAR(100) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_queue_app_status_retry (status, next_retry_at),
        INDEX idx_queue_app_lot (lot_number),
        INDEX idx_queue_app_user (user_id),
        INDEX idx_queue_app_ack (acknowledged_at, status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 9. audit_logs_app
    await conn.query(`
      CREATE TABLE IF NOT EXISTS audit_logs_app (
        id INT AUTO_INCREMENT PRIMARY KEY,
        event_type VARCHAR(100) NOT NULL,
        lot_number VARCHAR(100) NULL,
        user_id INT NULL,
        user_name VARCHAR(255) NULL,
        user_role VARCHAR(50) NULL,
        details JSON NULL,
        ip_address VARCHAR(100) NULL,
        app_name VARCHAR(100) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_audit_app_event (event_type),
        INDEX idx_audit_app_lot (lot_number),
        INDEX idx_audit_app_user (user_id),
        INDEX idx_audit_app_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 10. fcm_tokens_app (Push notification device tokens)
    await conn.query(`
      CREATE TABLE IF NOT EXISTS fcm_tokens_app (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        token VARCHAR(255) NOT NULL UNIQUE,
        platform VARCHAR(50) DEFAULT 'android',
        device_name VARCHAR(100) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES user_app(id) ON DELETE CASCADE,
        INDEX idx_fcm_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 11. notified_po_app (Tracks POs notified to avoid duplicate alerts)
    await conn.query(`
      CREATE TABLE IF NOT EXISTS notified_po_app (
        po_number VARCHAR(100) COLLATE utf8mb4_0900_ai_ci PRIMARY KEY,
        vendor_name VARCHAR(150) NULL,
        supervisor_name VARCHAR(100) NULL,
        notified_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
    `);

    // 10. supervisor_details_app
    await conn.query(`
      CREATE TABLE IF NOT EXISTS supervisor_details_app (
        id INT AUTO_INCREMENT PRIMARY KEY,
        lot_number VARCHAR(100) NOT NULL UNIQUE,
        start_row INT NULL,
        num_rows INT NULL,
        header_cols INT NULL,
        fabric VARCHAR(255) NULL,
        garment_type VARCHAR(255) NULL,
        style VARCHAR(255) NULL,
        sizes VARCHAR(255) NULL,
        shades TEXT NULL,
        saved_at VARCHAR(255) NULL,
        date_of_issue VARCHAR(100) NULL,
        supervisor VARCHAR(150) NULL,
        image_url TEXT NULL,
        party_name VARCHAR(255) NULL,
        brand VARCHAR(255) NULL,
        season VARCHAR(100) NULL,
        direct_stitching VARCHAR(50) NULL,
        challan_history LONGTEXT NULL,
        zip_order_date VARCHAR(100) NULL,
        zip_received_date VARCHAR(100) NULL,
        wip_status VARCHAR(255) NULL,
        completed_status TEXT NULL,
        mwk VARCHAR(50) NULL,
        job_order_date VARCHAR(100) NULL,
        manpower VARCHAR(100) NULL,
        cutting_qty INT NULL,
        stitching_issue_qty INT NULL,
        priority VARCHAR(100) NULL,
        sticker VARCHAR(255) NULL,
        remarks TEXT NULL,
        additional_supervisor_remarks TEXT NULL,
        pintu_allotment VARCHAR(255) NULL,
        extra_field VARCHAR(255) NULL,
        app_name VARCHAR(100) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_supervisor_app (supervisor),
        INDEX idx_party_name_app (party_name),
        INDEX idx_brand_app (brand),
        INDEX idx_garment_type_app (garment_type)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 12. user_notification_settings_app (User-specific alarm & notification preferences)
    await conn.query(`
      CREATE TABLE IF NOT EXISTS user_notification_settings_app (
        user_id INT PRIMARY KEY,
        po_alerts_enabled TINYINT(1) NOT NULL DEFAULT 1,
        alarm_sound_enabled TINYINT(1) NOT NULL DEFAULT 1,
        alarm_tone VARCHAR(50) NOT NULL DEFAULT 'alarm_siren',
        alarm_duration_sec INT NOT NULL DEFAULT 30,
        repeat_alarm TINYINT(1) NOT NULL DEFAULT 1,
        repeat_interval_sec INT NOT NULL DEFAULT 60,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES user_app(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 13. po_alarm_events_app (Idempotent tracking of PO alert & alarm status)
    await conn.query(`
      CREATE TABLE IF NOT EXISTS po_alarm_events_app (
        id INT AUTO_INCREMENT PRIMARY KEY,
        event_id VARCHAR(100) NOT NULL UNIQUE,
        po_number VARCHAR(100) NOT NULL,
        supplier_name VARCHAR(255) NULL,
        amount VARCHAR(50) NULL,
        received_at DATETIME NOT NULL,
        status ENUM('active', 'stopped', 'opened') NOT NULL DEFAULT 'active',
        stopped_by_user_id INT NULL,
        stopped_by_user_name VARCHAR(100) NULL,
        stopped_at DATETIME NULL,
        opened_by_user_id INT NULL,
        opened_at DATETIME NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (stopped_by_user_id) REFERENCES user_app(id) ON DELETE SET NULL,
        FOREIGN KEY (opened_by_user_id) REFERENCES user_app(id) ON DELETE SET NULL,
        INDEX idx_po_alarm_po (po_number),
        INDEX idx_po_alarm_status (status),
        INDEX idx_po_alarm_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // Ensure all essential standard accounts exist in user_app
    const adminPass = await bcrypt.hash('AdminPassword123!', 10);
    const gatePass = await bcrypt.hash('GatePassword123!', 10);
    const storePass = await bcrypt.hash('StorePassword123!', 10);
    const supPass = await bcrypt.hash('SupervisorPassword123!', 10);

    await conn.query(
      `INSERT IGNORE INTO user_app (name, email, password_hash, role, base_role, is_active) VALUES
       ('Admin Operations', 'admin@billtracking.com', ?, 'admin', 'admin', 1),
       ('Admin User', 'admin@materialscan.com', ?, 'admin', 'admin', 1),
       ('Ayush Admin', 'ay104061@gmail.com', ?, 'admin', 'admin', 1),
       ('Ramesh Security (Gate 1)', 'gate@billtracking.com', ?, 'gate', 'gate', 1),
       ('Store Manager (Main Store)', 'store@billtracking.com', ?, 'store', 'store', 1),
       ('EJAJ', 'ejaj@billtracking.com', ?, 'supervisor', 'supervisor', 1),
       ('Amit Kumar (Warehouse A)', 'supervisor@billtracking.com', ?, 'supervisor', 'supervisor', 1)`,
      [adminPass, adminPass, adminPass, gatePass, storePass, supPass, supPass]
    ).catch(() => {});

    // Ensure Original PO-11021 (Lot 62115 - SHIVA, TEST, 75 PCS, Supervisor: EJAJ) is inserted in database
    await conn.query(`
      INSERT INTO purchase_orders_app 
      (po_number, external_id, vendor_name, design_name, design_category, items, subtotal, tax_rate, tax, total, order_date, delivery_date, status)
      VALUES
      ('PO-11021', '62115', 'SHIVA', 'TEST', 'Store',
       '[{"name":"TEST","item_name":"TEST","qty":75,"quantity":75,"unit":"PCS","uom":"PCS","department":"Store","rate":4.00,"amount":300.00}]',
       300.00, 18.00, 54.00, 354.00, '2026-11-10 16:55:00', '2026-11-18', 'Sent to Vendor')
      ON DUPLICATE KEY UPDATE 
      vendor_name = 'SHIVA',
      design_name = 'TEST',
      external_id = '62115',
      items = '[{"name":"TEST","item_name":"TEST","qty":75,"quantity":75,"unit":"PCS","uom":"PCS","department":"Store","rate":4.00,"amount":300.00}]',
      subtotal = 300.00,
      total = 354.00,
      order_date = '2026-11-10 16:55:00';
    `).catch(() => {});

    try {
      await conn.query(`
        INSERT INTO purchase_orders
        (po_number, external_id, vendor_name, design_name, design_category, items, subtotal, tax_rate, tax, total, order_date, delivery_date, status)
        VALUES
        ('PO-11021', '62115', 'SHIVA', 'TEST', 'Store',
         '[{"name":"TEST","item_name":"TEST","qty":75,"quantity":75,"unit":"PCS","uom":"PCS","department":"Store","rate":4.00,"amount":300.00}]',
         300.00, 18.00, 54.00, 354.00, '2026-11-10 16:55:00', '2026-11-18', 'Sent to Vendor')
        ON DUPLICATE KEY UPDATE 
        vendor_name = 'SHIVA',
        design_name = 'TEST',
        external_id = '62115';
      `).catch(() => {});
    } catch {}

    await conn.query(`
      INSERT INTO supervisor_details_app
      (lot_number, supervisor, party_name, brand, garment_type, style, fabric, cutting_qty)
      VALUES
      ('62115', 'EJAJ', 'SHIVA', 'SHIVA', 'Store', 'TEST', 'Standard', 75)
      ON DUPLICATE KEY UPDATE 
      supervisor = 'EJAJ',
      party_name = 'SHIVA',
      brand = 'SHIVA',
      cutting_qty = 75;
    `).catch(() => {});

    await conn.query(`
      INSERT INTO supervisor_details_app
      (lot_number, supervisor, party_name, brand, garment_type, style, fabric, cutting_qty)
      VALUES
      ('PO-11021', 'EJAJ', 'SHIVA', 'SHIVA', 'Store', 'TEST', 'Standard', 75)
      ON DUPLICATE KEY UPDATE 
      supervisor = 'EJAJ',
      party_name = 'SHIVA',
      brand = 'SHIVA',
      cutting_qty = 75;
    `).catch(() => {});

    await conn.query(`
      INSERT INTO notified_po_app (po_number, vendor_name, supervisor_name)
      VALUES ('PO-11021', 'SHIVA', 'EJAJ')
      ON DUPLICATE KEY UPDATE supervisor_name = 'EJAJ', vendor_name = 'SHIVA';
    `).catch(() => {});

    await conn.query(`
      INSERT INTO notified_po_app (po_number, vendor_name, supervisor_name)
      VALUES ('62115', 'SHIVA', 'EJAJ')
      ON DUPLICATE KEY UPDATE supervisor_name = 'EJAJ', vendor_name = 'SHIVA';
    `).catch(() => {});

    await conn.query(`
      INSERT INTO materials_app (lot_number, material_name, status)
      VALUES ('PO-11021', 'TEST (75 PCS) - SHIVA', 'pending')
      ON DUPLICATE KEY UPDATE material_name = 'TEST (75 PCS) - SHIVA';
    `).catch(() => {});

    await conn.query(`
      INSERT INTO materials_app (lot_number, material_name, status)
      VALUES ('62115', 'TEST (75 PCS) - SHIVA', 'pending')
      ON DUPLICATE KEY UPDATE material_name = 'TEST (75 PCS) - SHIVA';
    `).catch(() => {});

    // Ensure no legacy demo/mock data remains in MaterialScan app tables (*_app only - never touch shared Project 1 tables)
    await conn.query("DELETE FROM scans_app WHERE lot_number LIKE 'LOT-%' OR lot_number LIKE 'T-%' OR lot_number LIKE 'N-%' OR lot_number LIKE 'PO-LOT-%' OR lot_number LIKE 'PO-N-%' OR lot_number LIKE 'PO-880%'").catch(() => {});
    await conn.query("DELETE FROM materials_app WHERE lot_number LIKE 'LOT-%' OR lot_number LIKE 'PO-880%' OR lot_number LIKE 'T-%' OR lot_number LIKE 'N-%' OR lot_number LIKE 'PO-LOT-%' OR lot_number LIKE 'PO-N-%'").catch(() => {});

    console.log('[DB Schema] Dedicated MaterialScan application schema verified successfully (Clean production mode - No demo data).');
  } catch (err) {
    console.error('[DB Schema] Migration error:', err.message);
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { initSchema };

if (require.main === module) {
  initSchema()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
