/**
 * binarySearchService.js
 * 
 * Ultra-fast In-Memory Binary Search Index for POs, Zip POs, Doori POs, and RGPs.
 * Operates on sorted arrays in O(log N) time (< 0.1ms) and direct hash maps in O(1) time
 * instead of executing slow remote database full table scans over Railway network.
 */
const pool = require('../db/pool');

function parseColorBreakdown(colorBreakdown, defaultStyle = 'Material') {
  if (!colorBreakdown || typeof colorBreakdown !== 'string') return [];
  const items = [];
  const parts = colorBreakdown.split(';').map(p => p.trim()).filter(Boolean);
  for (const part of parts) {
    // Format: "BLACK [1]: 80pcs (Selected - Black)" or "BLACK [1]: 80 pcs"
    const m = part.match(/^([^:]+):\s*(\d+)\s*(?:pcs)?\s*(?:\((.*?)\))?/i);
    if (m) {
      const color = m[1].trim();
      const qty = parseInt(m[2], 10);
      const detail = m[3] ? ` (${m[3].trim()})` : '';
      items.push({
        name: `${defaultStyle} - ${color}${detail}`,
        qty,
        unit: 'PCS',
        department: 'Trim / Stitching',
      });
    }
  }
  return items;
}

class BinarySearchService {
  constructor() {
    this.isWarmedUp = false;
    this.lastRefreshedAt = null;
    this.refreshTimer = null;
    this.isRefreshing = false;

    // Standard PO Sorted Indexes
    this.posByExact = new Map(); // O(1) direct map
    this.posByPrefix = [];       // Sorted by poNumber for O(log N) prefix search
    this.posBySuffix = [];       // Sorted by numeric suffix for O(log N) suffix search
    this.posByVendor = [];       // Sorted by vendor for O(log N) vendor search

    // Zip PO Sorted Indexes
    this.zipByExact = new Map();
    this.zipByPrefix = [];
    this.zipBySuffix = [];

    // Doori PO Sorted Indexes
    this.dooriByExact = new Map();
    this.dooriByPrefix = [];
    this.dooriBySuffix = [];

    // RGP Sorted Indexes
    this.rgpsByExact = new Map(); // O(1) direct map
    this.rgpsByPrefix = [];       // Sorted by rgpNumber for O(log N) prefix search
    this.rgpsBySuffix = [];       // Sorted by numeric suffix for O(log N) suffix search
    this.rgpsByVendor = [];       // Sorted by vendor for O(log N) vendor search

    // Memory & Bandwidth Optimization: Cache static historical tables in RAM
    this.cachedOldPos = null;
    this.cachedOldRgps = null;
    this.cachedOldZip = null;
    this.cachedOldDoori = null;
    this.lastOldDataRefresh = 0;
  }

  // =========================================================================
  // CORE BINARY SEARCH ALGORITHMS (O(log N))
  // =========================================================================

  /**
   * Classic Binary Search for exact string match on sorted array
   */
  binarySearchExact(arr, targetKey, keyProp = 'key') {
    if (!arr || arr.length === 0 || !targetKey) return null;
    let low = 0;
    let high = arr.length - 1;
    const target = String(targetKey).toUpperCase().trim();

    while (low <= high) {
      const mid = (low + high) >> 1;
      const midVal = (arr[mid][keyProp] || '').toUpperCase();
      if (midVal === target) return arr[mid];
      if (midVal < target) low = mid + 1;
      else high = mid - 1;
    }
    return null;
  }

  /**
   * Binary Search for finding all items with matching suffix (e.g. "65031", "1021", "1480")
   */
  binarySearchSuffixMatches(arr, targetSuffix) {
    if (!arr || arr.length === 0 || !targetSuffix) return [];
    let low = 0;
    let high = arr.length - 1;
    const matches = [];
    const target = String(targetSuffix).trim();

    while (low <= high) {
      const mid = (low + high) >> 1;
      const midVal = String(arr[mid].suffix4 || '');
      const cmp = midVal.localeCompare(target);

      if (cmp === 0) {
        // Pivot match found: gather all adjacent elements with identical suffix
        let left = mid;
        while (left >= 0 && arr[left].suffix4 === target) {
          matches.push(arr[left]);
          left--;
        }
        let right = mid + 1;
        while (right < arr.length && arr[right].suffix4 === target) {
          matches.push(arr[right]);
          right++;
        }
        break;
      } else if (cmp < 0) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return matches;
  }

  /**
   * Binary Search for prefix range (e.g. "PO-11" or "ZIP-65")
   * Finds lower and upper bound in O(log N)
   */
  binarySearchPrefixRange(arr, prefix, keyProp = 'key') {
    if (!arr || arr.length === 0 || !prefix) return [];
    const p = String(prefix).toUpperCase();

    let low = 0;
    let high = arr.length - 1;
    let startIdx = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const midVal = (arr[mid][keyProp] || '').toUpperCase();
      if (midVal >= p) {
        startIdx = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    if (startIdx === -1) return [];

    const matches = [];
    for (let i = startIdx; i < arr.length; i++) {
      const val = (arr[i][keyProp] || '').toUpperCase();
      if (val.startsWith(p)) {
        matches.push(arr[i]);
      } else {
        break;
      }
    }
    return matches;
  }

  // =========================================================================
  // INDEX BUILDER & DATA REFRESH
  // =========================================================================

  async refreshIndex(forceOld = false) {
    if (this.isRefreshing) return;
    this.isRefreshing = true;
    const startTime = Date.now();

    try {
      const now = Date.now();
      const needOldRefresh = forceOld || !this.cachedOldPos || !this.cachedOldRgps || !this.cachedOldZip || !this.cachedOldDoori || (now - this.lastOldDataRefresh > 12 * 3600 * 1000);

      // Fetch live POs, RGPs, Zip & Doori every cycle; fetch historical archives on boot or every 12h
      const queries = [
        pool.query(`
          SELECT id, poNumber, vendorName, designName, designCategory, items, status, date,
                 supervisorName, preparedBy, requisitionRaisedBy, approvedBy
          FROM purchase_orders
        `).then(res => res[0]).catch(() => []),

        pool.query(`
          SELECT id, rgpNo, vendor, rgpType, department, purpose, entries, status, date,
                 expectedReturnDate, vehicleNo, preparedBy, authorizedBy
          FROM rgp
        `).then(res => res[0]).catch(() => []),

        pool.query(`
          SELECT id, po_number, Lot_Number, Garment_Type, Style, Fabric, Total_Pieces, Supervisor,
                 Gate_Entry_Person, Gate_Entry_Date, Material_Received_By, Material_Received_Date,
                 Supplier_Name, status, Issue_Date
          FROM zip
        `).then(res => res[0]).catch(() => []),

        pool.query(`
          SELECT id, po_number, Lot_Number, Garment_Type, Style, Fabric, Total_Pieces, Supervisor,
                 Gate_Entry_Person, Gate_Entry_Date, Material_Received_By, Material_Received_Date,
                 Supplier_Name, status, Issue_Date
          FROM doori
        `).then(res => res[0]).catch(() => []),
      ];

      if (needOldRefresh) {
        queries.push(
          pool.query(`
            SELECT po_number, supplier, order_date, supervisor, lot_no, items_json, status,
                   requisition_raised_by, authorized_by, total_amount
            FROM old_purchase_orders
          `).then(res => res[0]).catch(() => []),

          pool.query(`
            SELECT rgp_no, date, rgp_type, department, vendor, purpose, item_description,
                   quantity_sent, uom, expected_return_date, vehicle_no, authorized_by,
                   prepared_by, status, items_json
            FROM old_rgp
          `).then(res => res[0]).catch(() => []),

          pool.query(`
            SELECT id, Lot_Number, record_key, Timestamp, Garment_Type, Style, Fabric, Total_Pieces,
                   Supervisor, Issue_Date, Supplier_Name, Color_Breakdown, Zip_Requirements,
                   PDF_Generated_Date, Gate_Entry_Person, Gate_Entry_Date, Material_Received_By,
                   Material_Received_Date, Total_Cost
            FROM old_zip
          `).then(res => res[0]).catch(() => []),

          pool.query(`
            SELECT id, Lot_Number, record_key, Timestamp, Garment_Type, Style, Fabric, Total_Pieces,
                   Supervisor, Issue_Date, Supplier_Name, Color_Breakdown, Dori_Requirements,
                   PDF_Generated_Date, Gate_Entry_Person, Gate_Entry_Date, Material_Received_By,
                   Material_Received_Date, Total_Cost
            FROM old_doori
          `).then(res => res[0]).catch(() => [])
        );
      }

      const results = await Promise.all(queries);
      const pLive = results[0];
      const rLive = results[1];
      const zipLive = results[2] || [];
      const dooriLive = results[3] || [];

      if (needOldRefresh) {
        this.cachedOldPos = results[4] || [];
        this.cachedOldRgps = results[5] || [];
        this.cachedOldZip = results[6] || [];
        this.cachedOldDoori = results[7] || [];
        this.lastOldDataRefresh = now;
      }

      const pOld = this.cachedOldPos || [];
      const rOld = this.cachedOldRgps || [];
      const zipOld = this.cachedOldZip || [];
      const dooriOld = this.cachedOldDoori || [];

      // =====================================================================
      // 1. BUILD STANDARD PO INDEXES
      // =====================================================================
      const newPosByExact = new Map();
      const newPosByPrefix = [];
      const newPosBySuffix = [];
      const newPosByVendor = [];
      const seenPos = new Set();

      for (const p of pLive) {
        const num = (p.poNumber || '').toUpperCase().trim();
        if (!num || seenPos.has(num)) continue;
        seenPos.add(num);
        const digits = num.replace(/[^0-9]/g, '');
        const suffix4 = digits.slice(-4);
        const entry = {
          key: num,
          poNumber: num,
          digits,
          suffix4,
          vendor: p.vendorName || '',
          designName: p.designName || '',
          supervisor: p.supervisorName || '',
          status: p.status || 'Live',
          source: 'live',
          subType: 'PO',
          docType: 'PO',
          data: p,
          isOldPo: false,
        };
        newPosByExact.set(num, entry);
        if (digits) newPosByExact.set(digits, entry);
        newPosByPrefix.push(entry);
        if (suffix4) newPosBySuffix.push(entry);
        if (entry.vendor) newPosByVendor.push(entry);
      }

      for (const p of pOld) {
        const num = (p.po_number || '').toUpperCase().trim();
        if (!num || seenPos.has(num)) continue;
        seenPos.add(num);
        const digits = num.replace(/[^0-9]/g, '');
        const suffix4 = digits.slice(-4);
        const entry = {
          key: num,
          poNumber: num,
          digits,
          suffix4,
          vendor: p.supplier || '',
          designName: p.lot_no || 'Old PO Material',
          supervisor: p.supervisor || '',
          status: p.status || 'Archived / Old PO',
          source: 'old',
          subType: 'PO',
          docType: 'PO',
          data: p,
          isOldPo: true,
        };
        newPosByExact.set(num, entry);
        if (digits && !newPosByExact.has(digits)) newPosByExact.set(digits, entry);
        newPosByPrefix.push(entry);
        if (suffix4) newPosBySuffix.push(entry);
        if (entry.vendor) newPosByVendor.push(entry);
      }

      newPosByPrefix.sort((a, b) => a.key.localeCompare(b.key));
      newPosBySuffix.sort((a, b) => a.suffix4.localeCompare(b.suffix4));
      newPosByVendor.sort((a, b) => a.vendor.localeCompare(b.vendor));

      // =====================================================================
      // 2. BUILD ZIP PO INDEXES (Live & Old)
      // =====================================================================
      const newZipByExact = new Map();
      const newZipByPrefix = [];
      const newZipBySuffix = [];

      for (const z of zipLive) {
        const lotNum = String(z.Lot_Number || '').toUpperCase().trim();
        const poNum = (z.po_number || `ZIP-${lotNum}`).toUpperCase().trim();
        if (!poNum) continue;
        const digits = lotNum.replace(/[^0-9]/g, '') || poNum.replace(/[^0-9]/g, '');
        const suffix4 = digits.slice(-4);
        const styleName = z.Style || z.Garment_Type || 'Zip Material';
        const parsedItems = [{
          name: `Zip - ${styleName}`,
          qty: Number(z.Total_Pieces) || 1,
          unit: 'PCS',
          department: 'Trim / Stitching',
        }];

        const entry = {
          key: poNum,
          poNumber: poNum,
          lotNumber: lotNum,
          digits,
          suffix4,
          vendor: z.Supplier_Name || 'Zip Supplier',
          supplierName: z.Supplier_Name || 'Zip Supplier',
          designName: `Zip - ${styleName}`,
          materialName: `Zip - ${styleName} (${Number(z.Total_Pieces) || 1} PCS)`,
          supervisor: z.Supervisor || '',
          quantity: Number(z.Total_Pieces) || 1,
          expectedQuantity: Number(z.Total_Pieces) || 1,
          expectedUnit: 'PCS',
          unit: 'PCS',
          date: z.Issue_Date || z.Saved_At || null,
          status: z.status || (z.Material_Received_Date ? 'Received' : (z.Gate_Entry_Date ? 'At Gate' : 'Live')),
          source: 'zip',
          subType: 'ZIP',
          docType: 'PO',
          items: parsedItems,
          data: z,
          isOldPo: false,
        };
        newZipByExact.set(poNum, entry);
        if (lotNum) newZipByExact.set(lotNum, entry);
        if (digits) newZipByExact.set(digits, entry);
        newZipByPrefix.push(entry);
        if (suffix4) newZipBySuffix.push(entry);
      }

      for (const z of zipOld) {
        const lotNum = String(z.Lot_Number || '').toUpperCase().trim();
        const poNum = `ZIP-${lotNum}`;
        if (!lotNum) continue;
        const digits = lotNum.replace(/[^0-9]/g, '');
        const suffix4 = digits.slice(-4);
        const styleName = z.Style || z.Garment_Type || 'Zip Material';
        const breakdownItems = parseColorBreakdown(z.Color_Breakdown, `Zip ${styleName}`);
        const totalPieces = Number(z.Total_Pieces) || (breakdownItems.reduce((acc, it) => acc + it.qty, 0)) || 1;

        const entry = {
          key: poNum,
          poNumber: poNum,
          lotNumber: lotNum,
          digits,
          suffix4,
          vendor: z.Supplier_Name || 'Zip Supplier',
          supplierName: z.Supplier_Name || 'Zip Supplier',
          designName: `Zip - ${styleName}`,
          materialName: `Zip - ${styleName} (${totalPieces} PCS)`,
          supervisor: z.Supervisor || 'Rashmi',
          quantity: totalPieces,
          expectedQuantity: totalPieces,
          expectedUnit: 'PCS',
          unit: 'PCS',
          date: z.Issue_Date || z.Timestamp || z.PDF_Generated_Date || null,
          status: z.Material_Received_Date ? 'Received' : (z.Gate_Entry_Date ? 'At Gate' : 'Open'),
          source: 'old_zip',
          subType: 'ZIP',
          docType: 'PO',
          items: breakdownItems.length > 0 ? breakdownItems : [{
            name: `Zip - ${styleName}`,
            qty: totalPieces,
            unit: 'PCS',
            department: 'Trim / Stitching',
          }],
          data: z,
          isOldPo: true,
        };
        newZipByExact.set(poNum, entry);
        if (lotNum && !newZipByExact.has(lotNum)) newZipByExact.set(lotNum, entry);
        if (digits && !newZipByExact.has(digits)) newZipByExact.set(digits, entry);
        newZipByPrefix.push(entry);
        if (suffix4) newZipBySuffix.push(entry);
      }

      newZipByPrefix.sort((a, b) => a.key.localeCompare(b.key));
      newZipBySuffix.sort((a, b) => a.suffix4.localeCompare(b.suffix4));

      // =====================================================================
      // 3. BUILD DOORI PO INDEXES (Live & Old)
      // =====================================================================
      const newDooriByExact = new Map();
      const newDooriByPrefix = [];
      const newDooriBySuffix = [];

      for (const d of dooriLive) {
        const lotNum = String(d.Lot_Number || '').toUpperCase().trim();
        const poNum = (d.po_number || `DORI-${lotNum}`).toUpperCase().trim();
        if (!poNum) continue;
        const digits = lotNum.replace(/[^0-9]/g, '') || poNum.replace(/[^0-9]/g, '');
        const suffix4 = digits.slice(-4);
        const styleName = d.Style || d.Garment_Type || 'Doori Material';
        const parsedItems = [{
          name: `Doori - ${styleName}`,
          qty: Number(d.Total_Pieces) || 1,
          unit: 'PCS',
          department: 'Trim / Stitching',
        }];

        const entry = {
          key: poNum,
          poNumber: poNum,
          lotNumber: lotNum,
          digits,
          suffix4,
          vendor: d.Supplier_Name || 'Doori Supplier',
          supplierName: d.Supplier_Name || 'Doori Supplier',
          designName: `Doori - ${styleName}`,
          materialName: `Doori - ${styleName} (${Number(d.Total_Pieces) || 1} PCS)`,
          supervisor: d.Supervisor || '',
          quantity: Number(d.Total_Pieces) || 1,
          expectedQuantity: Number(d.Total_Pieces) || 1,
          expectedUnit: 'PCS',
          unit: 'PCS',
          date: d.Issue_Date || d.Timestamp || null,
          status: d.status || (d.Material_Received_Date ? 'Received' : (d.Gate_Entry_Date ? 'At Gate' : 'Live')),
          source: 'doori',
          subType: 'DORI',
          docType: 'PO',
          items: parsedItems,
          data: d,
          isOldPo: false,
        };
        newDooriByExact.set(poNum, entry);
        if (lotNum) newDooriByExact.set(lotNum, entry);
        if (digits) newDooriByExact.set(digits, entry);
        newDooriByPrefix.push(entry);
        if (suffix4) newDooriBySuffix.push(entry);
      }

      for (const d of dooriOld) {
        const lotNum = String(d.Lot_Number || '').toUpperCase().trim();
        const poNum = `DORI-${lotNum}`;
        if (!lotNum) continue;
        const digits = lotNum.replace(/[^0-9]/g, '');
        const suffix4 = digits.slice(-4);
        const styleName = d.Style || d.Garment_Type || 'Doori Material';
        const breakdownItems = parseColorBreakdown(d.Color_Breakdown, `Doori ${styleName}`);
        const totalPieces = Number(d.Total_Pieces) || (breakdownItems.reduce((acc, it) => acc + it.qty, 0)) || 1;

        const entry = {
          key: poNum,
          poNumber: poNum,
          lotNumber: lotNum,
          digits,
          suffix4,
          vendor: d.Supplier_Name || 'Doori Supplier',
          supplierName: d.Supplier_Name || 'Doori Supplier',
          designName: `Doori - ${styleName}`,
          materialName: `Doori - ${styleName} (${totalPieces} PCS)`,
          supervisor: d.Supervisor || 'Rashmi',
          quantity: totalPieces,
          expectedQuantity: totalPieces,
          expectedUnit: 'PCS',
          unit: 'PCS',
          date: d.Issue_Date || d.Timestamp || d.PDF_Generated_Date || null,
          status: d.Material_Received_Date ? 'Received' : (d.Gate_Entry_Date ? 'At Gate' : 'Open'),
          source: 'old_doori',
          subType: 'DORI',
          docType: 'PO',
          items: breakdownItems.length > 0 ? breakdownItems : [{
            name: `Doori - ${styleName}`,
            qty: totalPieces,
            unit: 'PCS',
            department: 'Trim / Stitching',
          }],
          data: d,
          isOldPo: true,
        };
        newDooriByExact.set(poNum, entry);
        if (lotNum && !newDooriByExact.has(lotNum)) newDooriByExact.set(lotNum, entry);
        if (digits && !newDooriByExact.has(digits)) newDooriByExact.set(digits, entry);
        newDooriByPrefix.push(entry);
        if (suffix4) newDooriBySuffix.push(entry);
      }

      newDooriByPrefix.sort((a, b) => a.key.localeCompare(b.key));
      newDooriBySuffix.sort((a, b) => a.suffix4.localeCompare(b.suffix4));

      // =====================================================================
      // 4. BUILD RGP INDEXES
      // =====================================================================
      const newRgpsByExact = new Map();
      const newRgpsByPrefix = [];
      const newRgpsBySuffix = [];
      const newRgpsByVendor = [];
      const seenRgps = new Set();

      for (const r of rLive) {
        const num = (r.rgpNo || `RGP-${r.id}`).toUpperCase().trim();
        if (!num || seenRgps.has(num)) continue;
        seenRgps.add(num);
        const digits = num.replace(/[^0-9]/g, '');
        const suffix4 = digits.slice(-4);
        const entry = {
          key: num,
          rgpNumber: num,
          digits,
          suffix4,
          vendor: r.vendor || '',
          purpose: r.purpose || r.rgpType || 'Job Work',
          department: r.department || '',
          status: r.status || 'Live',
          source: 'live',
          docType: 'RGP',
          data: r,
          isOldRgp: false,
        };
        newRgpsByExact.set(num, entry);
        if (digits) newRgpsByExact.set(digits, entry);
        newRgpsByPrefix.push(entry);
        if (suffix4) newRgpsBySuffix.push(entry);
        if (entry.vendor) newRgpsByVendor.push(entry);
      }

      for (const r of rOld) {
        const num = (r.rgp_no || '').toUpperCase().trim();
        if (!num || seenRgps.has(num)) continue;
        seenRgps.add(num);
        const digits = num.replace(/[^0-9]/g, '');
        const suffix4 = digits.slice(-4);
        const entry = {
          key: num,
          rgpNumber: num,
          digits,
          suffix4,
          vendor: r.vendor || '',
          purpose: r.purpose || r.item_description || r.rgp_type || 'Job Work',
          department: r.department || '',
          status: r.status || 'Archived / Old RGP',
          source: 'old',
          docType: 'RGP',
          data: r,
          isOldRgp: true,
        };
        newRgpsByExact.set(num, entry);
        if (digits && !newRgpsByExact.has(digits)) newRgpsByExact.set(digits, entry);
        newRgpsByPrefix.push(entry);
        if (suffix4) newRgpsBySuffix.push(entry);
        if (entry.vendor) newRgpsByVendor.push(entry);
      }

      newRgpsByPrefix.sort((a, b) => a.key.localeCompare(b.key));
      newRgpsBySuffix.sort((a, b) => a.suffix4.localeCompare(b.suffix4));
      newRgpsByVendor.sort((a, b) => a.vendor.localeCompare(b.vendor));

      // Atomic swap of indexes
      this.posByExact = newPosByExact;
      this.posByPrefix = newPosByPrefix;
      this.posBySuffix = newPosBySuffix;
      this.posByVendor = newPosByVendor;

      this.zipByExact = newZipByExact;
      this.zipByPrefix = newZipByPrefix;
      this.zipBySuffix = newZipBySuffix;

      this.dooriByExact = newDooriByExact;
      this.dooriByPrefix = newDooriByPrefix;
      this.dooriBySuffix = newDooriBySuffix;

      this.rgpsByExact = newRgpsByExact;
      this.rgpsByPrefix = newRgpsByPrefix;
      this.rgpsBySuffix = newRgpsBySuffix;
      this.rgpsByVendor = newRgpsByVendor;

      this.isWarmedUp = true;
      this.lastRefreshedAt = new Date();
      console.log(`[BinarySearchService] Index refreshed in ${Date.now() - startTime}ms. Indexed: ${this.posByPrefix.length} POs, ${this.zipByPrefix.length} Zip POs, ${this.dooriByPrefix.length} Doori POs, ${this.rgpsByPrefix.length} RGPs.`);
    } catch (err) {
      console.error('[BinarySearchService] Index refresh failed:', err.message);
    } finally {
      this.isRefreshing = false;
    }
  }

  // =========================================================================
  // HIGH SPEED SEARCH INTERFACES (Sub-Millisecond O(log N))
  // =========================================================================

  /**
   * Fast Binary Lookup for Zip Orders (O(1) & O(log N))
   */
  lookupZip(query) {
    if (!query) return null;
    const clean = String(query).trim().toUpperCase();
    const rawNum = clean.replace(/^ZIP[-/]?/i, '');
    const cleanZip = `ZIP-${rawNum}`;
    const digits = clean.replace(/[^0-9]/g, '');

    // 1. Direct O(1) exact map lookup
    const direct = this.zipByExact.get(clean) || this.zipByExact.get(cleanZip) || this.zipByExact.get(rawNum) || (digits ? this.zipByExact.get(digits) : null);
    if (direct) return direct;

    // 2. Binary search on sorted suffix array
    if (digits && digits.length >= 3) {
      const suffix4 = digits.slice(-4);
      const suffixMatches = this.binarySearchSuffixMatches(this.zipBySuffix, suffix4);
      for (const m of suffixMatches) {
        if (m.digits === digits || m.digits.endsWith(digits)) return m;
      }
    }

    // 3. Binary search on sorted prefix array
    const prefixMatch = this.binarySearchExact(this.zipByPrefix, cleanZip);
    if (prefixMatch) return prefixMatch;

    return null;
  }

  /**
   * Fast Binary Lookup for Doori Orders (O(1) & O(log N))
   */
  lookupDoori(query) {
    if (!query) return null;
    const clean = String(query).trim().toUpperCase();
    const rawNum = clean.replace(/^(DORI|DOORI)[-/]?/i, '');
    const cleanDoori = `DORI-${rawNum}`;
    const digits = clean.replace(/[^0-9]/g, '');

    // 1. Direct O(1) exact map lookup
    const direct = this.dooriByExact.get(clean) || this.dooriByExact.get(cleanDoori) || this.dooriByExact.get(rawNum) || (digits ? this.dooriByExact.get(digits) : null);
    if (direct) return direct;

    // 2. Binary search on sorted suffix array
    if (digits && digits.length >= 3) {
      const suffix4 = digits.slice(-4);
      const suffixMatches = this.binarySearchSuffixMatches(this.dooriBySuffix, suffix4);
      for (const m of suffixMatches) {
        if (m.digits === digits || m.digits.endsWith(digits)) return m;
      }
    }

    // 3. Binary search on sorted prefix array
    const prefixMatch = this.binarySearchExact(this.dooriByPrefix, cleanDoori);
    if (prefixMatch) return prefixMatch;

    return null;
  }

  /**
   * Fast Binary Lookup for single PO (O(1) & O(log N))
   */
  lookupPo(poNumber) {
    if (!poNumber) return null;
    const clean = String(poNumber).trim().toUpperCase();
    const cleanPo = clean.startsWith('PO-') ? clean : `PO-${clean}`;
    const rawPo = clean.replace(/^PO-/, '');
    const digits = clean.replace(/[^0-9]/g, '');

    // 1. Exact match
    const match = this.posByExact.get(clean) || this.posByExact.get(cleanPo) || this.posByExact.get(rawPo) || (digits ? this.posByExact.get(digits) : null);
    if (match) return match;

    // 2. Binary search suffix match if 3+ digits
    if (digits && digits.length >= 3) {
      const suffix4 = digits.slice(-4);
      const matches = this.binarySearchSuffixMatches(this.posBySuffix, suffix4);
      for (const m of matches) {
        if (m.digits.endsWith(digits)) return m;
      }
    }

    // 3. Binary search exact lookup
    const found = this.binarySearchExact(this.posByPrefix, cleanPo);
    if (found) return found;

    return null;
  }

  /**
   * Fast Binary Lookup for single RGP (O(1) & O(log N))
   */
  lookupRgp(rgpNumber) {
    if (!rgpNumber) return null;
    const clean = String(rgpNumber).trim().toUpperCase();
    const rawRgp = clean.replace(/^RGP[-/]?/i, '');
    const slashVariant = `RGP/${rawRgp}`;
    const dashVariant = `RGP-${rawRgp}`;
    const digits = clean.replace(/[^0-9]/g, '');

    // 1. Exact match
    const match = this.rgpsByExact.get(clean) || this.rgpsByExact.get(slashVariant) || this.rgpsByExact.get(dashVariant) || (digits ? this.rgpsByExact.get(digits) : null);
    if (match) return match;

    // 2. Binary search suffix match if 3+ digits
    if (digits && digits.length >= 3) {
      const suffix4 = digits.slice(-4);
      const matches = this.binarySearchSuffixMatches(this.rgpsBySuffix, suffix4);
      for (const m of matches) {
        if (m.digits.endsWith(digits)) return m;
      }
    }

    return null;
  }

  /**
   * Universal Fast Lookup using DSA
   * Reaches destination in < 0.1ms using indexed hierarchy
   */
  lookupFast(query, hintType = null) {
    if (!query) return null;
    const q = String(query).trim().toUpperCase();

    // Explicit hints
    if (hintType === 'zip' || hintType === 'ZIP' || q.startsWith('ZIP')) {
      return this.lookupZip(q);
    }
    if (hintType === 'doori' || hintType === 'DORI' || q.startsWith('DORI') || q.startsWith('DOORI')) {
      return this.lookupDoori(q);
    }
    if (hintType === 'rgp' || hintType === 'RGP' || q.startsWith('RGP')) {
      return this.lookupRgp(q);
    }

    // Check if starts with PO-
    if (q.startsWith('PO-')) {
      const poMatch = this.lookupPo(q);
      if (poMatch && !poMatch.isOldPo) return poMatch;
      // If not live PO, check zip or doori or old po
      const zipMatch = this.lookupZip(q);
      if (zipMatch) return zipMatch;
      const dooriMatch = this.lookupDoori(q);
      if (dooriMatch) return dooriMatch;
      if (poMatch) return poMatch;
    }

    // Raw Lot number (e.g. 65031)
    // 1. Check Live PO
    const livePo = this.posByExact.get(q);
    if (livePo && !livePo.isOldPo) return livePo;

    // 2. Check Zip PO (Live or Old, e.g. Lot 65031 Zip Requirement)
    const zipMatch = this.lookupZip(q);
    if (zipMatch) return zipMatch;

    // 3. Check Doori PO (Live or Old)
    const dooriMatch = this.lookupDoori(q);
    if (dooriMatch) return dooriMatch;

    // 4. Check Historical PO
    const oldPo = this.lookupPo(q);
    if (oldPo) return oldPo;

    // 5. Check RGP
    const rgpMatch = this.lookupRgp(q);
    if (rgpMatch) return rgpMatch;

    return null;
  }

  /**
   * Search Purchase Orders using Binary Search
   */
  searchPos(query, limit = 20) {
    if (!query) return [];
    const q = String(query).trim().toUpperCase();
    const digits = q.replace(/[^0-9]/g, '');
    const results = [];
    const seen = new Set();

    const addMatch = (item) => {
      if (item && !seen.has(item.key)) {
        seen.add(item.key);
        let calcQty = item.quantity || item.expectedQuantity || 0;
        let unit = item.unit || 'PCS';
        if (!calcQty && item.data) {
          try {
            const its = item.data.items || item.data.items_json;
            const parsed = typeof its === 'string' ? JSON.parse(its) : its;
            if (Array.isArray(parsed) && parsed.length) {
              calcQty = parsed.reduce((acc, it) => acc + (Number(it.qty || it.Qty || it.quantity || 0)), 0);
              if (parsed[0]?.unit || parsed[0]?.uom || parsed[0]?.UOM) {
                unit = (parsed[0].unit || parsed[0].uom || parsed[0].UOM).toUpperCase();
              }
            }
          } catch {}
        }
        results.push({
          poNumber: item.poNumber,
          lotNumber: item.lotNumber || item.poNumber,
          vendor: item.vendor,
          designName: item.designName,
          supervisor: item.supervisor,
          quantity: calcQty || 1,
          unit,
          status: item.status,
          source: item.source,
          subType: item.subType || 'PO',
          date: item.date || item.data?.date || item.data?.order_date || null,
        });
      }
    };

    // 1. Direct O(1) exact match
    const exact = this.posByExact.get(q) || this.zipByExact.get(q) || this.dooriByExact.get(q);
    if (exact) addMatch(exact);

    // 2. O(log N) Suffix Binary Search
    if (digits && digits.length >= 2) {
      const targetSuffix = digits.slice(-4);
      for (const m of this.binarySearchSuffixMatches(this.posBySuffix, targetSuffix)) {
        if (m.digits.endsWith(digits) || m.digits === digits) addMatch(m);
      }
      for (const m of this.binarySearchSuffixMatches(this.zipBySuffix, targetSuffix)) {
        if (m.digits.endsWith(digits) || m.digits === digits) addMatch(m);
      }
      for (const m of this.binarySearchSuffixMatches(this.dooriBySuffix, targetSuffix)) {
        if (m.digits.endsWith(digits) || m.digits === digits) addMatch(m);
      }
    }

    // 3. O(log N) Prefix Binary Search
    for (const m of this.binarySearchPrefixRange(this.posByPrefix, q)) {
      addMatch(m);
      if (results.length >= limit) break;
    }
    for (const m of this.binarySearchPrefixRange(this.zipByPrefix, q)) {
      addMatch(m);
      if (results.length >= limit) break;
    }
    for (const m of this.binarySearchPrefixRange(this.dooriByPrefix, q)) {
      addMatch(m);
      if (results.length >= limit) break;
    }

    // 4. Vendor Substring Search (if needed to fill limit)
    if (results.length < limit && q.length >= 3) {
      for (const m of this.posByPrefix) {
        if (m.vendor.toUpperCase().includes(q) || m.designName.toUpperCase().includes(q)) {
          addMatch(m);
          if (results.length >= limit) break;
        }
      }
    }

    return results.slice(0, limit);
  }

  /**
   * Search Returnable Gate Passes using Binary Search
   */
  searchRgps(query, limit = 20) {
    if (!query) return [];
    const q = String(query).trim().toUpperCase();
    const digits = q.replace(/[^0-9]/g, '');
    const results = [];
    const seen = new Set();

    const addMatch = (item) => {
      if (item && !seen.has(item.key)) {
        seen.add(item.key);
        results.push({
          rgpNumber: item.rgpNumber,
          vendor: item.vendor,
          purpose: item.purpose,
          department: item.department,
          status: item.status,
          source: item.source,
        });
      }
    };

    // 1. Direct O(1) exact match
    const exact = this.rgpsByExact.get(q);
    if (exact) addMatch(exact);

    // 2. O(log N) Suffix Binary Search
    if (digits && digits.length >= 2) {
      const targetSuffix = digits.slice(-4);
      const suffixMatches = this.binarySearchSuffixMatches(this.rgpsBySuffix, targetSuffix);
      for (const m of suffixMatches) {
        if (m.digits.endsWith(digits) || m.digits === digits) {
          addMatch(m);
        }
      }
    }

    // 3. O(log N) Prefix Binary Search
    const prefixMatches = this.binarySearchPrefixRange(this.rgpsByPrefix, q);
    for (const m of prefixMatches) {
      addMatch(m);
      if (results.length >= limit) break;
    }

    // 4. Vendor Substring Search
    if (results.length < limit && q.length >= 3) {
      for (const m of this.rgpsByPrefix) {
        if (m.vendor.toUpperCase().includes(q) || m.purpose.toUpperCase().includes(q)) {
          addMatch(m);
          if (results.length >= limit) break;
        }
      }
    }

    return results.slice(0, limit);
  }

  // =========================================================================
  // LIFECYCLE
  // =========================================================================

  warmup(intervalMs = 300000) {
    this.refreshIndex(true); // Load complete index including archives on boot
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => {
      this.refreshIndex(false); // Periodic lightweight refresh (only live tables)
    }, intervalMs);
  }

  notifyDataUpdated() {
    setTimeout(() => this.refreshIndex(), 500);
  }
}

const binarySearchService = new BinarySearchService();
module.exports = { binarySearchService };
