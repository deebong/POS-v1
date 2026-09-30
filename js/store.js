// In-memory state over the local database. All writes go through localdb (which queues them
// for Google Sheets) — the UI never blocks on the network.
import * as localdb from "./localdb.js";
import { schedulePush, syncState } from "./sync.js";
import { DEFAULT_SETTINGS, isWeighed } from "./data/logic.js";

export { isWeighed };
export const HISTORY_DAYS = 90;

export const state = {
  settings: { ...DEFAULT_SETTINGS },
  all: [], // every product (incl. inactive)
  products: [], // active products (what the POS sells)
  sales: [], // newest first, each with .items and .itemCount
  meta: {
    mode: "local",
    isDemo: false,
    lastSyncAt: null,
    spreadsheetName: "",
    spreadsheetUrl: "",
    localOnly: false,
  },
  sync: syncState,
};

const emit = (name) => window.dispatchEvent(new CustomEvent(name));
const byCatName = (a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name);
const byCreatedDesc = (a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id < b.id ? 1 : -1);

function ingest({ products, sales, settings, meta }) {
  state.settings = settings;
  state.all = products.slice().sort(byCatName);
  state.products = state.all.filter((p) => p.isActive);
  state.sales = sales
    .map((s) => ({ ...s, itemCount: (s.items || []).length }))
    .sort(byCreatedDesc);
  state.meta = {
    mode: meta.mode || "local",
    isDemo: !!meta.isDemo,
    lastSyncAt: meta.lastSyncAt || null,
    lastPullAt: meta.lastPullAt || null,
    spreadsheetName: meta.spreadsheetName || "",
    spreadsheetUrl: meta.spreadsheetUrl || "",
    localOnly: !meta.lastPullAt,
  };
}

/** (Re)load everything from the local database. Never touches the network. */
export async function loadAll() {
  await localdb.initLocal();
  const data = await localdb.readAll();
  ingest({ ...data, meta: { ...data.meta, mode: "local" } });
  return state;
}

/** Re-read after the sync engine changed local data. */
export const reload = loadAll;

/* ---------- mutations: local write + queue for the sheet ---------- */

const done = () => {
  emit("data:changed");
  schedulePush();
};

export async function saveProduct(input) {
  const res = await localdb.saveProduct(input);
  await reload();
  done();
  return res.product;
}

export async function deleteProduct(localId) {
  await localdb.deleteProduct(localId);
  await reload();
  done();
}

export async function adjustStock(args) {
  const res = await localdb.adjustStock(args);
  await reload();
  done();
  return res.product;
}

export async function importProducts(list) {
  const res = await localdb.importProducts(list);
  await reload();
  done();
  return res;
}

export async function checkout(payload) {
  const res = await localdb.checkout(payload);
  await reload();
  done();
  return res;
}

export async function voidSale(saleLocalId) {
  const res = await localdb.voidSale(saleLocalId);
  await reload();
  done();
  return res;
}

export async function saveSettings(settings) {
  await localdb.setSettings(settings);
  await localdb.enqueueOp("saveSettings", { settings });
  await reload();
  done();
  return state.settings;
}

/** Replace local data with a sheet's contents (used when connecting a sheet). */
export async function adoptPulledData() {
  await reload();
  emit("data:changed");
}

/* ---------- lookups & helpers ---------- */

export const productByLocalId = (localId) => state.products.find((p) => p.localId === localId) || null;
export const itemsFor = (sale) => (sale && sale.items) || [];
export const saleByLocalId = (localId) => state.sales.find((s) => s.localId === localId) || null;
export const saleByServerId = (id) => state.sales.find((s) => s.id === id) || null;

export function findByCode(code) {
  const c = String(code || "").trim().toLowerCase();
  if (!c) return null;
  return state.products.find((p) => p.sku.toLowerCase() === c || (p.barcode && p.barcode.toLowerCase() === c)) || null;
}

export function categoryCounts(list = state.products) {
  const map = new Map();
  for (const p of list) map.set(p.category, (map.get(p.category) || 0) + 1);
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

const CAT = {
  "Fruits & Veg": "#eaf8ef",
  "Dairy & Eggs": "#eaf2ff",
  Bakery: "#fff3df",
  "Meat & Seafood": "#ffecec",
  Beverages: "#e7f7fb",
  Snacks: "#fff8d9",
  Pantry: "#f6efe4",
  Household: "#eceeff",
  "Personal Care": "#f5ebff",
  Frozen: "#e4f3ff",
};
export const catTint = (c) => CAT[c] || "#eaf6ef";

export function stockStatus(p) {
  if (p.stock <= 0) return "out";
  if (p.stock <= p.reorderLevel) return "low";
  return "ok";
}

/** An invoice may still be local-only (queued). Older bills are fetched on demand. */
export async function lookupInvoice(no) {
  const n = String(no || "").trim().toLowerCase();
  const sale = state.sales.find((s) => s.invoiceNo.toLowerCase() === n);
  if (sale) return { sale, items: itemsFor(sale) };
  const { getAdapter } = await import("./data/backend.js");
  const adapter = getAdapter();
  if (!adapter) return null;
  try {
    const r = await adapter.getSale({ invoiceNo: String(no).trim() });
    return r && r.sale ? r : null;
  } catch {
    return null;
  }
}
