// Offline-first sync engine.
//
// Every user action is applied to the local database immediately and appended to an outbox.
// When a Google Sheet is connected and we're online, ops are replayed in order, then a pull
// brings back authoritative rows (other counters, real invoice numbers, server-assigned ids).
import { getAdapter, getConfig, isConnected } from "./data/backend.js";
import * as localdb from "./localdb.js";

const HISTORY_DAYS = 90;
const PRUNE_AFTER_DAYS = 14;
const emit = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));

export const syncState = {
  online: typeof navigator === "undefined" ? true : navigator.onLine,
  syncing: false,
  lastSyncAt: null,
  pending: 0,
  failed: [],
  lastError: null,
  lastResult: null, // { pushed, pulled, at }
};

let timer = null;
let backoff = 0;

const sortOps = (ops) => ops.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));

/**
 * Turns a product reference into the id the sheet understands.
 * Accepts a number (already a server id) or a local id (with or without the "l:" prefix).
 * Throws (as transient) when the product hasn't been uploaded yet, so the change waits
 * instead of being sent with a null id.
 */
function resolveRef(ref, idmap) {
  if (ref === null || ref === undefined || ref === "") throw unresolvable(ref);
  if (typeof ref === "number") return ref;
  const s = String(ref).trim();
  if (s !== "" && !Number.isNaN(Number(s))) return Number(s);
  const key = s.startsWith("l:") ? s.slice(2) : s;
  const mapped = idmap[key];
  if (mapped === undefined || mapped === null) throw unresolvable(key);
  return mapped;
}

function unresolvable(ref) {
  const err = new Error("Waiting for a product to be uploaded first");
  err.transient = true;
  err.ref = ref;
  return err;
}

function resetStatus() {
  syncState.lastError = null;
  emit("sync:status");
}

/* ------------------------------------------------------------------ */
/* push                                                              */
/* ------------------------------------------------------------------ */

/**
 * Any product that exists only on this PC (no server id) but is referenced by a queued
 * change must be uploaded first — otherwise the sale/stock change has nothing to point at.
 * Creates the missing "saveProduct" ops and returns them.
 */
async function ensureReferencedProducts(pending) {
  const queued = new Set(pending.filter((o) => o.type === "saveProduct").map((o) => o.payload.productLocalId));
  const needed = new Map();
  for (const op of pending) {
    const refs = [];
    if (op.type === "checkout") for (const it of op.payload.items || []) refs.push(it.productLocalId);
    else if (op.type === "adjustStock") refs.push(op.payload.productLocalId);
    for (const r of refs) {
      if (!r || queued.has(r) || needed.has(r)) continue;
      const p = await localdb.getProduct(r);
      if (p && (p.id === null || p.id === undefined) && !p.localOnly) {
        needed.set(r, p);
        queued.add(r);
      }
    }
  }
  const ops = [];
  for (const p of needed.values()) {
    ops.push(await localdb.enqueueOp("saveProduct", { product: localdb.pubProductForSync(p), productLocalId: p.localId }));
  }
  return ops;
}

async function pushAll() {
  const adapter = getAdapter();
  if (!adapter) return 0;
  const existing = sortOps(await localdb.getOps("pending"));
  // Products first, then everything else: a sale can't be uploaded before its product exists.
  const created = await ensureReferencedProducts(existing);
  const ops = [...created, ...existing];
  let pushed = 0;

  for (const op of ops) {
    const meta = await localdb.getMeta();
    const idmap = meta.idmap || {};
    let payload;
    try {
      payload = buildPayload(op, idmap);
    } catch (e) {
      if (e.transient) break; // blocked on an earlier op — stop here
      await fail(op, e.message);
      continue;
    }

    try {
      const res = await adapter[op.type](payload);
      op.status = "done";
      op.attempts += 1;
      op.lastTriedAt = new Date().toISOString();
      op.lastError = null;
      await localdb.putOp(op);

      // Adopt the server's version: real ids, invoice numbers and stock levels.
      if (op.type === "saveProduct" && res.product) {
        await localdb.mergeServerProduct(res.product, op.payload.productLocalId);
      } else if (op.type === "adjustStock" && res.product) {
        await localdb.mergeServerProduct(res.product, op.payload.productLocalId);
      } else if (op.type === "checkout" && res.sale) {
        await localdb.mergeServerSale(res.sale, res.items, op.payload.saleLocalId);
        for (const p of res.products || []) await localdb.mergeServerProduct(p, null);
      } else if (op.type === "voidSale" && res.sale) {
        await localdb.mergeServerSale(res.sale, res.items, op.payload.saleLocalId);
        for (const p of res.products || []) await localdb.mergeServerProduct(p, null);
      } else if (op.type === "importProducts" && Array.isArray(res.products)) {
        // Match what came back by SKU so local records pick up their server ids.
        const bySku = new Map(res.products.map((p) => [String(p.sku).toLowerCase(), p]));
        for (const sent of op.payload.products || []) {
          const server = bySku.get(String(sent.sku).toLowerCase());
          if (server) await localdb.mergeServerProduct(server, sent.productLocalId);
        }
      } else if (op.type === "saveSettings" && res.settings) {
        await localdb.setSettings(res.settings);
      }
      pushed += 1;
      syncState.pending = Math.max(0, syncState.pending - 1);
      emit("sync:status");
    } catch (e) {
      if (e.transient) {
        // Network/timeout: leave it pending and try again later.
        syncState.lastError = e.message;
        break;
      }
      await fail(op, e.message);
    }
  }
  return pushed;
}

async function fail(op, message) {
  op.status = "failed";
  op.lastError = message;
  op.attempts += 1;
  op.lastTriedAt = new Date().toISOString();
  await localdb.putOp(op);
}

function buildPayload(op, idmap) {
  const p = op.payload || {};
  switch (op.type) {
    case "saveProduct": {
      const product = { ...p.product };
      delete product.id; // the sheet assigns ids; local ids never travel
      product.localId = undefined;
      return { product };
    }
    case "deleteProduct":
      return { id: resolveRef(p.id, idmap) };
    case "adjustStock":
      return {
        productId: resolveRef(p.productId !== null && p.productId !== undefined ? p.productId : p.productLocalId, idmap),
        mode: p.mode,
        quantity: p.quantity,
        reason: p.reason,
      };
    case "checkout":
      return {
        items: (p.items || []).map((it) => ({
          productId: resolveRef(it.productId !== null && it.productId !== undefined ? it.productId : it.productLocalId, idmap),
          qty: it.qty,
        })),
        discountType: p.discountType,
        discountValue: p.discountValue,
        customerName: p.customerName,
        customerPhone: p.customerPhone,
        paymentMethod: p.paymentMethod,
        amountPaid: p.amountPaid,
        note: p.note,
        clientRef: p.clientRef,
      };
    case "voidSale":
      return { id: resolveRef(p.id, idmap) };
    case "importProducts":
      return {
        products: (p.products || []).map((x) => {
          const { productLocalId, ...rest } = x; // eslint-disable-line no-unused-vars
          return rest;
        }),
      };
    case "saveSettings":
      return { settings: p.settings || p };
    default:
      throw new Error(`Unknown queued change: ${op.type}`);
  }
}

/* ------------------------------------------------------------------ */
/* pull                                                              */
/* ------------------------------------------------------------------ */

async function pull() {
  const adapter = getAdapter();
  if (!adapter) return 0;
  const meta = await localdb.getMeta();
  const res = await adapter.bootstrap({ days: HISTORY_DAYS, since: meta.lastPullAt });
  const merged = await localdb.applyPull(res);
  if (res.settings) await localdb.setSettings(res.settings);
  await localdb.setMeta({
    spreadsheetName: res.spreadsheetName || "",
    spreadsheetUrl: res.spreadsheetUrl || "",
  });
  await localdb.setMeta({ lastPullAt: new Date().toISOString(), isDemo: false });
  return merged.sales.length + merged.products.length;
}

async function pruneOldDone() {
  const cutoff = Date.now() - PRUNE_AFTER_DAYS * 86400000;
  const done = await localdb.getOps("done");
  const stale = done.filter((o) => new Date(o.createdAt).getTime() < cutoff);
  if (stale.length) await localdb.putOps(stale.map((o) => ({ ...o, status: "pruned" })));
}

/* ------------------------------------------------------------------ */
/* public API                                                        */
/* ------------------------------------------------------------------ */

/** Remembers which sheet we're talking to (shown in Settings). */
export async function noteConnection(info) {
  await localdb.setMeta({
    spreadsheetName: info.spreadsheetName || "",
    spreadsheetUrl: info.spreadsheetUrl || "",
  });
}

export async function refreshCounts() {
  const [pending, failed] = await Promise.all([localdb.pendingCount(), localdb.getOps("failed")]);
  syncState.pending = pending;
  syncState.failed = sortOps(failed);
  const meta = await localdb.getMeta();
  syncState.lastSyncAt = meta.lastSyncAt ? new Date(meta.lastSyncAt) : null;
  emit("sync:status");
  return syncState;
}

/** Push the queue, then pull. Safe to call repeatedly (single flight). */
export async function syncNow({ reason = "manual" } = {}) {
  if (syncState.syncing || !isConnected() || !syncState.online) {
    await refreshCounts();
    return { skipped: true, reason };
  }
  syncState.syncing = true;
  resetStatus();
  try {
    const pushed = await pushAll();
    let pulled = 0;
    if (!syncState.lastError) {
      try {
        pulled = await pull();
      } catch (e) {
        syncState.lastError = e.transient ? e.message : e.message;
      }
    }
    if (!syncState.lastError) {
      await localdb.setMeta({ lastSyncAt: new Date().toISOString() });
      await pruneOldDone();
    }
    syncState.lastResult = { pushed, pulled, at: new Date().toISOString() };
    await refreshCounts();
    emit("data:changed");
    return { pushed, pulled };
  } finally {
    syncState.syncing = false;
    backoff = syncState.lastError ? Math.min(backoff ? backoff * 2 : 5000, 120000) : 0;
    emit("sync:status");
  }
}

/** Called after any local change. Debounced so a burst of edits is one upload. */
export function schedulePush(delay = 1500) {
  if (!isConnected() || !syncState.online) {
    refreshCounts();
    return;
  }
  if (timer) clearTimeout(timer);
  const wait = Math.max(delay, backoff);
  timer = setTimeout(() => {
    timer = null;
    syncNow({ reason: "auto" });
  }, wait);
}

export function retryFailed() {
  return localdb.getOps("failed").then((ops) =>
    Promise.all(ops.map((o) => localdb.retryOp(o.id))).then(() => {
      backoff = 0;
      syncState.lastError = null;
      return syncNow({ reason: "retry" });
    }),
  );
}

export function discardFailed(opId) {
  return localdb.discardOp(opId).then(() => refreshCounts());
}

export async function initSync() {
  const setOnline = (online) => {
    const was = syncState.online;
    syncState.online = online;
    if (!online) emit("sync:status");
    else if (!was && isConnected()) {
      emit("sync:status");
      syncNow({ reason: "back-online" });
    }
  };
  window.addEventListener("online", () => setOnline(true));
  window.addEventListener("offline", () => setOnline(false));
  syncState.online = navigator.onLine;

  // Regular catch-up while the till is open.
  setInterval(() => {
    if (document.visibilityState === "visible" && !syncState.syncing) syncNow({ reason: "interval" });
  }, 45000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && isConnected()) syncNow({ reason: "visible" });
  });
  await refreshCounts();
  if (isConnected() && syncState.online) syncNow({ reason: "startup" });
}
