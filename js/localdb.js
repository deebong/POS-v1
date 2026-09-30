// Local database = the source of truth for the UI. Every change is written here first
// (so the till keeps working offline) and queued in an outbox for Google Sheets.
import * as idb from "./idb.js";
import { demoData } from "./demoData.js";
import {
  DEFAULT_SETTINGS, SETTING_KEYS, calcTotals, invoiceNumber, parseProduct, round2, round3, uid,
} from "./data/logic.js";

const META_KEY = "meta";
const SETTINGS_KEY = "settings";
export const LOCAL_REF = (localId) => `l:${localId}`;

const blankMeta = () => ({
  lastSyncAt: null,
  lastPullAt: null,
  idmap: {}, // localId -> server id
  invoiceSeq: 0,
  isDemo: false,
  seededAt: null,
});

/* ------------------------------------------------------------------ */
/* bootstrap                                                          */
/* ------------------------------------------------------------------ */

export async function initLocal({ seed = true } = {}) {
  const [hasMeta, productCount] = await Promise.all([idb.get("kv", META_KEY), idb.count("products")]);
  if (hasMeta || productCount > 0) return hasMeta || blankMeta();

  if (!seed) {
    // Adopting a sheet that already has data: start from an empty database.
    const meta = blankMeta();
    await idb.atomic(async (s) => {
      s.kv.put(meta, META_KEY);
      s.kv.put({ ...DEFAULT_SETTINGS }, SETTINGS_KEY);
    });
    return meta;
  }

  // First run on this PC: create the database with sample data so nothing is blank.
  const meta = { ...blankMeta(), isDemo: true, seededAt: new Date().toISOString() };
  const demo = demoData();
  await idb.atomic(async (s) => {
    s.kv.put(meta, META_KEY);
    s.kv.put({ ...DEFAULT_SETTINGS }, SETTINGS_KEY);
    demo.products.forEach((p) => s.products.put(p));
    demo.sales.forEach((x) => s.sales.put(x));
  });
  return meta;
}

export const getMeta = async () => (await idb.get("kv", META_KEY)) || blankMeta();
export const getSettings = async () => ({ ...DEFAULT_SETTINGS, ...((await idb.get("kv", SETTINGS_KEY)) || {}) });

export async function setMeta(patch) {
  const meta = { ...(await getMeta()), ...patch };
  await idb.put("kv", meta, META_KEY);
  return meta;
}

export async function setSettings(settings) {
  const next = { ...(await getSettings()) };
  for (const k of SETTING_KEYS) if (typeof settings[k] === "string") next[k] = settings[k].trim().slice(0, 300);
  await idb.put("kv", next, SETTINGS_KEY);
  return next;
}

export async function readAll() {
  const [products, sales, settings, meta] = await Promise.all([
    idb.getAll("products"),
    idb.getAll("sales"),
    getSettings(),
    getMeta(),
  ]);
  return { products, sales, settings, meta };
}

/* ------------------------------------------------------------------ */
/* outbox                                                            */
/* ------------------------------------------------------------------ */

const nowIso = () => new Date().toISOString();

export function enqueueOp(type, payload) {
  const op = { id: uid(), type, payload, status: "pending", attempts: 0, createdAt: nowIso(), lastError: null, lastTriedAt: null };
  return idb.put("ops", op).then(() => op);
}

export const getProduct = (localId) => idb.get("products", localId);

/** Shape sent to the sheet for a product (local-only fields never travel). */
export function pubProductForSync(p) {
  return {
    sku: p.sku, barcode: p.barcode, name: p.name, category: p.category, emoji: p.emoji, unit: p.unit,
    price: p.price, cost: p.cost, taxRate: p.taxRate, stock: p.stock, reorderLevel: p.reorderLevel,
    isActive: p.isActive,
  };
}

export const getOps = (status) => (status ? idb.byIndex("ops", "byStatus", status) : idb.getAll("ops"));
export const putOp = (op) => idb.put("ops", op);
export const putOps = (ops) => idb.putAll("ops", ops);
export const pendingCount = async () => (await idb.byIndex("ops", "byStatus", "pending")).length;

export async function retryOp(opId) {
  const op = await idb.get("ops", opId);
  if (!op) return;
  op.status = "pending";
  op.lastError = null;
  op.attempts = 0;
  await idb.put("ops", op);
}

/** Give up on an op. Its data stays on this PC (flagged local-only) but is never re-sent. */
export async function discardOp(opId) {
  const op = await idb.get("ops", opId);
  if (!op) return;
  op.status = "discarded";
  await idb.put("ops", op);
  const ref = op.payload && (op.payload.productLocalId || op.payload.saleLocalId);
  if (ref) await markLocalOnly(ref);
}

async function markLocalOnly(localId) {
  const [p, s] = await Promise.all([idb.get("products", localId), idb.get("sales", localId)]);
  if (p) await idb.put("products", { ...p, localOnly: true });
  if (s) await idb.put("sales", { ...s, localOnly: true });
}

/** Used when the user switches to a sheet and does NOT want local demo data uploaded. */
export async function clearLocalData() {
  await idb.wipe();
}

export async function clearQueue() {
  await idb.clear("ops");
}

/* ------------------------------------------------------------------ */
/* mutators: change local data + queue the matching op               */
/* ------------------------------------------------------------------ */

const pubProduct = (p) => ({
  id: p.id, localId: p.localId, sku: p.sku, barcode: p.barcode, name: p.name, category: p.category,
  emoji: p.emoji, unit: p.unit, price: p.price, cost: p.cost, taxRate: p.taxRate, stock: p.stock,
  reorderLevel: p.reorderLevel, isActive: p.isActive, createdAt: p.createdAt, updatedAt: p.updatedAt,
});
const pubSale = (s) => {
  const { items, ...rest } = s;
  return { ...rest, itemCount: items.length };
};
const pubItems = (s) => s.items.map(({ localId, productLocalId, ...rest }) => rest);

export async function saveProduct(input) {
  const { data, error } = parseProduct(input || {});
  if (error) throw new Error(error);
  const editing = input && input.localId ? await idb.get("products", input.localId) : null;
  const iso = nowIso();
  const rec = {
    ...data,
    localId: editing ? editing.localId : uid(),
    id: editing ? editing.id : null,
    createdAt: editing ? editing.createdAt : iso,
    updatedAt: iso,
    _s: 0,
    localOnly: editing ? editing.localOnly : false,
  };
  if (editing) rec.stock = editing.stock; // stock only changes via adjustStock
  const op = await enqueueOp("saveProduct", {
    product: pubProduct(rec),
    productLocalId: rec.localId,
  });
  await idb.put("products", rec);
  return { product: rec, op };
}

/**
 * Queues every product that has no server id yet, as ONE batched change
 * (Apps Script round-trips are slow, so this keeps connecting a new sheet quick).
 */
export async function enqueueAllProductsForSync() {
  const all = await idb.getAll("products");
  const pending = all.filter((p) => (p.id === null || p.id === undefined) && !p.localOnly);
  if (!pending.length) return 0;
  await enqueueOp("importProducts", {
    products: pending.map((p) => ({ ...pubProductForSync(p), productLocalId: p.localId })),
  });
  return pending.length;
}

export async function deleteProduct(localId) {
  const rec = await idb.get("products", localId);
  if (!rec) throw new Error("Product not found");
  if (rec.id !== null && rec.id !== undefined) {
    await enqueueOp("deleteProduct", { id: rec.id, productLocalId: rec.localId });
  }
  await idb.del("products", localId);
}

export async function adjustStock({ productLocalId, mode, quantity, reason }) {
  const rec = await idb.get("products", productLocalId);
  if (!rec) throw new Error("Product not found");
  const m = mode === "remove" || mode === "set" ? mode : "add";
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty < 0 || (m !== "set" && qty === 0)) throw new Error("Enter a valid quantity");
  const after = m === "add" ? rec.stock + qty : m === "remove" ? rec.stock - qty : qty;
  if (after < 0) throw new Error("Stock cannot go below zero");
  const before = rec.stock;
  rec.stock = round3(after);
  rec.updatedAt = nowIso();
  rec._s = 0;
  await idb.put("products", rec);
  await enqueueOp("adjustStock", {
    productLocalId: rec.localId,
    productId: rec.id,
    mode: m,
    quantity: qty,
    reason: reason || "",
  });
  return { product: rec, before };
}

export async function importProducts(list) {
  const existing = await idb.getAll("products");
  const seen = new Set(existing.map((p) => p.sku.toLowerCase()));
  const codes = new Set(existing.filter((p) => p.barcode).map((p) => p.barcode.toLowerCase()));
  const iso = nowIso();
  const created = [];
  let skipped = 0;
  for (const raw of list || []) {
    const { data } = parseProduct(raw || {});
    const skuKey = data ? data.sku.toLowerCase() : "";
    const bcKey = data && data.barcode ? data.barcode.toLowerCase() : "";
    if (!data || seen.has(skuKey) || (bcKey && codes.has(bcKey))) {
      skipped++;
      continue;
    }
    seen.add(skuKey);
    if (bcKey) codes.add(bcKey);
    created.push({
      ...data,
      localId: uid(),
      id: null,
      createdAt: iso,
      updatedAt: iso,
      _s: 0,
      localOnly: false,
    });
  }
  if (created.length) {
    await idb.putAll("products", created);
    // one op per product keeps the queue replayable in order
    for (const p of created) await enqueueOp("saveProduct", { product: pubProduct(p), productLocalId: p.localId });
  }
  return { products: created, skipped };
}

/**
 * Records a bill locally (stock is decremented at once) and queues it for the sheet.
 * `clientRef` makes a later retry safe: the sheet records the bill exactly once.
 */
export async function checkout(payload) {
  if (!payload || !Array.isArray(payload.items) || !payload.items.length) throw new Error("Cart is empty");

  const merged = new Map();
  const order = [];
  for (const it of payload.items) {
    const key = String(it.productLocalId);
    const qty = Number(it.qty);
    if (!key || !Number.isFinite(qty) || qty <= 0) throw new Error("Invalid item in cart");
    if (!merged.has(key)) {
      merged.set(key, 0);
      order.push(key);
    }
    merged.set(key, round3(merged.get(key) + qty));
  }

  const products = await Promise.all(order.map((k) => idb.get("products", k)));
  const lines = order.map((key, i) => {
    const p = products[i];
    const qty = merged.get(key);
    if (!p || !p.isActive) throw new Error("A product in the cart is no longer available");
    if (p.stock < qty) throw new Error(`Not enough stock for ${p.name} (available: ${p.stock} ${p.unit})`);
    return { p, qty };
  });

  const dType = payload.discountType === "percent" || payload.discountType === "amount" ? payload.discountType : "none";
  const calc = calcTotals(
    lines.map(({ p, qty }) => ({ price: p.price, qty, taxRate: p.taxRate })),
    { type: dType, value: Number(payload.discountValue) || 0 },
  );
  const method = ["cash", "card", "upi"].includes(payload.paymentMethod) ? payload.paymentMethod : "cash";
  let paid = method === "cash" ? Number(payload.amountPaid) : calc.total;
  if (!Number.isFinite(paid)) paid = calc.total;
  if (paid + 0.001 < calc.total) throw new Error("Amount received is less than the total due");
  paid = round2(paid);

  const meta = await getMeta();
  const seq = (meta.invoiceSeq || 0) + 1;
  const iso = nowIso();
  // Offline bills get a clearly-marked local number; the sheet assigns the final one on sync.
  const invoiceNo = invoiceNumber(seq, iso).replace(/-(\d+)$/, (m) => `-L${seq}`);
  const sale = {
    localId: uid(),
    id: null,
    invoiceNo,
    createdAt: iso,
    customerName: (payload.customerName || "").trim().slice(0, 80) || null,
    customerPhone: (payload.customerPhone || "").trim().slice(0, 24) || null,
    subtotal: calc.subtotal,
    discount: calc.discount,
    tax: calc.tax,
    total: calc.total,
    paymentMethod: method,
    amountPaid: paid,
    changeDue: method === "cash" ? round2(paid - calc.total) : 0,
    status: "completed",
    note: (payload.note || "").trim().slice(0, 200) || null,
    voidedAt: null,
    _s: 0,
    localOnly: false,
    items: lines.map(({ p, qty }, i) => ({
      localId: uid(),
      productId: p.id,
      productLocalId: p.localId,
      name: p.name,
      sku: p.sku,
      emoji: p.emoji,
      unit: p.unit,
      price: p.price,
      qty,
      taxRate: p.taxRate,
      lineSubtotal: calc.lines[i].lineSubtotal,
      lineTax: calc.lines[i].lineTax,
    })),
  };

  await idb.atomic(async (s) => {
    lines.forEach(({ p, qty }) => {
      p.stock = round3(p.stock - qty);
      p.updatedAt = iso;
      p._s = 0;
      s.products.put(p);
    });
    s.sales.put(sale);
    s.kv.put({ ...meta, invoiceSeq: seq, isDemo: false }, META_KEY);
  });

  await enqueueOp("checkout", {
    ...payload,
    clientRef: payload.clientRef || uid(),
    saleLocalId: sale.localId,
    items: lines.map(({ p, qty }) => ({ productLocalId: p.localId, productId: p.id, qty })),
  });
  return { sale, products: lines.map((l) => l.p) };
}

export async function voidSale(saleLocalId) {
  const sale = await idb.get("sales", saleLocalId);
  if (!sale) throw new Error("Invoice not found");
  if (sale.status === "voided") throw new Error("This invoice is already voided");
  const iso = nowIso();

  if (sale.id === null || sale.id === undefined) {
    // Never reached the sheet: just drop it here and give the stock back.
    const products = await Promise.all(sale.items.map((it) => idb.get("products", it.productLocalId)));
    await idb.atomic(async (s) => {
      products.forEach((p, i) => {
        if (!p) return;
        p.stock = round3(p.stock + sale.items[i].qty);
        p.updatedAt = iso;
        p._s = 0;
        s.products.put(p);
      });
      s.sales.put({ ...sale, status: "voided", voidedAt: iso });
    });
    return { sale: { ...sale, status: "voided", voidedAt: iso }, products, localOnly: true };
  }

  const products = [];
  for (const it of sale.items) {
    const p = it.productLocalId ? await idb.get("products", it.productLocalId) : null;
    if (!p) continue;
    p.stock = round3(p.stock + it.qty);
    p.updatedAt = iso;
    p._s = 0;
    products.push(p);
  }
  const updated = { ...sale, status: "voided", voidedAt: iso, _s: 0 };
  await idb.atomic(async (s) => {
    products.forEach((p) => s.products.put(p));
    s.sales.put(updated);
  });
  await enqueueOp("voidSale", { id: sale.id, saleLocalId: sale.localId });
  return { sale: updated, products };
}

/* ------------------------------------------------------------------ */
/* merge results coming back from the sheet                          */
/* ------------------------------------------------------------------ */

/** Stores the server's version of a product/sale and remembers localId → serverId. */
export async function mergeServerProduct(serverProduct, localId) {
  const meta = await getMeta();
  const key = localId || (await findByServerId("products", serverProduct.id))?.localId;
  if (key) meta.idmap[key] = serverProduct.id;
  const rec = {
    ...serverProduct,
    localId: key || uid(),
    _s: 1,
    localOnly: false,
  };
  await idb.put("products", rec);
  await idb.put("kv", meta, META_KEY);
  return rec;
}

export async function mergeServerSale(serverSale, serverItems, localId) {
  const meta = await getMeta();
  const key = localId || (await findByServerId("sales", serverSale.id))?.localId;
  if (key) meta.idmap[key] = serverSale.id;
  const rec = {
    ...serverSale,
    localId: key || uid(),
    _s: 1,
    localOnly: false,
    items: (serverItems || []).map((it) => ({ ...it, localId: uid(), productLocalId: null })),
  };
  await idb.atomic(async (s) => {
    s.sales.put(rec);
    s.kv.put(meta, META_KEY);
  });
  return rec;
}

async function findByServerId(store, id) {
  if (id === null || id === undefined) return null;
  const rows = await idb.byIndex(store, "byId", id);
  return rows[0] || null;
}

/**
 * Applies a full pull from the sheet: server rows replace synced records,
 * while anything still pending locally (not yet uploaded) is kept.
 */
export async function applyPull({ products = [], sales = [], saleItems = [], settings }) {
  const [localProducts, localSales] = await Promise.all([idb.getAll("products"), idb.getAll("sales")]);
  const byId = new Map(localProducts.map((p) => [p.id, p.localId]));
  const saleById = new Map(localSales.map((s) => [s.id, s.localId]));
  const itemMap = new Map();
  for (const it of saleItems) {
    if (!itemMap.has(it.saleId)) itemMap.set(it.saleId, []);
    itemMap.get(it.saleId).push({ ...it, localId: uid(), productLocalId: null });
  }

  const nextProducts = products.map((p) => {
    const key = byId.get(p.id);
    return { ...p, localId: key || uid(), _s: 1, localOnly: false };
  });
  const nextSales = sales.map((s) => ({
    ...s,
    localId: saleById.get(s.id) || uid(),
    _s: 1,
    localOnly: false,
    items: itemMap.get(s.id) || [],
  }));

  // Keep local records that the server doesn't know about yet (created offline).
  const serverProductIds = new Set(products.map((p) => p.id));
  const keepProducts = localProducts.filter((p) => p.id === null || p.id === undefined || !serverProductIds.has(p.id));
  const serverSaleIds = new Set(sales.map((s) => s.id));
  const keepSales = localSales.filter((s) => s.id === null || s.id === undefined || !serverSaleIds.has(s.id));

  const meta = await getMeta();
  const idmap = { ...meta.idmap };
  for (const p of nextProducts) if (idmap[p.localId]) idmap[p.localId] = p.id;
  for (const s of nextSales) if (idmap[s.localId]) idmap[s.localId] = s.id;

  await idb.atomic(async (st) => {
    st.products.clear();
    [...nextProducts, ...keepProducts].forEach((p) => st.products.put(p));
    st.sales.clear();
    [...nextSales, ...keepSales].forEach((s) => st.sales.put(s));
    st.kv.put({ ...meta, idmap, lastPullAt: nowIso() }, META_KEY);
    if (settings) st.kv.put(settings, SETTINGS_KEY);
  });

  return {
    products: [...nextProducts, ...keepProducts],
    sales: [...nextSales, ...keepSales],
  };
}
