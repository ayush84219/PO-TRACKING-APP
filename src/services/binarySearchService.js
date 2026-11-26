/**
 * binarySearchService.js
 * 
 * Ultra-fast In-Memory Binary Search Index for POs and RGPs.
 * Operates on sorted arrays in O(log N) time (< 0.1ms) instead of
 * executing slow remote database full table scans over Railway network.
 */
const pool = require('../db/pool');

class BinarySearchService {
  constructor() {
    this.isWarmedUp = false;
    this.lastRefreshedAt = null;
    this.refreshTimer = null;
    this.isRefreshing = false;

    // PO Sorted Indexes
    this.posByExact = new Map(); // O(1) direct map
    this.posByPrefix = [];       // Sorted by poNumber for O(log N) prefix search
    this.posBySuffix = [];       // Sorted by 4-digit / numeric suffix for O(log N) suffix search
    this.posByVendor = [];       // Sorted by vendor for O(log N) vendor search

    // RGP Sorted Indexes
    this.rgpsByExact = new Map(); // O(1) direct map
    this.rgpsByPrefix = [];       // Sorted by rgpNumber for O(log N) prefix search
    this.rgpsBySuffix = [];       // Sorted by 4-digit / numeric suffix for O(log N) suffix search
    this.rgpsByVendor = [];       // Sorted by vendor for O(log N) vendor search

    // Memory & Bandwidth Optimization: Cache static historical tables in RAM
    this.cachedOldPos = null;
    this.cachedOldRgps = null;
    this.lastOldDataRefresh = 0;
  }

  // =========================================================================
  // CORE BINARY SEARCH ALGORITHMS (O(log N))
  // =========================================================================

  /**
   * Classic Binary Search for exact string match on sorted array
   */
  binarySearchExact(arr, targetKey, keyProp = 'key') {
    if (!arr || arr.length === 0) return null;
    let low = 0;
    let high = arr.length - 1;
    const target = targetKey.toUpperCase();

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
   * Binary Search for finding all items with matching suffix
   * (e.g. last 4 digits "1021" or "1480")
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
        // Found a pivot! Gather all elements with same suffix on left and right
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
   * Binary Search for prefix range (e.g. "PO-11" or "RGP/2026")
   * Finds lower and upper bound in O(log N)
   */
  binarySearchPrefixRange(arr, prefix, keyProp = 'key') {
    if (!arr || arr.length === 0 || !prefix) return [];
    const p = prefix.toUpperCase();
    
    // Lower bound: first index where val >= p
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
      const needOldRefresh = forceOld || !this.cachedOldPos || !this.cachedOldRgps || (now - this.lastOldDataRefresh > 12 * 3600 * 1000);

      // Fetch live POs, RGPs, Zip & Doori every cycle; fetch historical archives only once on boot or every 12h
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
          SELECT id, po_number, Lot_Number, Garment_Type, Style, Total_Pieces, Supervisor,
                 Gate_Entry_Person, Gate_Entry_Date, Material_Received_By, Material_Received_Date,
                 Supplier_Name, status, Issue_Date
          FROM zip
        `).then(res => res[0]).catch(() => []),

        pool.query(`
          SELECT id, po_number, Lot_Number, Garment_Type, Style, Total_Pieces, Supervisor,
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
            SELECT id, Lot_Number, record_key
            FROM old_zip
          `).then(res => res[0]).catch(() => []),

          pool.query(`
            SELECT id, Lot_Number, record_key
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

      // --- Build PO Indexes ---
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
          designName: p.lot_no || '',
          supervisor: p.supervisor || '',
          status: p.status || 'Archived / Old PO',
          source: 'old',
          data: p,
          isOldPo: true,
        };
        newPosByExact.set(num, entry);
        if (digits) newPosByExact.set(digits, entry);
        newPosByPrefix.push(entry);
        if (suffix4) newPosBySuffix.push(entry);
        if (entry.vendor) newPosByVendor.push(entry);
      }

      // --- Index Live & Old Zip POs ---
      for (const z of zipLive) {
        const poNum = (z.po_number || `ZIP-${z.Lot_Number}`).toUpperCase().trim();
        const lotNum = String(z.Lot_Number || '').toUpperCase().trim();
        if (!poNum || seenPos.has(poNum)) continue;
        seenPos.add(poNum);
        const digits = lotNum.replace(/[^0-9]/g, '') || poNum.replace(/[^0-9]/g, '');
        const suffix4 = digits.slice(-4);
        const entry = {
          key: poNum,
          poNumber: poNum,
          lotNumber: lotNum,
          digits,
          suffix4,
          vendor: z.Supplier_Name || 'Zip Supplier',
          designName: z.Style || `Zip - ${z.Garment_Type || 'Garment'}`,
          supervisor: z.Supervisor || '',
          status: z.status || (z.Material_Received_Date ? 'Received' : (z.Gate_Entry_Date ? 'At Gate' : 'Live')),
          source: 'zip',
          subType: 'ZIP',
          data: z,
          isOldPo: false,
        };
        newPosByExact.set(poNum, entry);
        if (lotNum) newPosByExact.set(lotNum, entry);
        if (digits) newPosByExact.set(digits, entry);
        newPosByPrefix.push(entry);
        if (suffix4) newPosBySuffix.push(entry);
        if (entry.vendor) newPosByVendor.push(entry);
      }

      for (const z of zipOld) {
        const lotNum = String(z.Lot_Number || '').toUpperCase().trim();
        const poNum = `ZIP-${lotNum}`;
        if (!lotNum || seenPos.has(poNum)) continue;
        seenPos.add(poNum);
        const digits = lotNum.replace(/[^0-9]/g, '');
        const suffix4 = digits.slice(-4);
        const entry = {
          key: poNum,
          poNumber: poNum,
          lotNumber: lotNum,
          digits,
          suffix4,
          vendor: 'Historical Zip Supplier',
          designName: `Old Zip Lot ${lotNum}`,
          supervisor: '',
          status: 'Archived / Old Zip',
          source: 'old_zip',
          subType: 'ZIP',
          data: z,
          isOldPo: true,
        };
        newPosByExact.set(poNum, entry);
        newPosByExact.set(lotNum, entry);
        if (digits) newPosByExact.set(digits, entry);
        newPosByPrefix.push(entry);
        if (suffix4) newPosBySuffix.push(entry);
      }

      // --- Index Live & Old Doori POs ---
      for (const d of dooriLive) {
        const poNum = (d.po_number || `DORI-${d.Lot_Number}`).toUpperCase().trim();
        const lotNum = String(d.Lot_Number || '').toUpperCase().trim();
        if (!poNum || seenPos.has(poNum)) continue;
        seenPos.add(poNum);
        const digits = lotNum.replace(/[^0-9]/g, '') || poNum.replace(/[^0-9]/g, '');
        const suffix4 = digits.slice(-4);
        const entry = {
          key: poNum,
          poNumber: poNum,
          lotNumber: lotNum,
          digits,
          suffix4,
          vendor: d.Supplier_Name || 'Doori Supplier',
          designName: d.Style || `Doori - ${d.Garment_Type || 'Garment'}`,
          supervisor: d.Supervisor || '',
          status: d.status || (d.Material_Received_Date ? 'Received' : (d.Gate_Entry_Date ? 'At Gate' : 'Live')),
          source: 'doori',
          subType: 'DORI',
          data: d,
          isOldPo: false,
        };
        newPosByExact.set(poNum, entry);
        if (lotNum) newPosByExact.set(lotNum, entry);
        if (digits) newPosByExact.set(digits, entry);
        newPosByPrefix.push(entry);
        if (suffix4) newPosBySuffix.push(entry);
        if (entry.vendor) newPosByVendor.push(entry);
      }

      for (const d of dooriOld) {
        const lotNum = String(d.Lot_Number || '').toUpperCase().trim();
        const poNum = `DORI-${lotNum}`;
        if (!lotNum || seenPos.has(poNum)) continue;
        seenPos.add(poNum);
        const digits = lotNum.replace(/[^0-9]/g, '');
        const suffix4 = digits.slice(-4);
        const entry = {
          key: poNum,
          poNumber: poNum,
          lotNumber: lotNum,
          digits,
          suffix4,
          vendor: 'Historical Doori Supplier',
          designName: `Old Doori Lot ${lotNum}`,
          supervisor: '',
          status: 'Archived / Old Doori',
          source: 'old_doori',
          subType: 'DORI',
          data: d,
          isOldPo: true,
        };
        newPosByExact.set(poNum, entry);
        newPosByExact.set(lotNum, entry);
        if (digits) newPosByExact.set(digits, entry);
        newPosByPrefix.push(entry);
        if (suffix4) newPosBySuffix.push(entry);
      }

      // Sort for Binary Search
      newPosByPrefix.sort((a, b) => a.key.localeCompare(b.key));
      newPosBySuffix.sort((a, b) => a.suffix4.localeCompare(b.suffix4));
      newPosByVendor.sort((a, b) => a.vendor.localeCompare(b.vendor));

      // --- Build RGP Indexes ---
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
          data: r,
          isOldRgp: true,
        };
        newRgpsByExact.set(num, entry);
        if (digits) newRgpsByExact.set(digits, entry);
        newRgpsByPrefix.push(entry);
        if (suffix4) newRgpsBySuffix.push(entry);
        if (entry.vendor) newRgpsByVendor.push(entry);
      }

      // Sort for Binary Search
      newRgpsByPrefix.sort((a, b) => a.key.localeCompare(b.key));
      newRgpsBySuffix.sort((a, b) => a.suffix4.localeCompare(b.suffix4));
      newRgpsByVendor.sort((a, b) => a.vendor.localeCompare(b.vendor));

      // Atomic swap of indexes
      this.posByExact = newPosByExact;
      this.posByPrefix = newPosByPrefix;
      this.posBySuffix = newPosBySuffix;
      this.posByVendor = newPosByVendor;

      this.rgpsByExact = newRgpsByExact;
      this.rgpsByPrefix = newRgpsByPrefix;
      this.rgpsBySuffix = newRgpsBySuffix;
      this.rgpsByVendor = newRgpsByVendor;

      this.isWarmedUp = true;
      this.lastRefreshedAt = new Date();
      console.log(`[BinarySearchService] Index refreshed in ${Date.now() - startTime}ms. Indexed: ${this.posByPrefix.length} POs, ${this.rgpsByPrefix.length} RGPs.`);
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
        let calcQty = 0;
        let unit = 'PCS';
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
        results.push({
          poNumber: item.poNumber,
          vendor: item.vendor,
          designName: item.designName,
          supervisor: item.supervisor,
          quantity: calcQty || 1,
          unit,
          status: item.status,
          source: item.source,
        });
      }
    };

    // 1. Direct O(1) exact match
    const exact = this.posByExact.get(q);
    if (exact) addMatch(exact);

    // 2. O(log N) Suffix Binary Search (if 2+ digits)
    if (digits && digits.length >= 2) {
      const targetSuffix = digits.slice(-4);
      const suffixMatches = this.binarySearchSuffixMatches(this.posBySuffix, targetSuffix);
      for (const m of suffixMatches) {
        if (m.digits.endsWith(digits) || m.digits === digits) {
          addMatch(m);
        }
      }
    }

    // 3. O(log N) Prefix Binary Search (e.g. PO-11)
    const prefixMatches = this.binarySearchPrefixRange(this.posByPrefix, q);
    for (const m of prefixMatches) {
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
        let calcQty = Number(item.data.quantity_sent) || 0;
        let unit = (item.data.uom || 'PCS').toUpperCase();
        try {
          const its = item.data.entries || item.data.items_json;
          const parsed = typeof its === 'string' ? JSON.parse(its) : its;
          if (Array.isArray(parsed) && parsed.length) {
            calcQty = parsed.reduce((acc, it) => acc + (Number(it.qty1 || it.Qty1 || it.qty || 0)), 0);
            if (parsed[0]?.uom || parsed[0]?.UOM || parsed[0]?.unit) {
              unit = (parsed[0].uom || parsed[0].UOM || parsed[0].unit).toUpperCase();
            }
          }
        } catch {}
        results.push({
          rgpNumber: item.rgpNumber,
          vendor: item.vendor,
          purpose: item.purpose,
          department: item.department,
          quantity: calcQty || 1,
          unit,
          status: item.status,
          source: item.source,
        });
      }
    };

    // 1. Direct O(1) exact match
    const exact = this.rgpsByExact.get(q);
    if (exact) addMatch(exact);

    // 2. O(log N) Suffix Binary Search (if 2+ digits)
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

  /**
   * Fast Binary Lookup for single PO
   */
  lookupPo(poNumber) {
    if (!poNumber) return null;
    const clean = String(poNumber).trim().toUpperCase();
    const cleanPo = clean.startsWith('PO-') ? clean : `PO-${clean}`;
    const rawPo = clean.replace(/^PO-/, '');
    const digits = clean.replace(/[^0-9]/g, '');

    // 1. Exact match
    const match = this.posByExact.get(clean) || this.posByExact.get(cleanPo) || this.posByExact.get(rawPo);
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
   * Fast Binary Lookup for single RGP
   */
  lookupRgp(rgpNumber) {
    if (!rgpNumber) return null;
    const clean = String(rgpNumber).trim().toUpperCase();
    const rawRgp = clean.replace(/^RGP[-/]?/i, '');
    const slashVariant = `RGP/${rawRgp}`;
    const dashVariant = `RGP-${rawRgp}`;
    const digits = clean.replace(/[^0-9]/g, '');

    // 1. Exact match
    const match = this.rgpsByExact.get(clean) || this.rgpsByExact.get(slashVariant) || this.rgpsByExact.get(dashVariant);
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

