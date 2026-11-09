// Clients et crédit (carnet de dettes).
import { db, tx } from './db.js';
import { fail, broadcast, text, toInt } from './util.js';

const RECEIPT_METHODS = ['cash', 'wave', 'orange_money', 'mobile'];
const BALANCE = 'COALESCE((SELECT SUM(l.amount) FROM customer_ledger l WHERE l.customer_id = c.id), 0)';

export const customerBalance = (id) =>
  db.prepare('SELECT COALESCE(SUM(amount), 0) b FROM customer_ledger WHERE customer_id = ?').get(id).b;

const fields = (b) => {
  const name = text(b.name, 120);
  if (!name) throw fail(400, 'name_required');
  return {
    name, phone: text(b.phone, 40), address: text(b.address, 200), note: text(b.note, 300),
    credit_limit: Math.max(toInt(b.credit_limit), 0),
  };
};

function customerDetail(id) {
  const c = db.prepare(`SELECT c.*, ${BALANCE} AS balance FROM customers c WHERE c.id = ?`).get(id);
  if (!c) throw fail(404, 'not_found');
  c.ledger = db.prepare(
    `SELECT l.*, e.name AS employee_name FROM customer_ledger l LEFT JOIN employees e ON e.id = l.employee_id
     WHERE l.customer_id = ? ORDER BY l.id DESC LIMIT 300`).all(id);
  return c;
}

export function customerRoutes(api) {
  api.get('/api/customers', async () =>
    db.prepare(`SELECT c.*, ${BALANCE} AS balance FROM customers c ORDER BY c.active DESC, c.name`).all());

  api.get('/api/customers/:id', async (req) => customerDetail(Number(req.params.id)));

  api.post('/api/customers', async (req) => {
    const f = fields(req.body ?? {});
    if (req.user.role !== 'manager') f.credit_limit = 0; // le plafond est fixé par le gérant
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO customers(name, phone, address, note, credit_limit) VALUES(@name, @phone, @address, @note, @credit_limit)').run(f);
    broadcast('customers');
    return customerDetail(Number(lastInsertRowid));
  });

  // Remboursement d'une dette
  api.post('/api/customers/:id/payments', async (req) => {
    const id = Number(req.params.id);
    const b = req.body ?? {};
    const amount = toInt(b.amount);
    if (!(amount > 0)) throw fail(400, 'invalid_amount');
    if (!RECEIPT_METHODS.includes(b.method)) throw fail(400, 'invalid_payment');
    tx(() => {
      if (!db.prepare('SELECT 1 FROM customers WHERE id = ?').get(id)) throw fail(404, 'not_found');
      if (amount > customerBalance(id)) throw fail(400, 'amount_too_high', { balance: customerBalance(id) });
      db.prepare(`INSERT INTO customer_ledger(customer_id, kind, amount, method, reference, employee_id, note)
                  VALUES(?, 'payment', ?, ?, ?, ?, ?)`)
        .run(id, -amount, b.method, text(b.reference, 60), req.user.id, text(b.note, 300));
    });
    broadcast('customers');
    return customerDetail(id);
  });
}

export function customerManagerRoutes(mgr) {
  mgr.put('/api/customers/:id', async (req) => {
    const id = Number(req.params.id);
    const f = fields(req.body ?? {});
    const active = req.body?.active === false || req.body?.active === 0 ? 0 : 1;
    const res = db.prepare(
      `UPDATE customers SET name=@name, phone=@phone, address=@address, note=@note, credit_limit=@credit_limit, active=@active
       WHERE id=@id`).run({ ...f, active, id });
    if (!res.changes) throw fail(404, 'not_found');
    broadcast('customers');
    return customerDetail(id);
  });

  // Correction manuelle du solde (ex. reprise d'un ancien carnet)
  mgr.post('/api/customers/:id/adjust', async (req) => {
    const id = Number(req.params.id);
    const amount = toInt(req.body?.amount);
    if (!amount) throw fail(400, 'invalid_amount');
    if (!db.prepare('SELECT 1 FROM customers WHERE id = ?').get(id)) throw fail(404, 'not_found');
    db.prepare(`INSERT INTO customer_ledger(customer_id, kind, amount, employee_id, note) VALUES(?, 'adjust', ?, ?, ?)`)
      .run(id, amount, req.user.id, text(req.body?.note, 300));
    broadcast('customers');
    return customerDetail(id);
  });
}
