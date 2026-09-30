// Google Sheets backend: talks to the Apps Script web app in apps-script/Code.gs.
//
// The request is a "simple" CORS request (Content-Type: text/plain) so the browser never sends a
// preflight — Apps Script web apps don't answer OPTIONS. The response is JSON.
//
// Errors are tagged: `transient` means retry later (network/timeout), anything else is a real
// rejection from the script (bad input, duplicate SKU…) and should be surfaced to the user.

export function createSheetsAdapter({ url, key }) {
  async function call(action, payload = {}, { timeoutMs = 45000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action, ...(key ? { key } : {}), ...payload }),
        redirect: "follow",
        signal: ctrl.signal,
      });
    } catch (e) {
      const err = new Error(
        e && e.name === "AbortError"
          ? "Google Sheets took too long to respond."
          : "Couldn't reach Google Sheets. You appear to be offline.",
      );
      err.transient = true;
      throw err;
    } finally {
      clearTimeout(timer);
    }
    let data;
    try {
      data = JSON.parse(await res.text());
    } catch {
      const err = new Error(
        "That URL didn't return POS data. Deploy the script as a Web app with “Who has access: Anyone” and use the URL that ends in /exec.",
      );
      err.transient = false;
      throw err;
    }
    if (!data || !data.ok) {
      const err = new Error((data && data.error) || "Request failed");
      err.transient = false; // the script answered: retrying won't help
      throw err;
    }
    return data;
  }

  return {
    kind: "sheets",
    ping: () => call("ping"),
    bootstrap: (opts) => call("bootstrap", opts || {}),
    saveProduct: (arg) => call("saveProduct", arg),
    importProducts: (arg) => call("importProducts", arg, { timeoutMs: 120000 }),
    deleteProduct: (arg) => call("deleteProduct", arg),
    adjustStock: (arg) => call("adjustStock", arg),
    checkout: (arg) => call("checkout", arg),
    voidSale: (arg) => call("voidSale", arg),
    getSale: (arg) => call("getSale", arg),
    saveSettings: (arg) => call("saveSettings", arg),
  };
}
