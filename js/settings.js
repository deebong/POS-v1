// Settings: data source & sync queue, offline/PWA, store profile, live receipt preview
import { getConfig, isConnected, saveConfig, LOCAL_ONLY, SHEETS } from "./data/backend.js";
import { createSheetsAdapter } from "./data/sheets-adapter.js";
import { sampleProducts } from "./data/sample.js";
import { receiptHtml } from "./receipt.js";
import { clearLocalData, clearQueue, enqueueAllProductsForSync, initLocal } from "./localdb.js";
import { adoptPulledData, loadAll, saveSettings, state } from "./store.js";
import { discardFailed, retryFailed, syncNow, syncState, noteConnection } from "./sync.js";
import { isStandalone, promptInstall, storageInfo } from "./pwa.js";
import { confirmDialog, downloadFile, $, esc, hydrateIcons, icon, openModal, toast } from "./ui.js";

const SAMPLE_SALE = {
  invoiceNo: "INV-20250101-00042",
  createdAt: new Date().toISOString(),
  customerName: "Sample customer",
  customerPhone: "",
  subtotal: 6.94,
  discount: 0,
  tax: 0.17,
  total: 7.11,
  paymentMethod: "cash",
  amountPaid: 10,
  changeDue: 2.89,
  status: "completed",
};
const SAMPLE_ITEMS = [
  { name: "Bananas", qty: 1.25, unit: "kg", price: 0.79, lineSubtotal: 0.99 },
  { name: "Whole Milk 1L", qty: 2, unit: "pc", price: 1.15, lineSubtotal: 2.3 },
  { name: "Sourdough Loaf", qty: 1, unit: "pc", price: 3.5, lineSubtotal: 3.5 },
  { name: "Cola 330ml", qty: 1, unit: "pc", price: 0.15, lineSubtotal: 0.15 },
];

const CODE_URL = "apps-script/Code.gs";
const OP_LABEL = {
  saveProduct: "Product saved",
  deleteProduct: "Product deleted",
  adjustStock: "Stock adjusted",
  checkout: "Sale recorded",
  voidSale: "Invoice voided",
  saveSettings: "Settings changed",
};

async function fetchCode() {
  const res = await fetch(CODE_URL, { cache: "no-store" });
  if (!res.ok) throw new Error("Couldn't load Code.gs");
  return res.text();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { /* ignore */ }
    ta.remove();
    return ok;
  }
}

const busy = (btn, on, label) => {
  if (on) {
    btn.dataset.label = btn.dataset.label || btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = label;
  } else {
    btn.disabled = false;
    btn.innerHTML = btn.dataset.label || btn.innerHTML;
  }
};

export function refresh() {
  /* keep the form untouched during background syncs */
}

/* ------------------------------------------------------------------ */
/* sync queue panel                                                   */
/* ------------------------------------------------------------------ */
function openSyncPanel() {
  const modal = openModal({
    title: "Sync status",
    sub: isConnected() ? "Changes are uploaded to your Google Sheet" : "No sheet connected — everything stays on this PC",
    size: "md",
    body: "",
    footer: "",
  });

  const draw = () => {
    const live = isConnected();
    const failed = syncState.failed;
    modal.body.innerHTML = `
      <div class="sync-stats">
        <div><span class="s">Connection</span><b>${live ? "Google Sheets" : "Local only"}</b></div>
        <div><span class="s">Network</span><b style="color:${syncState.online ? "var(--primary-700)" : "#c8323a"}">${syncState.online ? "Online" : "Offline"}</b></div>
        <div><span class="s">Waiting to upload</span><b>${syncState.pending}</b></div>
        <div><span class="s">Last sync</span><b>${syncState.lastSyncAt ? syncState.lastSyncAt.toLocaleTimeString() : "never"}</b></div>
      </div>
      ${syncState.lastError && live ? `<div class="pay-note">${icon("alert")}<div>${esc(syncState.lastError)}</div></div>` : ""}
      ${
        failed.length
          ? `<h4 class="panel-sub">Couldn't upload (${failed.length})</h4>
             <div class="list">${failed
               .map(
                 (o) => `<div class="list-row">
                   <span class="thumb">${icon("alert")}</span>
                   <div class="grow"><div class="t">${esc(OP_LABEL[o.type] || o.type)}</div>
                     <div class="s">${esc(o.lastError || "Rejected by the sheet")} · ${new Date(o.createdAt).toLocaleString()}</div></div>
                   <button class="btn btn-sm btn-soft" data-retry="${o.id}">Retry</button>
                   <button class="btn btn-sm btn-danger-soft" data-discard="${o.id}">Keep local</button>
                 </div>`,
               )
               .join("")}</div>
             <p class="muted" style="margin-top:10px">“Keep local” leaves the change on this PC and stops retrying — nothing is deleted.</p>`
          : `<div class="empty" style="padding:24px"><div class="big">✅</div><p>${live ? "Everything is in sync." : "Connect a Google Sheet to sync automatically."}</p></div>`
      }
      ${
        live
          ? `<h4 class="panel-sub">How syncing works</h4>
             <ul class="plain-list">
               <li>Every action is saved to this PC first, so billing never waits for the network.</li>
               <li>Queued changes upload in order when a connection is available.</li>
               <li>Each sale carries a unique reference, so a retry can never charge a customer twice.</li>
               <li>Offline bills get a temporary number like <span class="mono">…-L12</span>; the sheet assigns the final one on upload.</li>
             </ul>`
          : ""
      }`;
    modal.foot.innerHTML = `
      ${failed.length ? `<button class="btn btn-soft left" id="spRetryAll">${icon("undo")} Retry all</button>` : ""}
      ${live ? `<button class="btn btn-outline" id="spSyncNow">${icon("layers")} Sync now</button>` : ""}
      <button class="btn btn-primary" data-done>Close</button>`;

    modal.$("[data-done]").onclick = () => modal.close();
    const now = modal.$("#spSyncNow");
    if (now) now.onclick = async () => { busy(now, true, "Syncing…"); await syncNow(); draw(); };
    const all = modal.$("#spRetryAll");
    if (all) all.onclick = async () => { busy(all, true, "Retrying…"); await retryFailed(); draw(); };
    modal.body.querySelectorAll("[data-retry]").forEach((b) => (b.onclick = async () => {
      b.disabled = true;
      await retryFailed();
      draw();
    }));
    modal.body.querySelectorAll("[data-discard]").forEach((b) => (b.onclick = async () => {
      b.disabled = true;
      await discardFailed(b.dataset.discard);
      draw();
    }));
  };

  const onStatus = () => draw();
  window.addEventListener("sync:status", onStatus);
  const origClose = modal.close.bind(modal);
  modal.close = () => {
    window.removeEventListener("sync:status", onStatus);
    origClose();
  };
  draw();
  return modal;
}
export { openSyncPanel };

/* ------------------------------------------------------------------ */
/* page                                                               */
/* ------------------------------------------------------------------ */
export async function mount(el) {
  const s = state.settings;
  const cfg = getConfig();
  const live = cfg.mode === SHEETS;
  const meta = state.meta;
  const storage = await storageInfo();

  el.innerHTML = `
  <div class="view-enter">
    <div class="page-head">
      <div><h2>Settings</h2><p>Choose where your data lives, and edit the store details shown on receipts.</p></div>
      <div class="actions"><button class="btn btn-primary" id="setSave">${icon("check")} Save store details</button></div>
    </div>
    <div class="settings-grid">
      <div style="display:grid;gap:16px">

        <div class="card card-pad" id="dsCard">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
            <span class="stat-icon ${live ? "green" : "blue"}">${icon(live ? "layers" : "box", "lg")}</span>
            <div style="flex:1"><h3 style="font-size:16px">Data &amp; sync</h3>
              <div class="muted">${live ? "Saved on this PC and synced with your Google Sheet." : "Saved on this PC (works offline). Connect a sheet to sync."}</div></div>
            <span class="badge ${live ? "badge-green" : "badge-blue"}">${live ? "Synced" : "Local"}</span>
          </div>

          ${
            live
              ? `<div class="ds-connected">
                   <div><div class="t">${esc(meta.spreadsheetName || "Connected spreadsheet")}</div>
                     <div class="muted" style="font-size:12.5px">${syncState.pending ? `${syncState.pending} change${syncState.pending > 1 ? "s" : ""} waiting` : "Up to date"} · ${syncState.lastSyncAt ? "synced " + syncState.lastSyncAt.toLocaleTimeString() : "not synced yet"}</div></div>
                   ${meta.spreadsheetUrl ? `<a class="btn btn-sm btn-outline" href="${esc(meta.spreadsheetUrl)}" target="_blank" rel="noopener">Open sheet ↗</a>` : ""}
                   <button class="btn btn-sm btn-soft" id="dsSync">${icon("undo", "sm")} Sync now</button>
                   <button class="btn btn-sm btn-outline" id="dsPanel">Details</button>
                 </div>`
              : `<div class="pay-note" style="margin:0 0 14px">${icon("box", "lg")}<div><b>Everything is stored on this computer.</b> Sales, stock and invoices keep working with no internet. Connect a Google Sheet below to back them up automatically and see them on other tills.</div></div>`
          }

          <div class="form-grid" style="margin-top:${live ? "14px" : "0"}">
            <div class="field span-2"><label>Apps Script Web App URL</label>
              <input class="input" id="dsUrl" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(cfg.url || "")}" spellcheck="false" /></div>
            <div class="field span-2"><label>Access key <span class="muted">(only if you set API_KEY in the script)</span></label>
              <input class="input" id="dsKey" type="password" autocomplete="off" placeholder="optional" value="${esc(cfg.key || "")}" /></div>
          </div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px">
            <button class="btn btn-primary" id="dsConnect">${icon("check")} ${live ? "Update &amp; sync" : "Connect Google Sheet"}</button>
            <button class="btn btn-outline" id="dsTest">Test connection</button>
            ${live ? `<button class="btn btn-danger-soft" id="dsLocal">Stop syncing</button>` : ""}
          </div>

          <details class="guide" ${live ? "" : "open"}>
            <summary>How to set up the Google Sheets backend <span class="muted">(2 minutes, no coding)</span></summary>
            <ol class="steps">
              <li>Create a new <b>Google Sheet</b> (any name).</li>
              <li>Open <b>Extensions ▸ Apps Script</b>, delete the sample code and paste the backend script.
                <div class="step-actions"><button class="btn btn-sm btn-outline" id="dsCopy">${icon("list", "sm")} Copy Code.gs</button>
                <button class="btn btn-sm btn-ghost" id="dsDownload">${icon("download", "sm")} Download</button></div></li>
              <li>Click <b>Deploy ▸ New deployment ▸ Web app</b>. Set <b>Execute as: Me</b> and <b>Who has access: Anyone</b>, then Deploy and authorise.</li>
              <li>Copy the <b>Web app URL</b> (ends in <span class="mono">/exec</span>), paste it above and click <b>Connect</b>.</li>
            </ol>
            <p class="muted" style="font-size:12.5px">The tabs <span class="mono">Products, Sales, SaleItems, StockMovements, Settings</span> are created automatically — you can filter, chart or back them up right in Sheets.
            For extra security set <span class="mono">API_KEY</span> at the top of the script and enter the same key here. After editing the script, redeploy as a <b>New version</b>.</p>
          </details>
        </div>

        <div class="card card-pad" id="pwaCard">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
            <span class="stat-icon violet">${icon("download", "lg")}</span>
            <div style="flex:1"><h3 style="font-size:16px">Offline use on this PC</h3>
              <div class="muted">Install the app and check how much space the local database is using.</div></div>
          </div>
          <div class="sync-stats" style="grid-template-columns:repeat(3,1fr)">
            <div><span class="s">Installed</span><b>${isStandalone() ? "Yes ✓" : "In browser"}</b></div>
            <div><span class="s">Offline ready</span><b>${"serviceWorker" in navigator ? "Yes ✓" : "No"}</b></div>
            <div><span class="s">Storage</span><b>${storage ? `${storage.mb(storage.usage)}${storage.quota ? " / " + storage.mb(storage.quota) : ""}` : "—"}</b></div>
          </div>
          <p class="muted" style="margin-top:12px">${storage && storage.persisted ? "The browser has been asked to keep this data permanently." : "Browsers can clear storage they consider unused; keeping the app installed helps prevent that."}</p>
          <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px">
            ${isStandalone() ? "" : `<button class="btn btn-primary" id="pwaInstall">${icon("download")} Install on this PC</button>`}
            <button class="btn btn-outline" id="pwaQueue">${icon("layers")} Sync details</button>
            <button class="btn btn-danger-soft" id="pwaReset">${icon("trash")} Reset local data</button>
          </div>
        </div>

        <form class="card card-pad" id="setForm" autocomplete="off">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px"><span class="stat-icon green">${icon("store", "lg")}</span><div><h3 style="font-size:16px">Store profile</h3><div class="muted">Appears in the receipt header${live ? " · saved to the Settings tab" : ""}</div></div></div>
          <div class="form-grid">
            <div class="field span-2"><label>Store name</label><input class="input" name="storeName" required value="${esc(s.storeName)}" /></div>
            <div class="field span-2"><label>Address</label><input class="input" name="address" value="${esc(s.address)}" /></div>
            <div class="field"><label>Phone</label><input class="input" name="phone" value="${esc(s.phone)}" /></div>
            <div class="field"><label>Tax / GST / VAT ID</label><input class="input" name="taxId" value="${esc(s.taxId)}" /></div>
            <div class="field"><label>Currency symbol</label><input class="input" name="currency" maxlength="4" value="${esc(s.currency)}" /></div>
            <div class="field"><label>Tax label</label><input class="input" name="taxLabel" maxlength="12" value="${esc(s.taxLabel)}" placeholder="Tax, GST, VAT…" /></div>
            <div class="field span-2"><label>QR payment ID <span class="muted">(optional, e.g. UPI VPA)</span></label><input class="input" name="upiId" value="${esc(s.upiId || "")}" placeholder="store@bank" /><span class="hint">Used to generate the “QR Pay” code at checkout.</span></div>
            <div class="field span-2"><label>Receipt footer message</label><textarea class="textarea" name="receiptFooter" rows="2">${esc(s.receiptFooter)}</textarea></div>
          </div>
        </form>

        <div class="card card-pad">
          <h3 style="font-size:16px;margin-bottom:14px">Keyboard shortcuts</h3>
          <div class="shortcut-list">
            <div><span>Focus product search / scanner input</span><span><span class="kbd">F2</span> or <span class="kbd">/</span></span></div>
            <div><span>Open camera scanner</span><span class="kbd">F4</span></div>
            <div><span>Hold current order</span><span class="kbd">F8</span></div>
            <div><span>Take payment</span><span class="kbd">F9</span></div>
            <div><span>Close dialogs</span><span class="kbd">Esc</span></div>
          </div>
          <p class="muted" style="margin-top:14px">USB and Bluetooth barcode / QR scanners work out of the box: click the POS search box and scan — the item is added automatically.</p>
        </div>
      </div>

      <div class="card" style="position:sticky;top:0">
        <div class="card-head"><div><h3>Receipt preview</h3><div class="sub">Updates as you type</div></div></div>
        <div class="card-body"><div class="receipt-stage" id="setPreview" style="border-radius:14px"></div></div>
      </div>
    </div>
  </div>`;
  hydrateIcons(el);

  /* ----- store profile ----- */
  const form = $("#setForm", el);
  const read = () => Object.fromEntries(new FormData(form).entries());
  const preview = () => {
    const prev = state.settings;
    state.settings = { ...prev, ...read() };
    try {
      $("#setPreview", el).innerHTML = receiptHtml(SAMPLE_SALE, SAMPLE_ITEMS, state.settings);
    } finally {
      state.settings = prev;
    }
  };
  form.addEventListener("input", preview);
  preview();

  let saving = false;
  const save = async () => {
    if (saving || !form.reportValidity()) return;
    saving = true;
    const btn = $("#setSave", el);
    btn.disabled = true;
    try {
      await saveSettings(read());
      window.dispatchEvent(new CustomEvent("settings:changed"));
      toast("Store details saved");
      preview();
    } catch (e) {
      toast(e.message, "error");
    } finally {
      saving = false;
      btn.disabled = false;
    }
  };
  $("#setSave", el).onclick = save;
  form.addEventListener("submit", (e) => { e.preventDefault(); save(); });

  /* ----- sync / queue panels ----- */
  $("#pwaQueue", el).onclick = openSyncPanel;
  const panelBtn = $("#dsPanel", el);
  if (panelBtn) panelBtn.onclick = openSyncPanel;
  const syncBtn = $("#dsSync", el);
  if (syncBtn) {
    syncBtn.onclick = async () => {
      busy(syncBtn, true, "Syncing…");
      const r = await syncNow();
      busy(syncBtn, false);
      if (!r || r.skipped) toast(syncState.online ? "Already syncing" : "You're offline — changes are queued", "warn");
      else toast(`Uploaded ${r.pushed} · pulled ${r.pulled}`);
      mount(el);
    };
  }

  /* ----- data source ----- */
  const inputs = () => ({ url: $("#dsUrl", el).value.trim(), key: $("#dsKey", el).value.trim() });
  const checkUrl = (url) => {
    if (!url) return "Paste your Web App URL first";
    if (!/^https:\/\/script\.google\.com\/(a\/[^/]+\/)?macros\/s\/[^/]+\/(exec|dev)$/.test(url)) {
      return "That doesn't look like an Apps Script Web App URL (https://script.google.com/macros/s/…/exec)";
    }
    if (url.endsWith("/dev")) return "Use the deployed URL ending in /exec, not /dev";
    return null;
  };

  $("#dsTest", el).onclick = async (e) => {
    const { url, key } = inputs();
    const bad = checkUrl(url);
    if (bad) return toast(bad, "error");
    const btn = e.currentTarget;
    busy(btn, true, "Testing…");
    try {
      const info = await createSheetsAdapter({ url, key }).ping();
      toast(`Connected to “${info.spreadsheetName}”`);
    } catch (err) {
      toast(err.message, "error");
    } finally {
      busy(btn, false);
    }
  };

  $("#dsConnect", el).onclick = async (e) => {
    const { url, key } = inputs();
    const bad = checkUrl(url);
    if (bad) return toast(bad, "error");
    const btn = e.currentTarget;
    busy(btn, true, "Connecting…");
    const previous = getConfig();
    const adapter = createSheetsAdapter({ url, key });
    try {
      const info = await adapter.ping();
      const serverData = await adapter.bootstrap({ days: 90 });
      const hasServerData = (serverData.products || []).length > 0;
      const localIsDemo = state.meta.isDemo;
      const pending = syncState.pending;

      // Decide what to do with whatever is already on this PC.
      if (localIsDemo) {
        if (hasServerData) {
          const ok = await confirmDialog({
            title: "Use the data from your sheet?",
            message: `This PC only has sample data on it. It will be replaced with the ${serverData.products.length} products and invoices from your Google Sheet.`,
            confirmText: "Use sheet data",
          });
          if (!ok) throw new Error("Cancelled");
          await clearLocalData();
          await initLocal({ seed: false });
        } else {
          const ok = await confirmDialog({
            title: "Start your sheet with the sample catalogue?",
            message: "Your sheet is empty. Add the 52 sample grocery products so you can try billing straight away? Sample invoices on this PC are cleared either way.",
            confirmText: "Add sample products",
          });
          if (!ok) throw new Error("Cancelled");
          for (const p of sampleProducts()) await adapter.saveProduct({ product: p });
          await clearLocalData();
          await initLocal({ seed: false });
        }
      } else {
        if (pending > 0) {
          const upload = await confirmDialog({
            title: `Upload ${pending} local change${pending > 1 ? "s" : ""}?`,
            message: "You have changes made on this PC that aren't in the sheet yet. Upload them now, or discard them and use only what's in the sheet?",
            confirmText: "Upload my changes",
          });
          if (!upload) await clearQueue();
        }
        // An empty sheet should end up with the full catalogue, not just the items already sold.
        if (!hasServerData) {
          const localOnly = state.all.filter((p) => p.id === null && !p.localOnly).length;
          if (localOnly > 0) {
            const uploadAll = await confirmDialog({
              title: `Upload your ${localOnly} products?`,
              message: "Your sheet has no products yet. Upload the catalogue from this PC so the sheet is a complete copy?",
              confirmText: "Upload catalogue",
            });
            if (uploadAll) await enqueueAllProductsForSync();
          }
        }
      }

      saveConfig({ mode: SHEETS, url, key });
      await noteConnection(info);
      await loadAll();
      const r = await syncNow({ reason: "connect" });
      window.dispatchEvent(new CustomEvent("settings:changed"));
      const uploaded = r && r.pushed ? ` · uploaded ${r.pushed} change${r.pushed === 1 ? "" : "s"}` : "";
      toast(`Connected to “${info.spreadsheetName}”${uploaded}`);
      mount(el);
    } catch (err) {
      saveConfig(previous);
      if (err.message !== "Cancelled") toast(err.message, "error");
      busy(btn, false);
    }
  };

  const stopBtn = $("#dsLocal", el);
  if (stopBtn) {
    stopBtn.onclick = async () => {
      const ok = await confirmDialog({
        title: "Stop syncing with Google Sheets?",
        message: "The app will keep all current data on this PC and work offline. Nothing is deleted from your sheet. Queued changes stay here until you reconnect.",
        confirmText: "Stop syncing",
      });
      if (!ok) return;
      saveConfig({ mode: LOCAL_ONLY });
      await loadAll();
      window.dispatchEvent(new CustomEvent("settings:changed"));
      toast("Now using local data only");
      mount(el);
    };
  }

  $("#pwaReset", el).onclick = async () => {
    const ok = await confirmDialog({
      title: "Reset local data?",
      message: "Products, invoices and stock changes stored on this PC will be replaced with fresh sample data. Anything not yet uploaded to Google Sheets will be lost.",
      confirmText: "Reset",
      danger: true,
    });
    if (!ok) return;
    await clearLocalData();
    await initLocal();
    await loadAll();
    window.dispatchEvent(new CustomEvent("settings:changed"));
    toast("Local data reset");
    mount(el);
  };

  const installBtn = $("#pwaInstall", el);
  if (installBtn) installBtn.onclick = promptInstall;

  $("#dsCopy", el).onclick = async () => {
    try {
      toast((await copyText(await fetchCode())) ? "Code.gs copied — paste it into Apps Script" : "Couldn't copy — use Download instead", "success");
    } catch (err) {
      toast(err.message, "error");
    }
  };
  $("#dsDownload", el).onclick = async () => {
    try {
      downloadFile("Code.gs", await fetchCode(), "text/plain");
    } catch (err) {
      toast(err.message, "error");
    }
  };
}
