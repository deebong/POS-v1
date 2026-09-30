/**
 * FreshMart POS — Google Sheets backend (Google Apps Script)
 * ===========================================================
 * This script turns a Google Sheet into the database + API for the POS web app.
 *
 * SETUP (2 minutes)
 *  1. Create a new Google Sheet (any name).
 *  2. Extensions ▸ Apps Script. Delete the sample code, paste THIS WHOLE FILE, click Save.
 *  3. Deploy ▸ New deployment ▸ gear icon ▸ "Web app"
 *        Execute as:        Me
 *        Who has access:    Anyone
 *  4. Click Deploy, authorise when asked, then copy the "Web app URL" (ends in /exec).
 *  5. In the POS app: Settings ▸ Data source ▸ paste the URL ▸ Connect.
 *
 * The tabs Products, Sales, SaleItems, StockMovements and Settings are created automatically.
 * You can open them any time to view, filter, chart or (carefully) edit your data.
 *
 * AFTER EDITING THIS CODE: Deploy ▸ Manage deployments ▸ pencil ▸ Version: "New version" ▸ Deploy.
 *
 * SECURITY: "Anyone" means anyone who knows the long, secret URL can call it. For extra protection
 * set API_KEY below and enter the same key in the POS Settings.
 */

var API_KEY = ''; // optional shared secret, e.g. 'my-store-key-123'
var SPREADSHEET_ID = ''; // leave empty when the script is opened from the sheet (Extensions ▸ Apps Script)
var VERSION = '1.0.0';
var MAX_CART_LINES = 150;

// Column schema: [name, type]  n = number, s = text, b = true/false, d = date-time
var SCHEMA = {
  Products: [['id', 'n'], ['sku', 's'], ['barcode', 's'], ['name', 's'], ['category', 's'], ['emoji', 's'], ['unit', 's'],
    ['price', 'n'], ['cost', 'n'], ['taxRate', 'n'], ['stock', 'n'], ['reorderLevel', 'n'], ['isActive', 'b'],
    ['createdAt', 'd'], ['updatedAt', 'd']],
  Sales: [['id', 'n'], ['invoiceNo', 's'], ['createdAt', 'd'], ['customerName', 's'], ['customerPhone', 's'],
    ['subtotal', 'n'], ['discount', 'n'], ['tax', 'n'], ['total', 'n'], ['paymentMethod', 's'], ['amountPaid', 'n'],
    ['changeDue', 'n'], ['status', 's'], ['note', 's'], ['voidedAt', 'd'], ['clientRef', 's']],
  SaleItems: [['id', 'n'], ['saleId', 'n'], ['invoiceNo', 's'], ['productId', 'n'], ['sku', 's'], ['name', 's'],
    ['emoji', 's'], ['unit', 's'], ['price', 'n'], ['qty', 'n'], ['taxRate', 'n'], ['lineSubtotal', 'n'], ['lineTax', 'n']],
  StockMovements: [['id', 'n'], ['createdAt', 'd'], ['productId', 'n'], ['sku', 's'], ['name', 's'], ['change', 'n'],
    ['reason', 's'], ['reference', 's']],
  Settings: [['key', 's'], ['value', 's']]
};
var SETTING_KEYS = ['storeName', 'address', 'phone', 'taxId', 'currency', 'taxLabel', 'upiId', 'receiptFooter'];

/* ------------------------------------------------------------------ */
/* HTTP entry points                                                   */
/* ------------------------------------------------------------------ */

function doGet() {
  return json_({ ok: true, service: 'FreshMart POS API', version: VERSION, needsKey: !!API_KEY });
}

function doPost(e) {
  var out;
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (API_KEY && req.key !== API_KEY) throw new Error('Invalid access key');
    var handler = ACTIONS[req.action];
    if (!handler) throw new Error('Unknown action: ' + req.action);
    out = handler(req);
    out.ok = true;
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return json_(out);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

var ACTIONS = {
  ping: ping_,
  bootstrap: bootstrap_,
  saveProduct: function (r) { return withLock_(function () { return saveProduct_(r); }); },
  deleteProduct: function (r) { return withLock_(function () { return deleteProduct_(r); }); },
  adjustStock: function (r) { return withLock_(function () { return adjustStock_(r); }); },
  importProducts: function (r) { return withLock_(function () { return importProducts_(r); }); },
  checkout: function (r) { return withLock_(function () { return checkout_(r); }); },
  voidSale: function (r) { return withLock_(function () { return voidSale_(r); }); },
  getSale: getSale_,
  saveSettings: function (r) { return withLock_(function () { return saveSettings_(r); }); }
};

// Serialise writes so two counters can never sell the same last item.
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ */
/* Sheet helpers                                                       */
/* ------------------------------------------------------------------ */

function ss_() {
  return SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
}
function tz_() { return ss_().getSpreadsheetTimeZone() || 'UTC'; }

function ensureAll_() {
  var ss = ss_();
  Object.keys(SCHEMA).forEach(function (name) { setupSheet_(ss, name); });
  var def = ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);
}

function setupSheet_(ss, name) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  var cols = SCHEMA[name];
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, cols.length)
      .setValues([cols.map(function (c) { return c[0]; })])
      .setFontWeight('bold').setBackground('#0f9d58').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    var rows = Math.max(sh.getMaxRows() - 1, 1);
    cols.forEach(function (c, i) {
      var rng = sh.getRange(2, i + 1, rows, 1);
      if (c[1] === 's') rng.setNumberFormat('@'); // keep SKUs / barcodes / phones as text
      else if (c[1] === 'd') rng.setNumberFormat('yyyy-mm-dd hh:mm:ss');
    });
  }
  return sh;
}

function sheet_(name) {
  var sh = ss_().getSheetByName(name);
  return sh || setupSheet_(ss_(), name);
}

function fromCell_(v, type) {
  if (type === 'n') { var n = Number(v); return isFinite(n) ? n : 0; }
  if (type === 'b') return v === true || String(v).toLowerCase() === 'true';
  if (type === 'd') {
    if (v instanceof Date) return v.toISOString();
    if (!v) return null;
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  return v === null || v === undefined ? '' : String(v);
}

function toCell_(v, type) {
  if (type === 'n') return Number(v) || 0;
  if (type === 'b') return !!v;
  if (type === 'd') return v ? new Date(v) : '';
  return v === null || v === undefined ? '' : String(v);
}

function rowToObj_(cols, row, rowNo) {
  var o = { _row: rowNo };
  for (var j = 0; j < cols.length; j++) o[cols[j][0]] = fromCell_(row[j], cols[j][1]);
  return o;
}

function objToRow_(name, obj) {
  return SCHEMA[name].map(function (c) { return toCell_(obj[c[0]], c[1]); });
}

function readTable_(name) {
  var sh = sheet_(name);
  var cols = SCHEMA[name];
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, cols.length).getValues();
  var hasId = cols[0][0] === 'id';
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var o = rowToObj_(cols, values[i], i + 2);
    if (!hasId || o.id > 0) out.push(o);
  }
  return out;
}

function readRow_(name, rowNo) {
  var cols = SCHEMA[name];
  var vals = sheet_(name).getRange(rowNo, 1, 1, cols.length).getValues();
  return rowToObj_(cols, vals[0], rowNo);
}

function colIndex_(name, colName) {
  var cols = SCHEMA[name];
  for (var i = 0; i < cols.length; i++) if (cols[i][0] === colName) return i + 1;
  throw new Error('No column ' + colName);
}

// Row numbers whose column equals `value` (reads a single column only).
function findRows_(name, colName, value) {
  var sh = sheet_(name);
  var last = sh.getLastRow();
  if (last < 2 || value === '' || value === null || value === undefined) return [];
  var vals = sh.getRange(2, colIndex_(name, colName), last - 1, 1).getValues();
  var rows = [];
  for (var i = 0; i < vals.length; i++) if (String(vals[i][0]) === String(value)) rows.push(i + 2);
  return rows;
}

function lastId_(name) {
  var sh = sheet_(name);
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var vals = sh.getRange(2, 1, last - 1, 1).getValues();
  var max = 0;
  for (var i = 0; i < vals.length; i++) { var n = Number(vals[i][0]); if (n > max) max = n; }
  return max;
}

function appendRows_(name, objs) {
  if (!objs.length) return;
  var sh = sheet_(name);
  var cols = SCHEMA[name].length;
  var start = Math.max(sh.getLastRow(), 1) + 1;
  var need = start + objs.length - 1;
  if (sh.getMaxRows() < need) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows() + 200);
  sh.getRange(start, 1, objs.length, cols).setValues(objs.map(function (o) { return objToRow_(name, o); }));
}

function writeRow_(name, rowNo, obj) {
  sheet_(name).getRange(rowNo, 1, 1, SCHEMA[name].length).setValues([objToRow_(name, obj)]);
}

/* ------------------------------------------------------------------ */
/* Shared logic (mirrors public/pos/js/data/logic.js)                  */
/* ------------------------------------------------------------------ */

function r2_(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
function r3_(n) { return Math.round((n + Number.EPSILON) * 1000) / 1000; }
function pad_(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }
function str_(v, max) { return typeof v === 'string' ? v.trim().substring(0, max || 120) : ''; }
function numOr_(v, fb) {
  if (v === '' || v === null || v === undefined) return fb;
  var n = Number(v);
  return isFinite(n) ? n : NaN;
}

function calcTotals_(lines, dType, dValue) {
  var priced = lines.map(function (l) {
    return { price: l.price, qty: l.qty, taxRate: l.taxRate, lineSubtotal: r2_(l.price * l.qty) };
  });
  var subtotal = r2_(priced.reduce(function (s, l) { return s + l.lineSubtotal; }, 0));
  var discount = 0;
  var v = Number(dValue) || 0;
  if (dType === 'percent') discount = r2_(subtotal * Math.min(Math.max(v, 0), 100) / 100);
  else if (dType === 'amount') discount = Math.min(r2_(Math.max(v, 0)), subtotal);
  var ratio = subtotal > 0 ? discount / subtotal : 0;
  priced.forEach(function (l) { l.lineTax = r2_(l.lineSubtotal * (1 - ratio) * (l.taxRate / 100)); });
  var tax = r2_(priced.reduce(function (s, l) { return s + l.lineTax; }, 0));
  return { lines: priced, subtotal: subtotal, discount: discount, tax: tax, total: r2_(subtotal - discount + tax) };
}

function parseProduct_(b) {
  b = b || {};
  var name = str_(b.name, 120);
  if (!name) throw new Error('Product name is required');
  var price = numOr_(b.price, 0), cost = numOr_(b.cost, 0), taxRate = numOr_(b.taxRate, 0);
  var stock = numOr_(b.stock, 0), reorder = numOr_(b.reorderLevel, 10);
  [price, cost, taxRate, stock, reorder].forEach(function (n) {
    if (isNaN(n)) throw new Error('Price, cost, tax, stock and reorder level must be valid numbers');
  });
  if (price < 0 || cost < 0 || stock < 0 || reorder < 0) throw new Error('Numbers cannot be negative');
  if (taxRate < 0 || taxRate > 100) throw new Error('Tax rate must be between 0 and 100');
  var sku = str_(b.sku, 40).toUpperCase();
  if (!sku) sku = 'P-' + new Date().getTime().toString(36).toUpperCase();
  return {
    sku: sku,
    barcode: str_(b.barcode, 40),
    name: name,
    category: str_(b.category, 60) || 'General',
    emoji: str_(b.emoji, 8) || '🛒',
    unit: (str_(b.unit, 12) || 'pc').toLowerCase(),
    price: r2_(price), cost: r2_(cost), taxRate: r2_(taxRate),
    stock: r3_(stock), reorderLevel: r3_(reorder),
    isActive: b.isActive === undefined ? true : !!b.isActive
  };
}

/* ------------------------------------------------------------------ */
/* Public shapes                                                       */
/* ------------------------------------------------------------------ */

function pubProduct_(p) {
  return {
    id: p.id, sku: p.sku, barcode: p.barcode || null, name: p.name, category: p.category, emoji: p.emoji,
    unit: p.unit, price: p.price, cost: p.cost, taxRate: p.taxRate, stock: p.stock, reorderLevel: p.reorderLevel,
    isActive: p.isActive, createdAt: p.createdAt, updatedAt: p.updatedAt
  };
}
function pubSale_(s) {
  return {
    id: s.id, invoiceNo: s.invoiceNo, customerName: s.customerName || null, customerPhone: s.customerPhone || null,
    subtotal: s.subtotal, discount: s.discount, tax: s.tax, total: s.total, paymentMethod: s.paymentMethod,
    amountPaid: s.amountPaid, changeDue: s.changeDue, status: s.status || 'completed', note: s.note || null,
    createdAt: s.createdAt, voidedAt: s.voidedAt || null
  };
}
function pubItem_(i) {
  return {
    id: i.id, saleId: i.saleId, productId: i.productId || null, name: i.name, sku: i.sku, emoji: i.emoji || '🛒',
    unit: i.unit, price: i.price, qty: i.qty, taxRate: i.taxRate, lineSubtotal: i.lineSubtotal, lineTax: i.lineTax
  };
}

function itemsForSale_(saleId) {
  var rows = findRows_('SaleItems', 'saleId', saleId);
  if (!rows.length) return [];
  var cols = SCHEMA.SaleItems;
  var first = rows[0], lastRow = rows[rows.length - 1];
  var vals = sheet_('SaleItems').getRange(first, 1, lastRow - first + 1, cols.length).getValues();
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    var o = rowToObj_(cols, vals[i], first + i);
    if (o.saleId === Number(saleId)) out.push(o);
  }
  return out;
}

function movement_(id, p, change, reason, reference, iso) {
  return { id: id, createdAt: iso, productId: p.id, sku: p.sku, name: p.name, change: change, reason: reason, reference: reference || '' };
}

function settingsMap_() {
  var map = {};
  readTable_('Settings').forEach(function (r) { if (r.key) map[r.key] = r.value; });
  return map;
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

function ping_() {
  ensureAll_();
  var ss = ss_();
  return { spreadsheetName: ss.getName(), spreadsheetUrl: ss.getUrl(), version: VERSION };
}

function bootstrap_(req) {
  ensureAll_();
  var days = Math.min(Math.max(Number(req.days) || 90, 1), 3650);
  var cutoff = new Date().getTime() - days * 86400000;
  var sinceMs = req.since ? new Date(req.since).getTime() : 0;
  if (isFinite(sinceMs) && sinceMs > cutoff) cutoff = sinceMs - 86400000; // overlap one day to be safe
  var ss = ss_();

  var sales = readTable_('Sales').filter(function (s) {
    return s.createdAt && new Date(s.createdAt).getTime() >= cutoff;
  });
  var ids = {};
  sales.forEach(function (s) { ids[s.id] = true; });
  var items = readTable_('SaleItems').filter(function (i) { return ids[i.saleId]; });

  return {
    settings: settingsMap_(),
    products: readTable_('Products').map(pubProduct_),
    sales: sales.map(pubSale_),
    saleItems: items.map(pubItem_),
    spreadsheetUrl: ss.getUrl(),
    spreadsheetName: ss.getName(),
    serverTime: new Date().toISOString()
  };
}

function assertUnique_(products, data, id) {
  products.forEach(function (p) {
    if (p.id === id) return;
    if (String(p.sku).toLowerCase() === data.sku.toLowerCase()) throw new Error('A product with this SKU already exists');
    if (data.barcode && p.barcode && String(p.barcode).toLowerCase() === data.barcode.toLowerCase()) {
      throw new Error('A product with this barcode already exists');
    }
  });
}

function saveProduct_(req) {
  var b = req.product || {};
  var data = parseProduct_(b);
  var id = Number(b.id) || 0;
  var products = readTable_('Products');
  var iso = new Date().toISOString();
  assertUnique_(products, data, id);

  if (id) {
    var cur = products.filter(function (p) { return p.id === id; })[0];
    if (!cur) throw new Error('Product not found');
    Object.keys(data).forEach(function (k) { if (k !== 'stock') cur[k] = data[k]; }); // stock only via adjustStock
    cur.updatedAt = iso;
    writeRow_('Products', cur._row, cur);
    return { product: pubProduct_(cur) };
  }
  var p = data;
  p.id = lastId_('Products') + 1;
  p.createdAt = iso;
  p.updatedAt = iso;
  appendRows_('Products', [p]);
  if (p.stock > 0) appendRows_('StockMovements', [movement_(lastId_('StockMovements') + 1, p, p.stock, 'initial', 'Opening stock', iso)]);
  return { product: pubProduct_(p) };
}

function importProducts_(req) {
  var list = Array.isArray(req.products) ? req.products : [];
  var products = readTable_('Products');
  var skus = {}, codes = {};
  products.forEach(function (p) {
    skus[String(p.sku).toLowerCase()] = true;
    if (p.barcode) codes[String(p.barcode).toLowerCase()] = true;
  });
  var iso = new Date().toISOString();
  var nextId = lastId_('Products') + 1;
  var created = [], moves = [], skipped = 0;
  var mvId = lastId_('StockMovements');

  list.forEach(function (raw) {
    var data;
    try { data = parseProduct_(raw); } catch (e) { skipped++; return; }
    var sk = data.sku.toLowerCase(), bc = data.barcode ? data.barcode.toLowerCase() : '';
    if (skus[sk] || (bc && codes[bc])) { skipped++; return; }
    skus[sk] = true;
    if (bc) codes[bc] = true;
    data.id = nextId++;
    data.createdAt = iso;
    data.updatedAt = iso;
    created.push(data);
    if (data.stock > 0) moves.push(movement_(++mvId, data, data.stock, 'initial', 'Opening stock', iso));
  });
  appendRows_('Products', created);
  appendRows_('StockMovements', moves);
  return { products: created.map(pubProduct_), skipped: skipped };
}

function deleteProduct_(req) {
  var rows = findRows_('Products', 'id', req.id);
  if (!rows.length) throw new Error('Product not found');
  sheet_('Products').deleteRow(rows[0]);
  return {};
}

function adjustStock_(req) {
  var rows = findRows_('Products', 'id', req.productId);
  if (!rows.length) throw new Error('Product not found');
  var p = readRow_('Products', rows[0]);
  var mode = req.mode === 'remove' || req.mode === 'set' ? req.mode : 'add';
  var qty = Number(req.quantity);
  if (!isFinite(qty) || qty < 0 || (mode !== 'set' && qty === 0)) throw new Error('Enter a valid quantity');
  var before = p.stock;
  var after = mode === 'add' ? before + qty : mode === 'remove' ? before - qty : qty;
  if (after < 0) throw new Error('Stock cannot go below zero');
  var change = r3_(after - before);
  var iso = new Date().toISOString();
  p.stock = r3_(after);
  p.updatedAt = iso;
  writeRow_('Products', p._row, p);
  if (change !== 0) {
    appendRows_('StockMovements', [movement_(lastId_('StockMovements') + 1, p, change,
      mode === 'add' ? 'restock' : 'adjustment', str_(req.reason, 80), iso)]);
  }
  return { product: pubProduct_(p) };
}

function checkout_(req) {
  if (!Array.isArray(req.items) || !req.items.length) throw new Error('Cart is empty');
  if (req.items.length > MAX_CART_LINES) throw new Error('Too many lines in one bill');

  // Idempotency: a retried request (same clientRef) returns the original bill instead of charging twice.
  var ref = str_(req.clientRef, 64);
  if (ref) {
    var dup = findRows_('Sales', 'clientRef', ref);
    if (dup.length) {
      var s0 = readRow_('Sales', dup[0]);
      return { sale: pubSale_(s0), items: itemsForSale_(s0.id).map(pubItem_), products: [], duplicate: true };
    }
  }

  var wanted = {}, order = [];
  req.items.forEach(function (it) {
    var pid = Number(it.productId), q = Number(it.qty);
    if (!(pid > 0) || !isFinite(q) || !(q > 0)) throw new Error('Invalid item in cart');
    if (!(pid in wanted)) { wanted[pid] = 0; order.push(pid); }
    wanted[pid] = r3_(wanted[pid] + q);
  });

  var byId = {};
  readTable_('Products').forEach(function (p) { byId[p.id] = p; });
  var lines = order.map(function (pid) {
    var p = byId[pid], qty = wanted[pid];
    if (!p || !p.isActive) throw new Error('A product in the cart is no longer available');
    if (p.stock < qty) throw new Error('Not enough stock for ' + p.name + ' (available: ' + p.stock + ' ' + p.unit + ')');
    return { p: p, qty: qty };
  });

  var dType = req.discountType === 'percent' || req.discountType === 'amount' ? req.discountType : 'none';
  var calc = calcTotals_(lines.map(function (l) { return { price: l.p.price, qty: l.qty, taxRate: l.p.taxRate }; }), dType, req.discountValue);
  var method = ['cash', 'card', 'upi'].indexOf(req.paymentMethod) >= 0 ? req.paymentMethod : 'cash';
  var paid = method === 'cash' ? Number(req.amountPaid) : calc.total;
  if (!isFinite(paid)) paid = calc.total;
  if (paid + 0.001 < calc.total) throw new Error('Amount received is less than the total due');
  paid = r2_(paid);

  var now = new Date(), iso = now.toISOString();
  var saleId = lastId_('Sales') + 1;
  var invoiceNo = 'INV-' + Utilities.formatDate(now, tz_(), 'yyyyMMdd') + '-' + pad_(saleId, 5);
  var sale = {
    id: saleId, invoiceNo: invoiceNo, createdAt: iso,
    customerName: str_(req.customerName, 80), customerPhone: str_(req.customerPhone, 24),
    subtotal: calc.subtotal, discount: calc.discount, tax: calc.tax, total: calc.total,
    paymentMethod: method, amountPaid: paid, changeDue: method === 'cash' ? r2_(paid - calc.total) : 0,
    status: 'completed', note: str_(req.note, 200), voidedAt: null, clientRef: ref
  };
  appendRows_('Sales', [sale]);

  var itemId = lastId_('SaleItems');
  var items = lines.map(function (l, i) {
    return {
      id: ++itemId, saleId: saleId, invoiceNo: invoiceNo, productId: l.p.id, sku: l.p.sku, name: l.p.name,
      emoji: l.p.emoji, unit: l.p.unit, price: l.p.price, qty: l.qty, taxRate: l.p.taxRate,
      lineSubtotal: calc.lines[i].lineSubtotal, lineTax: calc.lines[i].lineTax
    };
  });
  appendRows_('SaleItems', items);

  var mvId = lastId_('StockMovements');
  var moves = [];
  lines.forEach(function (l) {
    l.p.stock = r3_(l.p.stock - l.qty);
    l.p.updatedAt = iso;
    writeRow_('Products', l.p._row, l.p);
    moves.push(movement_(++mvId, l.p, -l.qty, 'sale', invoiceNo, iso));
  });
  appendRows_('StockMovements', moves);
  SpreadsheetApp.flush();

  return {
    sale: pubSale_(sale),
    items: items.map(pubItem_),
    products: lines.map(function (l) { return pubProduct_(l.p); })
  };
}

function voidSale_(req) {
  var rows = findRows_('Sales', 'id', req.id);
  if (!rows.length) throw new Error('Invoice not found');
  var sale = readRow_('Sales', rows[0]);
  if (sale.status === 'voided') throw new Error('This invoice is already voided');

  var items = itemsForSale_(sale.id);
  var iso = new Date().toISOString();
  var mvId = lastId_('StockMovements');
  var moves = [], touched = [];
  items.forEach(function (it) {
    var prow = findRows_('Products', 'id', it.productId);
    if (!prow.length) return; // product was deleted since
    var p = readRow_('Products', prow[0]);
    p.stock = r3_(p.stock + it.qty);
    p.updatedAt = iso;
    writeRow_('Products', p._row, p);
    moves.push(movement_(++mvId, p, it.qty, 'void', sale.invoiceNo, iso));
    touched.push(p);
  });
  appendRows_('StockMovements', moves);
  sale.status = 'voided';
  sale.voidedAt = iso;
  writeRow_('Sales', sale._row, sale);
  SpreadsheetApp.flush();
  return { sale: pubSale_(sale), items: items.map(pubItem_), products: touched.map(pubProduct_) };
}

function getSale_(req) {
  var rows = req.id ? findRows_('Sales', 'id', req.id) : findRows_('Sales', 'invoiceNo', req.invoiceNo);
  if (!rows.length) return { sale: null, items: [] };
  var s = readRow_('Sales', rows[0]);
  return { sale: pubSale_(s), items: itemsForSale_(s.id).map(pubItem_) };
}

function saveSettings_(req) {
  var input = req.settings || {};
  var existing = {};
  readTable_('Settings').forEach(function (r) { existing[r.key] = r._row; });
  var appendList = [];
  SETTING_KEYS.forEach(function (k) {
    if (typeof input[k] !== 'string') return;
    var v = input[k].trim().substring(0, 300);
    if (existing[k]) writeRow_('Settings', existing[k], { key: k, value: v });
    else appendList.push({ key: k, value: v });
  });
  appendRows_('Settings', appendList);
  return { settings: settingsMap_() };
}
