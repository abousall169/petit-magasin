// Ventes : enregistrement, annulation, retours.
import { db, tx, getSetting } from './db.js';
import { fail, broadcast, round3, text, localDate, localStamp } from './util.js';
import { addMovement, changeStock, consumeLots, restoreLots } from './stock.js';
import { customerBalance } from './customers.js';
import { sendToPrinter, DRAWER_PULSE } from './print/print.js';

export const PAY_METHODS = ['cash', 'wave', 'orange_money', 'mobile', 'credit'];
const MAX_OFFLINE_AGE = 60 * 86400_000;

export function getSale(id, duplicate = false) {
  const sale = db.prepare(
    `SELECT s.*, e.name AS employee_name, c.name AS customer_name, c.phone AS customer_phone, c.address AS customer_address
     FROM sales s JOIN employees e ON e.id = s.employee_id
     LEFT JOIN customers c ON c.id = s.customer_id WHERE s.id = ?`).get(id);
  if (!sale) throw fail(404, 'not_found');
  sale.items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(id);
  sale.payments = db.prepare('SELECT method, amount, reference FROM sale_payments WHERE sale_id = ? ORDER BY id').all(id);
  sale.refunds = db.prepare(
    `SELECT r.*, e.name AS employee_name FROM refunds r JOIN employees e ON e.id = r.employee_id
     WHERE r.sale_id = ? ORDER BY r.id`).all(id);
  sale.refunded_total = sale.refunds.reduce((a, r) => a + r.amount, 0);
  if (duplicate) sale.duplicate = true;
  return sale;
}

/** Date de la vente faite hors ligne. null si l'horloge de l'appareil est manifestement fausse. */
function offlineDate(value) {
  const d = new Date(value);
  const ms = d.getTime();
  if (!value || Number.isNaN(ms)) return null;
  const now = Date.now();
  return ms > now + 5 * 60_000 || ms < now - MAX_OFFLINE_AGE ? null : localStamp(d);
}

function readPayments(b, total) {
  const raw = Array.isArray(b.payments) && b.payments.length ? b.payments : [{ method: b.paymentMethod, amount: total }];
  const list = raw.map((p) => ({ method: p.method, amount: Math.round(Number(p.amount)), reference: text(p.reference, 60) }));
  for (const p of list) {
    if (!PAY_METHODS.includes(p.method) || !Number.isFinite(p.amount) || p.amount < 0) throw fail(400, 'invalid_payment');
  }
  const kept = list.filter((p) => p.amount > 0);
  const payments = kept.length ? kept : [list[0]];
  if (payments.reduce((a, p) => a + p.amount, 0) !== total) throw fail(400, 'payment_mismatch');
  return payments;
}

function recordSale(b, user) {
  const { clientId = null, items } = b;
  const offline = !!b.offline;
  if (!Array.isArray(items) || !items.length) throw fail(400, 'empty_cart');

  const isManager = user.role === 'manager';
  const allowNeg = getSetting('allow_negative_stock', '0') === '1';
  const taxOn = getSetting('tax_enabled', '0') === '1';
  const defaultRate = Number(getSetting('tax_rate', '18')) || 0;
  const maxDiscount = isManager ? 100 : Number(getSetting('seller_max_discount', '100'));
  const canPrice = isManager || getSetting('seller_can_change_price', '0') === '1';
  const canCredit = isManager || getSetting('seller_can_credit', '1') === '1';

  return tx(() => {
    // Idempotence : une vente envoyée deux fois (file d'attente hors-ligne) n'est enregistrée qu'une fois.
    if (clientId) {
      const dup = db.prepare('SELECT id FROM sales WHERE client_id = ?').get(clientId);
      if (dup) return { id: dup.id, duplicate: true };
    }

    // Une vente faite hors ligne a déjà eu lieu : elle n'est jamais refusée, le gérant est prévenu.
    const review = new Set();
    const need = new Map();
    const lines = [];
    let subtotal = 0;
    let catalog = 0;
    for (const it of items) {
      const qty = Number(it.qty);
      const p = db.prepare(`SELECT * FROM products WHERE id = ? ${offline ? '' : 'AND active = 1'}`).get(it.productId);
      if (!p) throw fail(404, 'product_not_found', { productId: it.productId });
      if (!(qty > 0)) throw fail(400, 'invalid_qty', { productId: p.id });
      if (p.unit === 'piece' && !Number.isInteger(qty)) throw fail(400, 'invalid_qty', { productId: p.id });

      const wanted = round3((need.get(p.id) ?? 0) + qty);
      need.set(p.id, wanted);
      if (!allowNeg && p.stock < wanted) {
        if (!offline) throw fail(409, 'insufficient_stock', { productId: p.id, available: p.stock });
        review.add('stock');
      }

      let unit = p.price;
      if (it.unitPrice != null && Math.round(Number(it.unitPrice)) !== p.price) {
        unit = Math.round(Number(it.unitPrice));
        if (!(unit >= 0)) throw fail(400, 'invalid_price', { productId: p.id });
        if (!canPrice) {
          if (!offline) throw fail(403, 'price_forbidden', { productId: p.id });
          review.add('price');
        }
      }

      const gross = Math.round(qty * unit);
      const lineDiscount = Math.round(Number(it.discount) || 0);
      if (lineDiscount < 0 || lineDiscount > gross) throw fail(400, 'invalid_discount', { productId: p.id });
      const line_total = gross - lineDiscount;
      subtotal += line_total;
      catalog += Math.round(qty * p.price);
      lines.push({ p, qty, unit, lineDiscount, line_total, rate: taxOn ? (p.tax_rate ?? defaultRate) : 0 });
    }

    const disc = Math.round(Number(b.discount) || 0);
    if (disc < 0 || disc > subtotal) throw fail(400, 'invalid_discount');
    const total = subtotal - disc;

    if ((catalog - total) * 100 > catalog * maxDiscount) {
      if (!offline) throw fail(403, 'discount_too_high', { max: maxDiscount });
      review.add('discount');
    }

    const payments = readPayments(b, total);
    const sumOf = (m) => payments.filter((p) => p.method === m).reduce((a, p) => a + p.amount, 0);
    const cashPart = sumOf('cash');
    const creditPart = sumOf('credit');
    const cashGiven = b.cashGiven != null && cashPart > 0 ? Math.round(Number(b.cashGiven)) : null;
    if (cashGiven != null && cashGiven < cashPart) throw fail(400, 'cash_insufficient');

    const customerId = b.customerId ? Number(b.customerId) : null;
    let customer = null;
    if (customerId) {
      customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
      if (!customer) throw fail(404, 'customer_not_found');
    }
    if (creditPart > 0) {
      if (!customer) throw fail(400, 'customer_required');
      if (!canCredit) {
        if (!offline) throw fail(403, 'credit_forbidden');
        review.add('credit');
      }
      if (customer.credit_limit > 0 && customerBalance(customer.id) + creditPart > customer.credit_limit) {
        if (!offline && !isManager) {
          throw fail(409, 'credit_limit', { limit: customer.credit_limit, balance: customerBalance(customer.id) });
        }
        if (offline) review.add('credit');
      }
    }

    const soldAt = offline ? offlineDate(b.soldAt) : null;
    if (offline && b.soldAt && !soldAt) review.add('date');

    // TVA comprise dans les prix ; la remise globale est répartie sur les lignes.
    const netRatio = subtotal > 0 ? total / subtotal : 0;
    let taxTotal = 0;
    for (const l of lines) {
      const net = l.line_total * netRatio;
      l.tax = l.rate > 0 ? Math.round(net - net / (1 + l.rate / 100)) : 0;
      taxTotal += l.tax;
    }

    const methods = new Set(payments.map((p) => p.method));
    const { lastInsertRowid } = db.prepare(
      `INSERT INTO sales(client_id, employee_id, customer_id, subtotal, discount, total, tax_total, payment_method,
                         cash_given, offline, needs_review, created_at, synced_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,COALESCE(?, datetime('now','localtime')),?)`).run(
      clientId, user.id, customerId, subtotal, disc, total, taxTotal,
      methods.size > 1 ? 'mixed' : payments[0].method, cashGiven, offline ? 1 : 0,
      review.size ? [...review].join(',') : null, soldAt, offline ? localStamp() : null);
    const saleId = Number(lastInsertRowid);

    const insPay = db.prepare('INSERT INTO sale_payments(sale_id, method, amount, reference) VALUES(?,?,?,?)');
    for (const p of payments) insPay.run(saleId, p.method, p.amount, p.reference);

    const insItem = db.prepare(
      `INSERT INTO sale_items(sale_id, product_id, name_fr, name_ar, qty, unit_price, line_total,
                              unit_cost, list_price, line_discount, tax_rate, tax_amount, lots)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const l of lines) {
      const lots = consumeLots(l.p.id, l.qty);
      insItem.run(saleId, l.p.id, l.p.name_fr, l.p.name_ar, l.qty, l.unit, l.line_total,
        l.p.cost, l.p.price, l.lineDiscount, l.rate, l.tax, JSON.stringify(lots));
      changeStock(l.p.id, -l.qty);
      addMovement(l.p.id, -l.qty, 'sale', `sale:${saleId}`, user.id);
    }

    if (creditPart > 0) {
      db.prepare(`INSERT INTO customer_ledger(customer_id, kind, amount, sale_id, employee_id) VALUES(?, 'sale', ?, ?, ?)`)
        .run(customerId, creditPart, saleId, user.id);
    }

    return { id: saleId, changed: lines.map((l) => l.p.id), cashPart, customerId };
  });
}

function pulseDrawer() {
  const target = getSetting('printer', '');
  if (target && getSetting('cash_drawer', '0') === '1') sendToPrinter(target, DRAWER_PULSE).catch(() => {});
}

export function saleRoutes(api) {
  api.post('/api/sales', async (req) => {
    const body = req.body ?? {};
    const result = recordSale(body, req.user);
    if (result.changed) broadcast('stock', { productIds: result.changed });
    if (result.customerId) broadcast('customers');
    if (result.cashPart > 0 && !body.offline) pulseDrawer();
    return getSale(result.id, result.duplicate);
  });

  api.get('/api/sales', async (req) => {
    const isManager = req.user.role === 'manager';
    const columns = `s.*, e.name AS employee_name, c.name AS customer_name,
      (SELECT COALESCE(SUM(r.amount), 0) FROM refunds r WHERE r.sale_id = s.id) AS refunded_total`;
    const from = `FROM sales s JOIN employees e ON e.id = s.employee_id LEFT JOIN customers c ON c.id = s.customer_id`;
    if (req.query.review === '1' && isManager) {
      return db.prepare(`SELECT ${columns} ${from} WHERE s.needs_review IS NOT NULL ORDER BY s.id DESC`).all();
    }
    const date = req.query.date || localDate();
    const mine = isManager ? '' : 'AND s.employee_id = @uid';
    return db.prepare(`SELECT ${columns} ${from} WHERE date(s.created_at) = @date ${mine} ORDER BY s.id DESC`)
      .all({ date, ...(mine ? { uid: req.user.id } : {}) });
  });

  api.get('/api/sales/:id', async (req) => {
    const s = getSale(Number(req.params.id));
    if (req.user.role !== 'manager' && s.employee_id !== req.user.id) throw fail(403, 'forbidden');
    return s;
  });
}

export function saleManagerRoutes(mgr) {
  mgr.post('/api/sales/:id/void', async (req) => {
    const id = Number(req.params.id);
    const reason = text(req.body?.reason);
    if (!reason) throw fail(400, 'reason_required');
    const changed = tx(() => {
      const s = db.prepare('SELECT * FROM sales WHERE id = ?').get(id);
      if (!s) throw fail(404, 'not_found');
      if (s.status === 'voided') throw fail(409, 'already_voided');
      db.prepare("UPDATE sales SET status = 'voided', voided_by = ?, void_reason = ?, needs_review = NULL WHERE id = ?")
        .run(req.user.id, reason, id);
      const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(id);
      for (const it of items) {
        const back = round3(it.qty - it.returned_qty); // les articles déjà retournés ont été traités
        if (back <= 0) continue;
        changeStock(it.product_id, back);
        restoreLots(it, back);
        addMovement(it.product_id, back, 'void', `sale:${id}`, req.user.id);
      }
      if (s.customer_id) {
        const net = db.prepare('SELECT COALESCE(SUM(amount), 0) n FROM customer_ledger WHERE sale_id = ?').get(id).n;
        if (net !== 0) {
          db.prepare(`INSERT INTO customer_ledger(customer_id, kind, amount, sale_id, employee_id, note) VALUES(?, 'void', ?, ?, ?, ?)`)
            .run(s.customer_id, -net, id, req.user.id, reason);
        }
      }
      return items.map((i) => i.product_id);
    });
    broadcast('stock', { productIds: changed });
    broadcast('customers');
    return getSale(id);
  });

  // Retour d'une partie des articles d'une vente
  mgr.post('/api/sales/:id/refund', async (req) => {
    const id = Number(req.params.id);
    const b = req.body ?? {};
    const reason = text(b.reason);
    if (!reason) throw fail(400, 'reason_required');
    if (!Array.isArray(b.items) || !b.items.length) throw fail(400, 'empty_cart');
    const method = b.method;
    if (!PAY_METHODS.includes(method)) throw fail(400, 'invalid_payment');
    const restock = b.restock !== false;

    const changed = tx(() => {
      const s = db.prepare('SELECT * FROM sales WHERE id = ?').get(id);
      if (!s) throw fail(404, 'not_found');
      if (s.status === 'voided') throw fail(409, 'already_voided');
      if (method === 'credit' && !s.customer_id) throw fail(400, 'customer_required');

      const netRatio = s.subtotal > 0 ? s.total / s.subtotal : 0;
      const rows = [];
      let amount = 0;
      for (const r of b.items) {
        const it = db.prepare('SELECT * FROM sale_items WHERE id = ? AND sale_id = ?').get(r.saleItemId, id);
        if (!it) throw fail(404, 'not_found');
        const qty = Number(r.qty);
        const left = round3(it.qty - it.returned_qty);
        if (!(qty > 0) || qty > left) throw fail(400, 'invalid_qty', { saleItemId: it.id, available: left });
        const product = db.prepare('SELECT unit FROM products WHERE id = ?').get(it.product_id);
        if (product?.unit === 'piece' && !Number.isInteger(qty)) throw fail(400, 'invalid_qty', { saleItemId: it.id });

        // Dernier retour de la ligne : on rend exactement ce qui reste, sans écart d'arrondi.
        const done = db.prepare(
          `SELECT COALESCE(SUM(ri.amount), 0) a, COALESCE(SUM(ri.tax_amount), 0) t
           FROM refund_items ri WHERE ri.sale_item_id = ?`).get(it.id);
        const lineNet = Math.round(it.line_total * netRatio);
        const all = qty === left;
        const lineAmount = all ? lineNet - done.a : Math.round((lineNet * qty) / it.qty);
        const lineTax = all ? it.tax_amount - done.t : Math.round((it.tax_amount * qty) / it.qty);
        amount += lineAmount;
        rows.push({ it, qty, lineAmount, lineTax });
      }

      const { lastInsertRowid } = db.prepare(
        'INSERT INTO refunds(sale_id, employee_id, amount, method, restock, reason) VALUES(?,?,?,?,?,?)')
        .run(id, req.user.id, amount, method, restock ? 1 : 0, reason);
      const insRow = db.prepare('INSERT INTO refund_items(refund_id, sale_item_id, qty, amount, tax_amount) VALUES(?,?,?,?,?)');
      for (const { it, qty, lineAmount, lineTax } of rows) {
        insRow.run(lastInsertRowid, it.id, qty, lineAmount, lineTax);
        db.prepare('UPDATE sale_items SET returned_qty = ROUND(returned_qty + ?, 3) WHERE id = ?').run(qty, it.id);
        if (restock) {
          changeStock(it.product_id, qty);
          restoreLots(it, qty);
          addMovement(it.product_id, qty, 'refund', `sale:${id}`, req.user.id);
        }
      }
      if (method === 'credit' && amount > 0) {
        db.prepare(`INSERT INTO customer_ledger(customer_id, kind, amount, sale_id, employee_id, note) VALUES(?, 'refund', ?, ?, ?, ?)`)
          .run(s.customer_id, -amount, id, req.user.id, reason);
      }
      return rows.map((r) => r.it.product_id);
    });
    if (restock) broadcast('stock', { productIds: changed });
    if (method === 'credit') broadcast('customers');
    return getSale(id);
  });

  mgr.post('/api/sales/:id/reviewed', async (req) => {
    const id = Number(req.params.id);
    db.prepare('UPDATE sales SET needs_review = NULL WHERE id = ?').run(id);
    return getSale(id);
  });
}
