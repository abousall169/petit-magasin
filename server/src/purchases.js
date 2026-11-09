// Fournisseurs, commandes et factures d'achat.
import { db, tx } from './db.js';
import { fail, broadcast, isDate, localStamp, text, toInt } from './util.js';
import { addLot, addMovement, changeStock } from './stock.js';

const OUT_METHODS = ['cash', 'wave', 'orange_money', 'mobile', 'bank'];
const PAID = 'COALESCE((SELECT SUM(pp.amount) FROM purchase_payments pp WHERE pp.purchase_id = x.id), 0)';

function purchaseDetail(id) {
  const p = db.prepare(
    `SELECT x.*, ${PAID} AS paid, s.name AS supplier_name, e.name AS employee_name
     FROM purchases x LEFT JOIN suppliers s ON s.id = x.supplier_id LEFT JOIN employees e ON e.id = x.employee_id
     WHERE x.id = ?`).get(id);
  if (!p) throw fail(404, 'not_found');
  p.items = db.prepare(
    `SELECT i.*, pr.name_fr, pr.name_ar, pr.unit FROM purchase_items i JOIN products pr ON pr.id = i.product_id
     WHERE i.purchase_id = ? ORDER BY i.id`).all(id);
  p.payments = db.prepare('SELECT * FROM purchase_payments WHERE purchase_id = ? ORDER BY id').all(id);
  return p;
}

/** Entrée en stock : quantités, lots et prix d'achat moyen. */
function receive(id, user) {
  const purchase = db.prepare('SELECT * FROM purchases WHERE id = ?').get(id);
  if (!purchase) throw fail(404, 'not_found');
  if (purchase.status !== 'ordered') throw fail(409, 'purchase_closed');
  const items = db.prepare('SELECT * FROM purchase_items WHERE purchase_id = ?').all(id);
  for (const it of items) {
    const p = db.prepare('SELECT stock, cost FROM products WHERE id = ?').get(it.product_id);
    const onHand = Math.max(p.stock, 0);
    if (it.unit_cost > 0) {
      const cost = onHand > 0 && p.cost > 0
        ? Math.round((onHand * p.cost + it.qty * it.unit_cost) / (onHand + it.qty))
        : it.unit_cost;
      db.prepare('UPDATE products SET cost = ? WHERE id = ?').run(cost, it.product_id);
    }
    changeStock(it.product_id, it.qty);
    if (it.expiry_date || it.lot_code) {
      addLot(it.product_id, { qty: it.qty, expiry: it.expiry_date, code: it.lot_code, source: `purchase:${id}` });
    }
    addMovement(it.product_id, it.qty, 'purchase', `purchase:${id}`, user.id);
  }
  db.prepare("UPDATE purchases SET status = 'received', received_at = ? WHERE id = ?").run(localStamp(), id);
  return items.map((i) => i.product_id);
}

function addPayment(id, amount, method, user) {
  if (!OUT_METHODS.includes(method)) throw fail(400, 'invalid_payment');
  const p = db.prepare(`SELECT x.*, ${PAID} AS paid FROM purchases x WHERE x.id = ?`).get(id);
  if (!p) throw fail(404, 'not_found');
  if (p.status === 'cancelled') throw fail(409, 'purchase_closed');
  if (!(amount > 0)) throw fail(400, 'invalid_amount');
  if (amount > p.total - p.paid) throw fail(400, 'amount_too_high', { balance: p.total - p.paid });
  db.prepare('INSERT INTO purchase_payments(purchase_id, amount, method, employee_id) VALUES(?,?,?,?)')
    .run(id, amount, method, user.id);
}

const supplierFields = (b) => {
  const name = text(b.name, 120);
  if (!name) throw fail(400, 'name_required');
  return { name, phone: text(b.phone, 40), address: text(b.address, 200), note: text(b.note, 300) };
};

export function purchaseRoutes(mgr) {
  mgr.get('/api/suppliers', async () => db.prepare(
    `SELECT s.*,
       COALESCE((SELECT SUM(x.total) FROM purchases x WHERE x.supplier_id = s.id AND x.status = 'received'), 0)
       - COALESCE((SELECT SUM(pp.amount) FROM purchase_payments pp JOIN purchases x ON x.id = pp.purchase_id
                   WHERE x.supplier_id = s.id AND x.status = 'received'), 0) AS balance
     FROM suppliers s ORDER BY s.active DESC, s.name`).all());

  mgr.post('/api/suppliers', async (req) => {
    const f = supplierFields(req.body ?? {});
    const { lastInsertRowid } = db.prepare('INSERT INTO suppliers(name, phone, address, note) VALUES(@name, @phone, @address, @note)').run(f);
    return db.prepare('SELECT * FROM suppliers WHERE id = ?').get(lastInsertRowid);
  });

  mgr.put('/api/suppliers/:id', async (req) => {
    const id = Number(req.params.id);
    const f = supplierFields(req.body ?? {});
    const active = req.body?.active === false || req.body?.active === 0 ? 0 : 1;
    const res = db.prepare('UPDATE suppliers SET name=@name, phone=@phone, address=@address, note=@note, active=@active WHERE id=@id')
      .run({ ...f, active, id });
    if (!res.changes) throw fail(404, 'not_found');
    return db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
  });

  mgr.get('/api/purchases', async (req) => {
    const status = ['ordered', 'received', 'cancelled'].includes(req.query.status) ? req.query.status : null;
    return db.prepare(
      `SELECT x.*, ${PAID} AS paid, s.name AS supplier_name FROM purchases x LEFT JOIN suppliers s ON s.id = x.supplier_id
       ${status ? 'WHERE x.status = @status' : ''} ORDER BY x.id DESC LIMIT 300`).all(status ? { status } : {});
  });

  mgr.get('/api/purchases/:id', async (req) => purchaseDetail(Number(req.params.id)));

  mgr.post('/api/purchases', async (req) => {
    const b = req.body ?? {};
    if (!Array.isArray(b.items) || !b.items.length) throw fail(400, 'empty_cart');
    const supplierId = b.supplier_id ? Number(b.supplier_id) : null;
    let changed = [];
    const id = tx(() => {
      if (supplierId && !db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(supplierId)) throw fail(404, 'not_found');
      const items = b.items.map((it) => {
        const qty = Number(it.qty);
        const unit_cost = toInt(it.unit_cost);
        const product = db.prepare('SELECT id, unit FROM products WHERE id = ?').get(it.product_id);
        if (!product) throw fail(404, 'product_not_found', { productId: it.product_id });
        if (!(qty > 0) || (product.unit === 'piece' && !Number.isInteger(qty))) throw fail(400, 'invalid_qty', { productId: it.product_id });
        if (unit_cost < 0) throw fail(400, 'invalid_price');
        if (it.expiry_date && !isDate(it.expiry_date)) throw fail(400, 'invalid_input');
        return { product_id: product.id, qty, unit_cost, expiry_date: it.expiry_date || null, lot_code: text(it.lot_code, 60) };
      });
      const total = items.reduce((a, it) => a + Math.round(it.qty * it.unit_cost), 0);
      const { lastInsertRowid } = db.prepare('INSERT INTO purchases(supplier_id, reference, total, note, employee_id) VALUES(?,?,?,?,?)')
        .run(supplierId, text(b.reference, 80), total, text(b.note, 300), req.user.id);
      const newId = Number(lastInsertRowid);
      const ins = db.prepare('INSERT INTO purchase_items(purchase_id, product_id, qty, unit_cost, expiry_date, lot_code) VALUES(?,?,?,?,?,?)');
      for (const it of items) ins.run(newId, it.product_id, it.qty, it.unit_cost, it.expiry_date, it.lot_code);
      if (b.receive) changed = receive(newId, req.user);
      if (toInt(b.paid) > 0) addPayment(newId, toInt(b.paid), b.method ?? 'cash', req.user);
      return newId;
    });
    if (changed.length) broadcast('stock', { productIds: changed });
    return purchaseDetail(id);
  });

  mgr.post('/api/purchases/:id/receive', async (req) => {
    const id = Number(req.params.id);
    const changed = tx(() => receive(id, req.user));
    broadcast('stock', { productIds: changed });
    return purchaseDetail(id);
  });

  mgr.post('/api/purchases/:id/payments', async (req) => {
    const id = Number(req.params.id);
    tx(() => addPayment(id, toInt(req.body?.amount), req.body?.method, req.user));
    return purchaseDetail(id);
  });

  mgr.post('/api/purchases/:id/cancel', async (req) => {
    const id = Number(req.params.id);
    const res = db.prepare("UPDATE purchases SET status = 'cancelled' WHERE id = ? AND status = 'ordered'").run(id);
    if (!res.changes) throw fail(409, 'purchase_closed');
    return purchaseDetail(id);
  });
}
