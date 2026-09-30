// Builds the demo catalogue + sales history as LOCAL records (used on first run).
import { sampleProducts } from "./data/sample.js";
import { calcTotals, invoiceNumber, round2, uid } from "./data/logic.js";

const rand = (n) => Math.floor(Math.random() * n);

/** Local records: { localId, id: null (no server yet), ...fields, _s: 1 } */
export function demoData() {
  const now = Date.now();
  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);

  const products = sampleProducts().map((p) => ({
    ...p,
    localId: uid(),
    id: null,
    _s: 1,
    createdAt: new Date(now - 30 * 86400000).toISOString(),
    updatedAt: new Date(now - 30 * 86400000).toISOString(),
  }));

  const sales = [];
  for (let d = 13; d >= 0; d--) {
    const orders = d === 0 ? 11 : 14 + rand(14);
    for (let i = 0; i < orders; i++) {
      let ts;
      if (d === 0) {
        const span = Math.max(now - startToday.getTime() - 120000, 120000);
        ts = now - Math.random() * span;
      } else {
        ts = startToday.getTime() - d * 86400000 + (8 + Math.random() * 12) * 3600000;
      }
      const picked = new Set();
      const lineCount = 1 + rand(6);
      while (picked.size < lineCount) picked.add(rand(products.length));
      const chosen = [...picked].map((idx) => {
        const p = products[idx];
        const weighed = p.unit === "kg" || p.unit === "l";
        return { p, qty: weighed ? Math.round((0.3 + Math.random() * 2) * 4) / 4 : 1 + (Math.random() < 0.3 ? rand(3) : 0) };
      });
      const disc = Math.random() < 0.1;
      const calc = calcTotals(
        chosen.map(({ p, qty }) => ({ price: p.price, qty, taxRate: p.taxRate })),
        { type: disc ? "percent" : "none", value: disc ? 10 : 0 },
      );
      const r = Math.random();
      const method = r < 0.4 ? "cash" : r < 0.8 ? "card" : "upi";
      const paid = method === "cash" ? Math.ceil(calc.total / 5) * 5 : calc.total;
      const created = new Date(ts);
      sales.push({
        localId: uid(),
        id: null,
        invoiceNo: invoiceNumber(sales.length + 1, created),
        createdAt: created.toISOString(),
        customerName: Math.random() < 0.25 ? "Walk-in customer" : null,
        customerPhone: null,
        subtotal: calc.subtotal,
        discount: calc.discount,
        tax: calc.tax,
        total: calc.total,
        paymentMethod: method,
        amountPaid: paid,
        changeDue: round2(paid - calc.total),
        status: "completed",
        note: null,
        voidedAt: null,
        _s: 1,
        items: chosen.map(({ p, qty }, k) => ({
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
          lineSubtotal: calc.lines[k].lineSubtotal,
          lineTax: calc.lines[k].lineTax,
        })),
      });
    }
  }
  return { products, sales };
}
