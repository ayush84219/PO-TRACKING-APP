import os
import re
import csv
import json
from datetime import datetime
from dotenv import load_dotenv
import mysql.connector

# Load environment variables
ENV_PATH = os.path.join(os.path.dirname(__file__), '..', '.env')
load_dotenv(ENV_PATH)

CSV_PATH = os.path.join(os.path.dirname(__file__), '..', '..', 'demo2.csv')

def parse_date(val):
    if not val or str(val).strip().upper() in ('', 'NULL', 'NONE'):
        return None
    val = str(val).strip()
    for fmt in ('%d/%m/%Y %H:%M', '%d/%m/%Y', '%Y-%m-%d %H:%M:%S', '%Y-%m-%d'):
        try:
            return datetime.strptime(val, fmt)
        except ValueError:
            pass
    return None

def parse_float(val, default=0.0):
    if val is None:
        return default
    val_str = str(val).strip()
    if val_str.upper() in ('', 'NULL', 'NONE', '-'):
        return default
    try:
        return float(val_str)
    except ValueError:
        return default

def clean_str(val):
    if val is None:
        return None
    s = str(val).strip()
    if s.upper() in ('', 'NULL', 'NONE'):
        return None
    return s

def parse_demo2_csv(filepath):
    print(f"Reading CSV from: {filepath}")
    with open(filepath, 'r', encoding='utf-8') as f:
        lines = [line.strip() for line in f if line.strip()]

    header_line = lines[0]
    headers = [h.strip() for h in header_line.split(',')]
    print(f"Detected Headers ({len(headers)}): {headers}")

    records = []
    for idx, line in enumerate(lines[1:], 1):
        # Locate JSON items array: start bracket "[{" and end bracket "}]"
        start_bracket = line.find("[{")
        end_bracket = line.rfind("}]")
        if start_bracket == -1 or end_bracket == -1:
            print(f"  [Warning] Row {idx} missing bracket structure, skipping.")
            continue

        prefix_str = line[:start_bracket].rstrip('," ')
        json_str = line[start_bracket:end_bracket + 2]
        suffix_str = line[end_bracket + 2:].lstrip('," ')

        prefix_parts = list(csv.reader([prefix_str]))[0]
        suffix_parts = list(csv.reader([suffix_str]))[0]

        try:
            items = json.loads(json_str)
        except Exception as e:
            print(f"  [Error] Row {idx} JSON parse failure: {e}")
            items = []

        rec = {
            'external_id': clean_str(prefix_parts[0] if len(prefix_parts) > 0 else None),
            'po_number': clean_str(prefix_parts[1] if len(prefix_parts) > 1 else None),
            'vendor_name': clean_str(prefix_parts[2] if len(prefix_parts) > 2 else 'Unknown Vendor'),
            'design_name': clean_str(prefix_parts[3] if len(prefix_parts) > 3 else None),
            'design_category': clean_str(prefix_parts[4] if len(prefix_parts) > 4 else None),
            'items': items,
            'items_json': json.dumps(items),
            'subtotal': parse_float(suffix_parts[0] if len(suffix_parts) > 0 else 0),
            'tax_rate': parse_float(suffix_parts[1] if len(suffix_parts) > 1 else 18.0),
            'tax': parse_float(suffix_parts[2] if len(suffix_parts) > 2 else 0),
            'total': parse_float(suffix_parts[3] if len(suffix_parts) > 3 else 0),
            'order_date': parse_date(suffix_parts[4] if len(suffix_parts) > 4 else None),
            'delivery_date': parse_date(suffix_parts[5] if len(suffix_parts) > 5 else None),
            'status': clean_str(suffix_parts[6] if len(suffix_parts) > 6 else 'Sent to Vendor') or 'Sent to Vendor',
            'cancellation_reason': clean_str(suffix_parts[7] if len(suffix_parts) > 7 else None),
            'cancelled_by': clean_str(suffix_parts[8] if len(suffix_parts) > 8 else None),
            'cancelled_at': parse_date(suffix_parts[9] if len(suffix_parts) > 9 else None),
        }

        # Build human-readable material summary for items
        item_names = [f"{item.get('name', 'Item')} ({item.get('qty', '')} {item.get('unit', '')})".strip() for item in items]
        rec['items_summary'] = ", ".join(item_names) if item_names else rec['design_name'] or 'General Materials'

        records.append(rec)

    print(f"Parsed {len(records)} purchase order records from CSV.\n")
    return records

def init_db_and_import():
    records = parse_demo2_csv(CSV_PATH)
    if not records:
        print("No records to import.")
        return

    db_host = os.getenv('DB_HOST', 'localhost')
    db_port = int(os.getenv('DB_PORT', 3306))
    db_user = os.getenv('DB_USER', 'root')
    db_password = os.getenv('DB_PASSWORD', '')
    db_name = os.getenv('DB_NAME', 'materialscan')

    print(f"Connecting to MySQL database: {db_user}@{db_host}:{db_port}/{db_name}...")
    conn = mysql.connector.connect(
        host=db_host,
        port=db_port,
        user=db_user,
        password=db_password,
        database=db_name,
        autocommit=False
    )
    cursor = conn.cursor()

    try:
        # 1. Create purchase_orders table
        print("Creating table 'purchase_orders' if not exists...")
        create_table_sql = """
        CREATE TABLE IF NOT EXISTS purchase_orders (
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
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_po_num (po_number),
            INDEX idx_po_vendor (vendor_name),
            INDEX idx_po_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        """
        cursor.execute(create_table_sql)

        # 2. Insert or update PO records
        print("Upserting purchase orders into 'purchase_orders' table...")
        upsert_po_sql = """
        INSERT INTO purchase_orders (
            external_id, po_number, vendor_name, design_name, design_category,
            items, subtotal, tax_rate, tax, total,
            order_date, delivery_date, status,
            cancellation_reason, cancelled_by, cancelled_at
        ) VALUES (
            %(external_id)s, %(po_number)s, %(vendor_name)s, %(design_name)s, %(design_category)s,
            %(items_json)s, %(subtotal)s, %(tax_rate)s, %(tax)s, %(total)s,
            %(order_date)s, %(delivery_date)s, %(status)s,
            %(cancellation_reason)s, %(cancelled_by)s, %(cancelled_at)s
        ) ON DUPLICATE KEY UPDATE
            external_id = VALUES(external_id),
            vendor_name = VALUES(vendor_name),
            design_name = VALUES(design_name),
            design_category = VALUES(design_category),
            items = VALUES(items),
            subtotal = VALUES(subtotal),
            tax_rate = VALUES(tax_rate),
            tax = VALUES(tax),
            total = VALUES(total),
            order_date = VALUES(order_date),
            delivery_date = VALUES(delivery_date),
            status = VALUES(status),
            cancellation_reason = VALUES(cancellation_reason),
            cancelled_by = VALUES(cancelled_by),
            cancelled_at = VALUES(cancelled_at),
            updated_at = NOW();
        """

        param_keys = [
            'external_id', 'po_number', 'vendor_name', 'design_name', 'design_category',
            'items_json', 'subtotal', 'tax_rate', 'tax', 'total',
            'order_date', 'delivery_date', 'status',
            'cancellation_reason', 'cancelled_by', 'cancelled_at'
        ]
        for rec in records:
            params = {k: rec[k] for k in param_keys}
            cursor.execute(upsert_po_sql, params)

        print(f"Successfully processed {len(records)} purchase orders in database.")

        # 3. Synchronize POs into materials table for scanner/flow compatibility
        print("Synchronizing real POs into 'materials' table for scanning...")
        upsert_material_sql = """
        INSERT INTO materials (lot_number, material_name, status)
        VALUES (%s, %s, %s)
        ON DUPLICATE KEY UPDATE
            material_name = VALUES(material_name),
            status = VALUES(status);
        """

        mat_count = 0
        for rec in records:
            po_num = rec['po_number']
            mat_name = f"{rec['items_summary']} ({rec['vendor_name']})"
            # Map PO status to material status
            mat_status = 'completed' if rec['status'].lower() == 'received' else 'pending'

            # Insert both 'PO-11001' and '11001' format if applicable
            cursor.execute(upsert_material_sql, (po_num, mat_name[:150], mat_status))
            mat_count += 1

            # If po_num starts with PO-, also support searching by raw number e.g. 11001
            if po_num.startswith('PO-'):
                raw_num = po_num[3:]
                cursor.execute(upsert_material_sql, (raw_num, mat_name[:150], mat_status))
                mat_count += 1

        conn.commit()
        print(f"Committed transaction: {len(records)} POs and {mat_count} material lot identifiers ready.\n")

        # 4. Verify table contents
        cursor.execute("SELECT id, po_number, vendor_name, total, status FROM purchase_orders ORDER BY id ASC")
        rows = cursor.fetchall()
        print("--- Table 'purchase_orders' sample data ---")
        for r in rows:
            print(f"ID: {r[0]:<3} | PO: {r[1]:<10} | Vendor: {r[2]:<22} | Total: {float(r[3]):<8.2f} | Status: {r[4]}")

    except Exception as e:
        conn.rollback()
        print(f"Database error occurred: {e}")
        raise
    finally:
        cursor.close()
        conn.close()
        print("Database connection closed.")

if __name__ == '__main__':
    init_db_and_import()
