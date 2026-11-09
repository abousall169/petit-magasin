// Dépenses, ouverture et clôture de caisse.
import { db, tx } from './db.js';
import { fail, isDate, localDate, localStamp, text, toInt } from './util.js';

const EXPENSE_METHODS = ['cash', 'wave', 'orange_money', 'mobile', 'bank'];

/** Détail des espèces attendues dans le tiroir entre l'ouverture et l'instant « until ». */
function cashBreakdown(session, until) {
  const P = { from: session.opened_at, until };
  const one = (sql) => db.prepare(sql).get(P).v;
  const sales = one(
    `SELECT COALESCE(SUM(p.amount), 0) v FROM sale_payments p JOIN sales s ON s.id = p.sale_id
     WHERE p.method = 'cash' AND s.status = 'completed' AND s.created_at BETWEEN @from AND @until`);
  const repayments = one(
    `SELECT COALESCE(-SUM(amount), 0) v FROM customer_ledger
     WHERE kind = 'payment' AND method = 'cash' AND created_at BETWEEN @from AND @until`);
  const refunds = one(
    `SELECT COALESCE(SUM(r.amount), 0) v FROM refunds r JOIN sales s ON s.id = r.sale_id
     WHERE r.method = 'cash' AND s.status = 'completed' AND r.created_at BETWEEN @from AND @until`);
  const expenses = one(
    `SELECT COALESCE(SUM(amount), 0) v FROM expenses WHERE method = 'cash' AND created_at BETWEEN @from AND @until`);
  const suppliers = one(
    `SELECT COALESCE(SUM(amount), 0) v FROM purchase_payments WHERE method = 'cash' AND created_at BETWEEN @from AND @until`);
  const expected = session.opening_float + sales + repayments - refunds - expenses - suppliers;
  return { opening_float: session.opening_float, sales, repayments, refunds, expenses, suppliers, expected };
}

const openSession = () => db.prepare("SELECT * FROM cash_sessions WHERE status = 'open' ORDER BY id DESC LIMIT 1").get();

export function cashRoutes(mgr) {
  mgr.get('/api/expenses', async (req) => {
    const from = isDate(req.query.from) ? req.query.from : localDate();
    const to = isDate(req.query.to) ? req.query.to : from;
    return db.prepare(
      `SELECT x.*, e.name AS employee_name FROM expenses x LEFT JOIN employees e ON e.id = x.employee_id
       WHERE x.expense_date BETWEEN @from AND @to ORDER BY x.expense_date DESC, x.id DESC`).all({ from, to });
  });

  mgr.post('/api/expenses', async (req) => {
    const b = req.body ?? {};
    const amount = toInt(b.amount);
    if (!(amount > 0)) throw fail(400, 'invalid_amount');
    const method = b.method ?? 'cash';
    if (!EXPENSE_METHODS.includes(method)) throw fail(400, 'invalid_payment');
    const date = isDate(b.expense_date) ? b.expense_date : localDate();
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO expenses(category, amount, method, note, expense_date, employee_id) VALUES(?,?,?,?,?,?)')
      .run(text(b.category, 80), amount, method, text(b.note, 300), date, req.user.id);
    return db.prepare('SELECT * FROM expenses WHERE id = ?').get(lastInsertRowid);
  });

  mgr.delete('/api/expenses/:id', async (req) => {
    db.prepare('DELETE FROM expenses WHERE id = ?').run(Number(req.params.id));
    return { ok: true };
  });

  mgr.get('/api/cash', async () => {
    const session = openSession();
    return {
      session: session ?? null,
      breakdown: session ? cashBreakdown(session, localStamp()) : null,
      history: db.prepare(
        `SELECT c.*, a.name AS opened_by_name, b.name AS closed_by_name FROM cash_sessions c
         LEFT JOIN employees a ON a.id = c.opened_by LEFT JOIN employees b ON b.id = c.closed_by
         WHERE c.status = 'closed' ORDER BY c.id DESC LIMIT 30`).all(),
    };
  });

  mgr.post('/api/cash/open', async (req) => {
    const float = toInt(req.body?.opening_float);
    if (float < 0) throw fail(400, 'invalid_amount');
    tx(() => {
      if (openSession()) throw fail(409, 'cash_already_open');
      db.prepare('INSERT INTO cash_sessions(opening_float, opened_by, opened_at) VALUES(?,?,?)').run(float, req.user.id, localStamp());
    });
    return { ok: true };
  });

  mgr.post('/api/cash/close', async (req) => {
    const b = req.body ?? {};
    const counted = Number(b.counted);
    if (!Number.isFinite(counted) || counted < 0) throw fail(400, 'invalid_amount');
    return tx(() => {
      const session = openSession();
      if (!session) throw fail(409, 'cash_not_open');
      const now = localStamp();
      const breakdown = cashBreakdown(session, now);
      const roundedCount = Math.round(counted);
      const difference = roundedCount - breakdown.expected;
      db.prepare(`UPDATE cash_sessions SET status = 'closed', closed_by = ?, closed_at = ?, expected = ?, counted = ?, difference = ?, note = ?
                  WHERE id = ?`).run(req.user.id, now, breakdown.expected, roundedCount, difference, text(b.note, 300), session.id);
      return { ...breakdown, counted: roundedCount, difference };
    });
  });
}
