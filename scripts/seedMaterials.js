const pool = require('../src/db/pool');

const demoItems = [
  { lot: 'LOT-1001', name: 'Steel Rod 12mm [PO-8801]', status: 'pending' },
  { lot: 'PO-8801', name: 'Steel Rod 12mm (PO-8801 / Lot LOT-1001)', status: 'pending' },
  { lot: 'LOT-1002', name: 'Copper Wire 2.5mm [PO-8802]', status: 'in_progress' },
  { lot: 'PO-8802', name: 'Copper Wire 2.5mm (PO-8802 / Lot LOT-1002)', status: 'in_progress' },
  { lot: 'LOT-1003', name: 'Aluminium Sheet 3mm [PO-8803]', status: 'completed' },
  { lot: 'PO-8803', name: 'Aluminium Sheet 3mm (PO-8803 / Lot LOT-1003)', status: 'completed' },
  { lot: 'LOT-1004', name: 'Industrial Flange ANSI 150 [PO-8804]', status: 'pending' },
  { lot: 'PO-8804', name: 'Industrial Flange ANSI 150 (PO-8804 / Lot LOT-1004)', status: 'pending' },
  { lot: 'LOT-1005', name: 'Hydraulic High Pressure Hose [PO-8805]', status: 'in_progress' },
  { lot: 'PO-8805', name: 'Hydraulic High Pressure Hose (PO-8805 / Lot LOT-1005)', status: 'in_progress' },
  { lot: 'LOT-1006', name: 'Stainless Fasteners M8x40 [PO-8806]', status: 'completed' },
  { lot: 'PO-8806', name: 'Stainless Fasteners M8x40 (PO-8806 / Lot LOT-1006)', status: 'completed' }
];

async function seed() {
  console.log('Seeding demo materials and POs...');
  for (const item of demoItems) {
    const [existing] = await pool.query('SELECT id FROM materials_app WHERE lot_number = ?', [item.lot]);
    if (existing.length) {
      await pool.query('UPDATE materials_app SET material_name = ?, status = ? WHERE lot_number = ?', [item.name, item.status, item.lot]);
    } else {
      await pool.query('INSERT INTO materials_app (lot_number, material_name, status) VALUES (?, ?, ?)', [item.lot, item.name, item.status]);
    }
  }
  console.log('Seeded successfully!');
  process.exit(0);
}

seed().catch(err => {
  console.error(err);
  process.exit(1);
});
