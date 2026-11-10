-- Sample materials. Create the admin user with:  npm run create-admin
USE materialscan;
INSERT IGNORE INTO materials_app (lot_number, material_name, status) VALUES
 ('LOT-1001','Steel Rod 12mm','pending'),
 ('LOT-1002','Copper Wire 2.5mm','pending'),
 ('LOT-1003','Aluminium Sheet 3mm','pending');
