// App bootstrap: hash router, shell, sync + PWA wiring, global scanner
import { isConnected, getConfig } from "./data/backend.js";
import * as dashboard from "./dashboard.js";
import * as inventory from "./inventory.js";
import * as labels from "./labels.js";
import * as pos from "./pos.js";
import * as sales from "./sales.js";
import { openScanner } from "./scanner.js";
import * as settings from "./settings.js";
import { findByCode, loadAll, state } from "./store.js";
import { initSync, syncState } from "./sync.js";
import { initPwa, isStandalone, promptInstall, watchInstall } from "./pwa.js";
import { $, $$, esc, hydrateIcons, icon, toast } from "./ui.js";

const routes = {
  dashboard: { title: "Dashboard", sub: () => state.settings.storeName, mod: dashboard },
  pos: { title: "POS / Billing", sub: () => "F2 search · F4 scan · F8 hold · F9 pay", mod: pos },
  inventory: { title: "Inventory", sub: () => "Products, stock levels & QR codes", mod: inventory },
  labels: { title: "QR Labels", sub: () => "Print scannable product labels", mod: labels },
  sales: { title: "Invoices", sub: () => "Sales history & receipts", mod: sales },
  settings: { title: "Settings", sub: () => "Data, sync, store profile & receipt", mod: settings },
};

let current = null; // { name, mod, view }
let refreshPending = false;

async function navigate() {
  const name = location.hash.replace(/^#\/?/, "").split("?")[0] || "dashboard";
  const key = routes[name] ? name : "dashboard";
  const route = routes[key];

  if (current && current.mod.unmount) current.mod.unmount();

  // Fresh element per navigation so a slow, superseded mount can't write into the new view.
  const old = document.getElementById("view");
  const view = old.cloneNode(false);
  view.className = "view";
  old.replaceWith(view);

  $$("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.route === key));
  $("#pageTitle").textContent = route.title;
  $("#pageSub").textContent = route.sub();
  document.title = `${route.title} · ${state.settings.storeName}`;
  current = { name: key, mod: route.mod, view };

  try {
    await route.mod.mount(view);
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="empty"><div class="big">⚠️</div><h4>Something went wrong</h4><p>${esc(e.message || "Unable to load this page")}</p><button class="btn btn-primary" onclick="location.reload()" style="margin-top:12px">Reload</button></div>`;
  }
}

function applyBrand() {
  $("#brandName").textContent = state.settings.storeName;
  if (current) {
    document.title = `${routes[current.name].title} · ${state.settings.storeName}`;
    $("#pageSub").textContent = routes[current.name].sub();
  }
  renderSync();
}

function tickClock() {
  const now = new Date();
  $("#clockTime").textContent = now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  $("#clockDate").textContent = now.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

/* ---------- sync status pill + banner ---------- */
function renderSync() {
  const pill = $("#syncPill");
  const txt = $("#syncText");
  const live = isConnected();
  const { online, syncing, pending, failed, lastSyncAt, lastError } = syncState;

  pill.classList.remove("ok", "demo", "err", "busy", "offline");
  if (!live) {
    pill.classList.add("demo");
    txt.textContent = pending ? `Local · ${pending} to sync` : "Local";
    pill.title = "Data is stored on this PC. Connect a Google Sheet in Settings to sync.";
  } else if (syncing) {
    pill.classList.add("busy");
    txt.textContent = "Syncing…";
    pill.title = "Uploading your changes to Google Sheets";
  } else if (!online) {
    pill.classList.add("offline");
    txt.textContent = pending ? `Offline · ${pending} queued` : "Offline";
    pill.title = "No connection. Sales keep working and will upload automatically.";
  } else if (failed.length) {
    pill.classList.add("err");
    txt.textContent = `${failed.length} not synced`;
    pill.title = "Some changes could not be uploaded. Click for details.";
  } else if (lastError) {
    pill.classList.add("err");
    txt.textContent = "Sync problem";
    pill.title = lastError;
  } else {
    pill.classList.add("ok");
    txt.textContent = `Synced ${lastSyncAt ? lastSyncAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "✓"}`;
    pill.title = "Google Sheets up to date. Click to sync now.";
  }

  const banner = $("#banner");
  const show = live && !online && pending > 0;
  banner.classList.toggle("hidden", !show);
  if (show) {
    banner.innerHTML = `${icon("alert")}<span><b>You're offline — the till keeps working.</b> ${pending} change${pending > 1 ? "s" : ""} will upload to Google Sheets when you're back online.</span>
      <a class="btn btn-sm btn-outline" href="#/settings">Sync details</a>`;
    hydrateIcons(banner);
  }
}

async function onPillClick() {
  if (!isConnected()) {
    location.hash = "#/settings";
    return;
  }
  const { syncNow } = await import("./sync.js");
  const r = await syncNow({ reason: "manual" });
  if (r && r.skipped) toast(syncState.online ? "Already syncing" : "You're offline — changes are queued", "warn");
  else toast(`Uploaded ${r.pushed} change${r.pushed === 1 ? "" : "s"} · pulled ${r.pulled} row${r.pulled === 1 ? "" : "s"}`);
}

function applyDataChange() {
  if (!current) return;
  if (document.querySelector(".modal-backdrop")) {
    refreshPending = true; // don't yank the UI while a dialog is open
    return;
  }
  refreshPending = false;
  if (current.mod.refresh) current.mod.refresh();
  else current.mod.mount(current.view);
}

async function flushPendingRefresh() {
  if (refreshPending && !document.querySelector(".modal-backdrop")) applyDataChange();
}

async function handleGlobalCode(code) {
  if (/^INV-/i.test(code)) {
    const ok = await sales.openInvoiceByNo(code);
    return ok ? { ok: true, message: "Invoice found" } : { ok: false, message: `Invoice ${code} not found` };
  }
  const p = findByCode(code);
  if (!p) return { ok: false, message: `No product for "${code}"` };
  inventory.showProductCard(p, { onSaved: () => navigate() });
  return { ok: true, message: `${p.emoji} ${p.name}` };
}

async function init() {
  hydrateIcons(document);
  $("#brandLogo").innerHTML = icon("bag");
  tickClock();
  setInterval(tickClock, 20_000);

  window.addEventListener("sync:status", () => {
    renderSync();
    void flushPendingRefresh();
  });
  window.addEventListener("data:changed", applyDataChange);
  window.addEventListener("settings:changed", applyBrand);
  $("#syncPill").addEventListener("click", onPillClick);
  $("#globalScan").addEventListener("click", () => {
    if (current && current.name === "pos") return pos.startScan();
    openScanner({ title: "Scan code", onCode: handleGlobalCode });
  });

  // Local data first — the app is usable immediately, with or without a network.
  await loadAll();
  $("#brandName").textContent = state.settings.storeName;

  await initSync();
  initPwa();
  watchInstall((available) => $("#installBtn").classList.toggle("hidden", !available || isStandalone()));
  $("#installBtn").addEventListener("click", promptInstall);
  if (isStandalone()) $("#installBtn").classList.add("hidden");

  renderSync();
  window.addEventListener("hashchange", navigate);
  navigate();
}

init();
