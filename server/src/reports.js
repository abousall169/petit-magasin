// Rapports sur une période et exports CSV (ouvrables dans Excel).
import { db } from './db.js';
import { fail, isDate, localDate } from './util.js';

const DONE = "date(s.created_at) BETWEEN @from AND @to AND s.status = 'completed'";
const REFUND = "date(r.created_at) BETWEEN @from AND @to AND s.status = 'completed'";

function period(q) {
  const from = isDate(q.from) ? q.from : localDate();
  const to = isDate(q.to) ? q.to : from;
  if (from > to) throw fail(400, 'invalid_input');
  return { from, to };
}

export function buildReport(from, to) {
  const P = { from, to };
  const sales = db.prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM(s.total), 0) AS total, COALESCE(SUM(s.discount), 0) AS discounts,
            COALESCE(SUM(s.tax_total), 0) AS tax
     FROM sales s WHERE ${DONE}`).get(P);
  const lines = db.prepare(
    `SELECT COALESCE(SUM(ROUND(i.qty * i.unit_cost)), 0) AS cost, COALESCE(SUM(i.line_discount), 0) AS lineDiscounts,
            COUNT(DISTINCT CASE WHEN i.unit_cost = 0 THEN i.product_id END) AS missingCost
     FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE ${DONE}`).get(P);
  const refunds = db.prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM(r.amount), 0) AS total FROM refunds r JOIN sales s ON s.id = r.sale_id WHERE ${REFUND}`).get(P);
  const refundLines = db.prepare(
    `SELECT COALESCE(SUM(ri.tax_amount), 0) AS tax,
            COALESCE(SUM(CASE WHEN r.restock = 1 THEN ROUND(ri.qty * i.unit_cost) ELSE 0 END), 0) AS cost
     FROM refund_items ri JOIN refunds r ON r.id = ri.refund_id JOIN sale_items i ON i.id = ri.sale_item_id
     JOIN sales s ON s.id = r.sale_id WHERE ${REFUND}`).get(P);
  const expenses = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE expense_date BETWEEN @from AND @to`).get(P).total;

  const revenue = sales.total - refunds.total;
  const tax = sales.tax - refundLines.tax;
  const cost = lines.cost - refundLines.cost;
  const margin = revenue - tax - cost;

  const byPayment = db.prepare(
    `SELECT p.method AS payment_method, COUNT(*) AS count, SUM(p.amount) AS total
     FROM sale_payments p JOIN sales s ON s.id = p.sale_id WHERE ${DONE} GROUP BY p.method ORDER BY total DESC`).all(P);
  const byEmployee = db.prepare(
    `SELECT e.name, COUNT(*) AS count, SUM(s.total) AS total FROM sales s JOIN employees e ON e.id = s.employee_id
     WHERE ${DONE} GROUP BY e.id ORDER BY total DESC`).all(P);
  const voided = db.prepare(
    `SELECT COUNT(*) c, COALESCE(SUM(s.total), 0) t FROM sales s
     WHERE date(s.created_at) BETWEEN @from AND @to AND s.status = 'voided'`).get(P);
  const top = db.prepare(
    `SELECT i.name_fr, i.name_ar, SUM(i.qty) AS qty, ROUND(SUM(1.0 * i.line_total * s.total / MAX(s.subtotal, 1))) AS total,
            ROUND(SUM(1.0 * i.line_total * s.total / MAX(s.subtotal, 1) - i.tax_amount - i.qty * i.unit_cost)) AS margin
     FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE ${DONE}
     GROUP BY i.product_id ORDER BY total DESC LIMIT 10`).all(P);
  const expensesByCategory = db.prepare(
    `SELECT category, SUM(amount) AS total FROM expenses WHERE expense_date BETWEEN @from AND @to GROUP BY category ORDER BY total DESC`).all(P);
  const creditGiven = byPayment.find((p) => p.payment_method === 'credit')?.total ?? 0;
  const creditPaid = db.prepare(
    `SELECT COALESCE(-SUM(amount), 0) AS v FROM customer_ledger WHERE kind = 'payment' AND date(created_at) BETWEEN @from AND @to`).get(P).v;

  // Détail : par jour, ou par mois au-delà de deux mois.
  const days = (new Date(to) - new Date(from)) / 86400_000;
  const fmt = days > 62 ? '%Y-%m' : '%Y-%m-%d';
  const rows = new Map();
  const row = (k) => {
    if (!rows.has(k)) rows.set(k, { period: k, count: 0, total: 0, tax: 0, cost: 0, refunds: 0, expenses: 0 });
    return rows.get(k);
  };
  for (const x of db.prepare(
    `SELECT strftime('${fmt}', s.created_at) AS k, COUNT(*) c, SUM(s.total) t, SUM(s.tax_total) tx FROM sales s WHERE ${DONE} GROUP BY k`).all(P)) {
    Object.assign(row(x.k), { count: x.c, total: x.t, tax: x.tx });
  }
  for (const x of db.prepare(
    `SELECT strftime('${fmt}', s.created_at) AS k, SUM(ROUND(i.qty * i.unit_cost)) c
     FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE ${DONE} GROUP BY k`).all(P)) {
    row(x.k).cost = x.c;
  }
  for (const x of db.prepare(
    `SELECT strftime('${fmt}', r.created_at) AS k, SUM(ri.amount) a, SUM(ri.tax_amount) tx,
            SUM(CASE WHEN r.restock = 1 THEN ROUND(ri.qty * i.unit_cost) ELSE 0 END) c
     FROM refund_items ri JOIN refunds r ON r.id = ri.refund_id JOIN sale_items i ON i.id = ri.sale_item_id
     JOIN sales s ON s.id = r.sale_id WHERE ${REFUND} GROUP BY k`).all(P)) {
    const o = row(x.k);
    o.refunds = x.a; o.tax -= x.tx; o.cost -= x.c;
  }
  for (const x of db.prepare(
    `SELECT strftime('${fmt}', expense_date) AS k, SUM(amount) a FROM expenses WHERE expense_date BETWEEN @from AND @to GROUP BY k`).all(P)) {
    row(x.k).expenses = x.a;
  }
  const series = [...rows.values()].sort((a, b) => a.period.localeCompare(b.period))
    .map((x) => {
      const net = x.total - x.refunds;
      return { ...x, revenue: net, margin: net - x.tax - x.cost, net: net - x.tax - x.cost - x.expenses };
    });

  const lowStock = db.prepare(
    'SELECT id, name_fr, name_ar, unit, stock, min_stock FROM products WHERE active = 1 AND stock <= min_stock ORDER BY stock').all();
  const expiring = db.prepare(
    `SELECT p.id, p.name_fr, p.name_ar, l.code, l.expiry_date, l.qty AS stock FROM stock_lots l JOIN products p ON p.id = l.product_id
     WHERE p.active = 1 AND l.qty > 0 AND l.expiry_date IS NOT NULL AND l.expiry_date <> ''
       AND l.expiry_date <= date('now','localtime','+7 day')
     UNION ALL
     SELECT p.id, p.name_fr, p.name_ar, '' AS code, p.expiry_date, p.stock FROM products p
     WHERE p.active = 1 AND p.stock > 0 AND p.expiry_date IS NOT NULL AND p.expiry_date <> ''
       AND p.expiry_date <= date('now','localtime','+7 day')
       AND NOT EXISTS (SELECT 1 FROM stock_lots l WHERE l.product_id = p.id AND l.qty > 0)
     ORDER BY expiry_date`).all();
  const toReview = db.prepare('SELECT COUNT(*) c FROM sales WHERE needs_review IS NOT NULL').get().c;
  const debts = db.prepare('SELECT COALESCE(SUM(amount), 0) v FROM customer_ledger').get().v;
  const payables = db.prepare(
    `SELECT COALESCE(SUM(x.total), 0) - COALESCE((SELECT SUM(pp.amount) FROM purchase_payments pp JOIN purchases y ON y.id = pp.purchase_id
       WHERE y.status = 'received'), 0) AS v FROM purchases x WHERE x.status = 'received'`).get().v;

  return {
    from, to, count: sales.count, gross: sales.total, total: revenue, discounts: sales.discounts + lines.lineDiscounts, tax, cost, margin,
    expenses, net: margin - expenses, missingCost: lines.missingCost, refunds, byPayment, byEmployee, voided, top,
    expensesByCategory, creditGiven, creditPaid, series, grouped: days > 62 ? 'month' : 'day',
    lowStock, expiring, toReview, debts, payables,
  };
}

// ---- CSV : séparateur « ; » et BOM UTF-8, comme l'attend Excel en français ----
function csvCell(v) {
  if (v == null) return '';
  if (typeof v === 'number') return String(v).replace('.', ',');
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // Excel exécuterait sinon le contenu comme une formule
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const csv = (header, rows) =>
  `\uFEFF${[header, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n')}\r\n`;

const sendCsv = (reply, name, body) =>
  reply.type('text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="${name}"`).send(body);

export function reportRoutes(mgr) {
  mgr.get('/api/reports', async (req) => {
    const { from, to } = period(req.query);
    return buildReport(from, to);
  });

  mgr.get('/api/reports/day', async (req) => {
    const date = isDate(req.query.date) ? req.query.date : localDate();
    return { date, ...buildReport(date, date) };
  });

  mgr.get('/api/export/products.csv', async (req, reply) => {
    const rows = db.prepare(
      `SELECT p.*, c.name_fr AS category FROM products p LEFT JOIN categories c ON c.id = p.category_id ORDER BY p.name_fr`).all();
    return sendCsv(reply, 'produits.csv', csv(
      ['code_barres', 'nom_fr', 'nom_ar', 'categorie', 'unite', 'prix', 'cout', 'stock', 'seuil', 'peremption', 'actif'],
      rows.map((p) => [p.barcode, p.name_fr, p.name_ar, p.category, p.unit, p.price, p.cost, p.stock, p.min_stock, p.expiry_date, p.active])));
  });

  mgr.get('/api/export/sales.csv', async (req, reply) => {
    const { from, to } = period(req.query);
    const rows = db.prepare(
      `SELECT s.id, s.created_at, s.status, s.payment_method, e.name AS employee, c.name AS customer,
              i.name_fr, i.qty, i.unit_price, i.line_discount, i.line_total, i.returned_qty, s.discount, s.total
       FROM sale_items i JOIN sales s ON s.id = i.sale_id JOIN employees e ON e.id = s.employee_id
       LEFT JOIN customers c ON c.id = s.customer_id
       WHERE date(s.created_at) BETWEEN @from AND @to ORDER BY s.id, i.id`).all({ from, to });
    return sendCsv(reply, `ventes-${from}-${to}.csv`, csv(
      ['ticket', 'date', 'etat', 'paiement', 'vendeur', 'client', 'produit', 'quantite', 'prix', 'remise_ligne', 'total_ligne', 'retourne', 'remise_ticket', 'total_ticket'],
      rows.map((r) => [r.id, r.created_at, r.status, r.payment_method, r.employee, r.customer, r.name_fr, r.qty, r.unit_price, r.line_discount, r.line_total, r.returned_qty, r.discount, r.total])));
  });

  mgr.get('/api/export/report.csv', async (req, reply) => {
    const { from, to } = period(req.query);
    const r = buildReport(from, to);
    return sendCsv(reply, `rapport-${from}-${to}.csv`, csv(
      ['periode', 'ventes', 'chiffre_affaires', 'retours', 'tva', 'cout_achat', 'marge', 'depenses', 'benefice'],
      [...r.series.map((x) => [x.period, x.count, x.total, x.refunds, x.tax, x.cost, x.margin, x.expenses, x.net]),
        ['TOTAL', r.count, r.gross, r.refunds.total, r.tax, r.cost, r.margin, r.expenses, r.net]]));
  });

  mgr.get('/api/export/customers.csv', async (req, reply) => {
    const rows = db.prepare(
      `SELECT c.*, COALESCE((SELECT SUM(l.amount) FROM customer_ledger l WHERE l.customer_id = c.id), 0) AS balance
       FROM customers c ORDER BY c.name`).all();
    return sendCsv(reply, 'clients.csv', csv(['nom', 'telephone', 'adresse', 'plafond', 'solde_du'],
      rows.map((c) => [c.name, c.phone, c.address, c.credit_limit, c.balance])));
  });

  mgr.get('/api/export/expenses.csv', async (req, reply) => {
    const { from, to } = period(req.query);
    const rows = db.prepare('SELECT * FROM expenses WHERE expense_date BETWEEN @from AND @to ORDER BY expense_date, id').all({ from, to });
    return sendCsv(reply, `depenses-${from}-${to}.csv`, csv(['date', 'categorie', 'montant', 'paiement', 'note'],
      rows.map((x) => [x.expense_date, x.category, x.amount, x.method, x.note])));
  });
}
