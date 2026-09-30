// Which backend (if any) the local data should be synced with.
// The app always works from the local database; a configured sheet adds sync.
import { createSheetsAdapter } from "./sheets-adapter.js";

const KEY = "pos.backend.v1";

export const LOCAL_ONLY = "local";
export const SHEETS = "sheets";

export function getConfig() {
  try {
    const cfg = { mode: LOCAL_ONLY, url: "", key: "", ...(JSON.parse(localStorage.getItem(KEY)) || {}) };
    if (cfg.mode !== SHEETS || !cfg.url) cfg.mode = LOCAL_ONLY;
    return cfg;
  } catch {
    return { mode: LOCAL_ONLY, url: "", key: "" };
  }
}

export function saveConfig(patch) {
  localStorage.setItem(KEY, JSON.stringify({ ...getConfig(), ...patch }));
}

export const isConnected = () => getConfig().mode === SHEETS;

export function getAdapter() {
  const cfg = getConfig();
  return cfg.mode === SHEETS ? createSheetsAdapter(cfg) : null;
}
