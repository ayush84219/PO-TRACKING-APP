-- ============================================================================
-- MaterialScan Dedicated Application Schema
-- All tables are explicitly isolated with `_app` suffix to guarantee zero
-- conflict or data contamination with any other projects on the same database.
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_app (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(190) NOT NULL UNIQUE,
  password_hash VARCHAR(100) NOT NULL,
  role ENUM('admin','user','supervisor','gate') NOT NULL DEFAULT 'user',
  base_role ENUM('admin','supervisor','gate','user') NULL,
  app_name VARCHAR(100) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

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
);

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
);

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
);

CREATE TABLE IF NOT EXISTS refresh_tokens_app (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  revoked TINYINT(1) NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES user_app(id) ON DELETE CASCADE,
  INDEX idx_rt_app_hash (token_hash)
);

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
);

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
);

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
);

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
);
