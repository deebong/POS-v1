// PWA: service-worker registration, install prompt and update notices.
import { $, icon, openModal, toast } from "./ui.js";

let deferredPrompt = null;
let swRegistration = null;

export const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;

export function supportsInstall() {
  return (
    ("serviceWorker" in navigator && "BeforeInstallPromptEvent" in window) ||
    (deferredPrompt !== null && deferredPrompt !== undefined)
  );
}

export async function initPwa() {
  if (!("serviceWorker" in navigator)) return;
  try {
    // Relative to the page, so it works at /pos/ and at the root of a static host.
    swRegistration = await navigator.serviceWorker.register("sw.js", { scope: "./" });

    // Tell the service worker which page to focus when the app is launched from a shortcut.
    if (swRegistration.active) swRegistration.active.postMessage({ type: "CLIENT_URL", url: location.href });

    swRegistration.addEventListener("updatefound", () => {
      const nw = swRegistration.installing;
      if (!nw) return;
      nw.addEventListener("statechange", () => {
        if (nw.state === "installed" && navigator.serviceWorker.controller) {
          toast("A new version is ready — it will be used on next launch");
        }
      });
    });
  } catch (e) {
    // Not fatal: the app still runs, it just won't work offline.
    console.warn("Service worker registration failed", e);
  }

  // Ask the browser to make local data durable — important for a POS.
  try {
    if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
  } catch {
    /* ignore */
  }
}

export function watchInstall(onChange) {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    onChange(true);
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    toast("App installed — you can now use it offline");
    onChange(false);
  });
}

export async function promptInstall() {
  if (!deferredPrompt) {
    openModal({
      title: "Install on this PC",
      size: "sm",
      body: `<p style="color:var(--text-2)">
        This browser hasn't offered an install prompt yet. In <b>Chrome</b> or <b>Edge</b> click the
        <b>install / add to home screen</b> icon in the address bar, or open the browser menu and choose
        <b>Install app</b>. Once installed the POS launches like a normal Windows app and works with no connection.</p>
        <p class="muted" style="margin-top:10px">Current status: ${isStandalone() ? "already installed ✓" : "running in the browser"}</p>`,
      footer: `<button class="btn btn-primary" data-close2>Got it</button>`,
    }).$("[data-close2]").onclick = function () {
      this.closest(".modal-backdrop").remove();
    };
    return;
  }
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  if (outcome === "accepted") toast("Installing…");
  deferredPrompt = null;
}

/** How much space the local database is using. */
export async function storageInfo() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return {
    usage,
    quota,
    persisted: !!(navigator.storage && navigator.storage.persisted && (await navigator.storage.persisted())),
    mb: (n) => `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`,
  };
}

export const installIcon = () => icon("download");
