// Minimal promise wrapper over IndexedDB (no dependencies, works offline).
const DB_NAME = "freshmart-pos";
const DB_VERSION = 1;
export const STORES = ["kv", "products", "sales", "ops"];

let dbPromise = null;

export function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("products")) {
        const s = db.createObjectStore("products", { keyPath: "localId" });
        s.createIndex("byId", "id", { unique: false });
        s.createIndex("bySku", "sku", { unique: false });
      }
      if (!db.objectStoreNames.contains("sales")) {
        const s = db.createObjectStore("sales", { keyPath: "localId" });
        s.createIndex("byId", "id", { unique: false });
        s.createIndex("byCreated", "createdAt", { unique: false });
      }
      if (!db.objectStoreNames.contains("ops")) {
        const s = db.createObjectStore("ops", { keyPath: "id" });
        s.createIndex("byStatus", "status", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("Could not open the local database"));
    req.onblocked = () => reject(new Error("The local database is blocked by another tab"));
  });
  return dbPromise;
}

function run(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store), tx);
        tx.oncomplete = () => resolve(req && "result" in req ? req.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
      }),
  );
}

const readOnly = (store, fn) => run(store, "readonly", fn);
const readWrite = (store, fn) => run(store, "readwrite", fn);

export const get = (store, key) => readOnly(store, (s) => s.get(key));
export const getAll = (store) => readOnly(store, (s) => s.getAll());
export const put = (store, value, key) => readWrite(store, (s) => s.put(value, key));
export const del = (store, key) => readWrite(store, (s) => s.delete(key));
export const clear = (store) => readWrite(store, (s) => s.clear());
export const count = (store) => readOnly(store, (s) => s.count());
export const putAll = (store, values) => readWrite(store, (s) => values.forEach((v) => s.put(v)));

export function byIndex(store, index, value) {
  return readOnly(store, (s) => s.index(index).getAll(value));
}

/** Runs several stores in one transaction so local state never ends up half-written. */
export function atomic(fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORES, "readwrite");
        const api = Object.fromEntries(STORES.map((n) => [n, tx.objectStore(n)]));
        let result;
        Promise.resolve(fn(api))
          .then((r) => (result = r))
          .catch((e) => {
            try {
              tx.abort();
            } catch {
              /* already aborted */
            }
            reject(e);
          });
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
      }),
  );
}

/** Wipes everything (used when switching data sources). */
export async function wipe() {
  for (const s of STORES) await clear(s);
}
