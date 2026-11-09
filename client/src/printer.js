// Ticket thermique 80 mm : dessiné en image par le navigateur (le texte arabe est donc correctement
// formé et orienté, quelle que soit l'imprimante), puis envoyé au serveur qui le transmet en ESC/POS.
import { api } from './api.js';
import { pname } from './i18n.js';
import { money, qtyFmt, dateTime } from './format.js';
import { bars, encode, humanReadable } from './barcode.js';

const W = 576; // 80 mm à 203 dpi (zone imprimable ≈ 72 mm)
const PAD = 12;
const FONT = '"Noto Sans Arabic","Segoe UI",Tahoma,Arial,sans-serif';

export function renderReceipt(sale, { lang, t, shop, footer }) {
  const rtl = lang === 'ar';
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = 6000;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, canvas.height);
  ctx.fillStyle = '#000'; ctx.textBaseline = 'top'; ctx.direction = rtl ? 'rtl' : 'ltr';
  let y = 8;
  const font = (size, bold) => { ctx.font = `${bold ? '700 ' : '400 '}${size}px ${FONT}`; };

  const center = (text, size = 24, bold = false) => {
    font(size, bold); ctx.textAlign = 'center'; ctx.fillText(text, W / 2, y); y += Math.round(size * 1.35);
  };
  const wrap = (text, size, bold) => {
    font(size, bold);
    const lines = []; let cur = '';
    for (const w of String(text).split(/\s+/)) {
      const test = cur ? `${cur} ${w}` : w;
      if (ctx.measureText(test).width > W - 2 * PAD && cur) { lines.push(cur); cur = w; } else cur = test;
    }
    if (cur) lines.push(cur);
    return lines;
  };
  const start = (text, size = 24, bold = false) => {
    for (const l of wrap(text, size, bold)) {
      font(size, bold); ctx.textAlign = rtl ? 'right' : 'left';
      ctx.fillText(l, rtl ? W - PAD : PAD, y); y += Math.round(size * 1.35);
    }
  };
  const row = (a, b, size = 24, bold = false) => {
    font(size, bold);
    ctx.textAlign = rtl ? 'right' : 'left'; ctx.fillText(a, rtl ? W - PAD : PAD, y);
    ctx.textAlign = rtl ? 'left' : 'right'; ctx.fillText(b, rtl ? PAD : W - PAD, y);
    y += Math.round(size * 1.35);
  };
  const rule = () => {
    ctx.fillStyle = '#000';
    for (let x = PAD; x < W - PAD; x += 12) ctx.fillRect(x, y + 6, 6, 2);
    y += 16;
  };

  center(shop || t.appName, 34, true);
  center(`${sale.id ? `${t.receipt} #${sale.id}` : t.offline}  ${dateTime(sale.created_at)}`, 22);
  center(`${t.seller}: ${sale.employee_name}`, 22);
  if (sale.status === 'voided') center(`*** ${t.voided} ***`, 28, true);
  rule();
  for (const it of sale.items ?? []) {
    start(pname(it, lang), 24, true);
    row(`${qtyFmt(it.qty)} × ${qtyFmt(it.unit_price)}`, qtyFmt(it.line_total), 24);
    y += 4;
  }
  rule();
  if (sale.discount > 0) { row(t.subtotal, money(sale.subtotal)); row(t.discount, `- ${money(sale.discount)}`); }
  row(t.total, money(sale.total), 32, true);
  row(t.payment, sale.payment_method === 'cash' ? t.cash : t.mobile);
  if (sale.payment_method === 'cash' && sale.cash_given != null) {
    row(t.cashGiven, money(sale.cash_given)); row(t.change, money(sale.cash_given - sale.total));
  }
  if (footer) { y += 10; for (const l of wrap(footer, 22, false)) center(l, 22); }
  y += 8;

  const height = Math.min(Math.ceil(y), 6000);
  return { canvas, height };
}

/** Image -> bits (1 = noir), 8 points par octet, puis base64. */
export function toBitmap(canvas, height) {
  const { data } = canvas.getContext('2d').getImageData(0, 0, W, height);
  const bpr = W / 8;
  const out = new Uint8Array(bpr * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (lum < 150) out[y * bpr + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  let bin = '';
  for (let i = 0; i < out.length; i += 0x8000) bin += String.fromCharCode(...out.subarray(i, i + 0x8000));
  return { width: W, height, data: btoa(bin) };
}

export async function printReceiptBitmap(sale, opts) {
  const { canvas, height } = renderReceipt(sale, opts);
  return api('/print', { method: 'POST', body: toBitmap(canvas, height) });
}

export const sampleSale = (user) => ({
  id: 'TEST', employee_name: user.name, status: 'completed', created_at: new Date().toISOString(),
  subtotal: 3100, discount: 100, total: 3000, payment_method: 'cash', cash_given: 5000,
  items: [
    { name_fr: 'Riz 1kg', name_ar: 'أرز 1 كغ', qty: 2, unit_price: 800, line_total: 1600 },
    { name_fr: 'Lait en poudre (boîte 400 g)', name_ar: 'حليب مجفف (علبة 400 غ)', qty: 1, unit_price: 1500, line_total: 1500 },
  ],
});

/** Étiquette pour l'imprimante de tickets (80 mm) : nom, prix, code-barres. Imprimée seule, puis coupée. */
export function renderLabel(product, { lang, showPrice = true, showAr = true }) {
  const rtl = lang === 'ar';
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = 700;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, canvas.height);
  ctx.fillStyle = '#000'; ctx.textBaseline = 'top'; ctx.textAlign = 'center';
  let y = 14;
  const wrap = (text, size, bold) => {
    ctx.font = `${bold ? '700 ' : '400 '}${size}px ${FONT}`;
    const lines = []; let cur = '';
    for (const w of String(text).split(/s+/)) {
      const test = cur ? `${cur} ${w}` : w;
      if (ctx.measureText(test).width > W - 2 * PAD && cur) { lines.push(cur); cur = w; } else cur = test;
    }
    if (cur) lines.push(cur);
    return lines.slice(0, 2);
  };
  const line = (text, size, bold, dir) => {
    ctx.direction = dir;
    for (const l of wrap(text, size, bold)) { ctx.font = `${bold ? '700 ' : '400 '}${size}px ${FONT}`; ctx.fillText(l, W / 2, y); y += Math.round(size * 1.3); }
  };
  const primary = (rtl && product.name_ar) || product.name_fr;
  line(primary, 32, true, rtl && product.name_ar ? 'rtl' : 'ltr');
  if (showAr && product.name_ar && !rtl) line(product.name_ar, 30, false, 'rtl');
  if (showPrice) { y += 4; ctx.direction = 'ltr'; line(money(product.price), 46, true, 'ltr'); }
  y += 8;

  const enc = encode(product.barcode);
  if (enc) {
    const module = Math.max(2, Math.min(4, Math.floor((W - 2 * 40) / enc.bits.length)));
    const x0 = Math.round((W - enc.bits.length * module) / 2);
    for (const b of bars(enc.bits)) ctx.fillRect(x0 + b.x * module, y, b.w * module, 110);
    y += 116;
    ctx.direction = 'ltr'; ctx.font = `600 26px Consolas, "Courier New", monospace`;
    for (const t of humanReadable(enc)) { ctx.textAlign = t.anchor === 'start' ? 'left' : 'center'; ctx.fillText(t.s, x0 + t.x * module, y); }
    y += 36;
  }
  return { canvas, height: Math.min(Math.ceil(y + 10), 700) };
}

export async function printLabelBitmap(product, opts) {
  const { canvas, height } = renderLabel(product, opts);
  return api('/print', { method: 'POST', body: toBitmap(canvas, height) });
}
