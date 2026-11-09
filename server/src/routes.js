import { db, tx, getSetting, setSetting } from './db.js';
import { listPrinters, escposFromBitmap, validateBitmap, sendToPrinter } from './print/print.js';
import {
  hashPin, verifyPin, createSession, requireAuth, requireManager,
  checkRateLimit, recordAttempt,
} from './auth.js';

// Modèle de vision utilisé côté navigateur (DINOv2-small quantifié) : 384 (CLS) + 384 (moyenne des patchs) dimensions.
export const VISION_MODEL = 'dinov2-small-q8';
const VISION_DIM = 768;

// Code-barres interne : EAN-13 « usage magasin » (préfixe 20, réservé par GS1 aux codes internes) + n° du produit.
// Même calcul que client/src/barcode.js (internalEan13).
const internalEan13 = (id) => {
  const body = `20${String(id).padStart(10, '0')}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3);
  return body + ((10 - (sum % 10)) % 10);
};

const fail = (status, error, extra = {}) =>
  Object.assign(new Error(error), { status, extra });

const validPin = (p) => /^\d{4,6}$/.test(String(p ?? ''));

// ---- Temps réel (Server-Sent Events) : le stock se met à jour sur tous les appareils ----
const sseClients = new Set();
function broadcast(event, data = {}) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(msg);
}

export default async function routes(app) {
  app.setErrorHandler((err, req, reply) => {
    if (err.status) return reply.code(err.status).send({ error: err.message, ...err.extra });
    if (err.validation) return reply.code(400).send({ error: 'invalid_input', detail: err.message });
    req.log.error(err);
    reply.code(500).send({ error: 'server_error' });
  });

  // ---------------- Public ----------------
  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/employees/public', async () =>
    db.prepare('SELECT id, name FROM employees WHERE active=1 ORDER BY name').all());

  app.post('/api/login', async (req) => {
    const { employeeId, pin } = req.body ?? {};
    const emp = db.prepare('SELECT * FROM employees WHERE id=? AND active=1').get(employeeId);
    if (!emp) throw fail(401, 'bad_credentials');
    if (!checkRateLimit(emp.id)) throw fail(429, 'too_many_attempts');
    const ok = verifyPin(pin, emp.pin_hash, emp.pin_salt);
    recordAttempt(emp.id, ok);
    if (!ok) throw fail(401, 'bad_credentials');
    return {
      token: createSession(emp.id),
      user: { id: emp.id, name: emp.name, role: emp.role, lang: emp.lang },
    };
  });

  // ---------------- Authentifié ----------------
  await app.register(async (api) => {
    api.addHook('onRequest', async (req, reply) => {
      // EventSource ne peut pas envoyer d'en-tête : token accepté en query pour /api/events
      if (req.url.startsWith('/api/events') && req.query?.token) {
        req.headers.authorization = `Bearer ${req.query.token}`;
      }
      return requireAuth(req, reply);
    });

    api.get('/api/events', (req, reply) => {
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('retry: 3000\n\n');
      sseClients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.raw.on('close', () => { clearInterval(ping); sseClients.delete(res); });
    });

    api.get('/api/me', async (req) => req.user);

    api.post('/api/logout', async (req) => {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      db.prepare('DELETE FROM sessions WHERE token=?').run(token);
      return { ok: true };
    });

    api.put('/api/me/lang', async (req) => {
      const lang = req.body?.lang;
      if (!['fr', 'ar'].includes(lang)) throw fail(400, 'invalid_input');
      db.prepare('UPDATE employees SET lang=? WHERE id=?').run(lang, req.user.id);
      return { ok: true };
    });

    api.post('/api/me/pin', async (req) => {
      const { oldPin, newPin } = req.body ?? {};
      const emp = db.prepare('SELECT * FROM employees WHERE id=?').get(req.user.id);
      if (!verifyPin(oldPin, emp.pin_hash, emp.pin_salt)) throw fail(401, 'bad_credentials');
      if (!validPin(newPin)) throw fail(400, 'invalid_pin');
      const { hash, salt } = hashPin(newPin);
      db.prepare('UPDATE employees SET pin_hash=?, pin_salt=? WHERE id=?').run(hash, salt, req.user.id);
      return { ok: true };
    });

    // ---- Paramètres ----
    api.get('/api/settings', async () => ({
      shop_name: getSetting('shop_name'),
      ticket_footer: getSetting('ticket_footer'),
      allow_negative_stock: getSetting('allow_negative_stock', '0') === '1',
      printer: getSetting('printer', ''),
      auto_print: getSetting('auto_print', '0') === '1',
      printer_cut: getSetting('printer_cut', '1') === '1',
      currency: 'FCFA',
    }));

    // ---- Impression thermique 80 mm : le navigateur dessine le ticket (FR/AR), le serveur l'envoie en ESC/POS ----
    api.post('/api/print', async (req) => {
      const target = getSetting('printer', '');
      if (!target) throw fail(400, 'no_printer');
      const bmp = validateBitmap(req.body);
      if (!bmp) throw fail(400, 'invalid_image');
      try {
        await sendToPrinter(target, escposFromBitmap(bmp, { cut: getSetting('printer_cut', '1') === '1' }));
      } catch (e) {
        throw fail(502, 'print_failed', { detail: e.message });
      }
      return { ok: true };
    });

    // ---- Catégories ----
    api.get('/api/categories', async () => db.prepare('SELECT * FROM categories ORDER BY id').all());

    // ---- Produits ----
    api.get('/api/products', async (req) => {
      const all = req.query.all === '1' && req.user.role === 'manager';
      return db.prepare(
        `SELECT p.*, (SELECT COUNT(*) FROM product_images i WHERE i.product_id = p.id) AS image_count
         FROM products p ${all ? '' : 'WHERE p.active=1'} ORDER BY p.name_fr`).all();
    });

    // ---- Reconnaissance par photo : empreintes de toutes les photos de référence (comparées sur l'appareil) ----
    api.get('/api/embeddings', async (req, reply) => {
      const st = db.prepare(
        `SELECT COUNT(*) AS n, COALESCE(MAX(i.id),0) AS maxId, COALESCE(SUM(p.active),0) AS act
         FROM product_images i JOIN products p ON p.id = i.product_id`).get();
      const etag = `"${VISION_MODEL}-${st.n}-${st.maxId}-${st.act}"`;
      reply.header('ETag', etag).header('Cache-Control', 'no-cache');
      if (req.headers['if-none-match'] === etag) return reply.code(304).send();
      const rows = db.prepare(
        `SELECT i.id, i.product_id, i.embedding FROM product_images i
         JOIN products p ON p.id = i.product_id WHERE p.active = 1 AND i.model = ?`).all(VISION_MODEL);
      return {
        model: VISION_MODEL, dim: VISION_DIM,
        items: rows.map((x) => ({ id: x.id, productId: x.product_id, v: Buffer.from(x.embedding).toString('base64') })),
      };
    });

    // ---- Vente ----
    api.post('/api/sales', async (req) => {
      const { clientId, items, paymentMethod, discount = 0, cashGiven = null } = req.body ?? {};
      if (!Array.isArray(items) || !items.length) throw fail(400, 'empty_cart');
      if (!['cash', 'mobile'].includes(paymentMethod)) throw fail(400, 'invalid_payment');

      const allowNeg = getSetting('allow_negative_stock', '0') === '1';
      const result = tx(() => {
        // Idempotence : une vente envoyée deux fois (file d'attente hors-ligne) n'est enregistrée qu'une fois.
        if (clientId) {
          const dup = db.prepare('SELECT id FROM sales WHERE client_id=?').get(clientId);
          if (dup) return { id: dup.id, duplicate: true };
        }
        const lines = [];
        let subtotal = 0;
        for (const it of items) {
          const qty = Number(it.qty);
          const p = db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(it.productId);
          if (!p) throw fail(404, 'product_not_found', { productId: it.productId });
          if (!(qty > 0)) throw fail(400, 'invalid_qty', { productId: p.id });
          if (p.unit === 'piece' && !Number.isInteger(qty)) throw fail(400, 'invalid_qty', { productId: p.id });
          if (!allowNeg && p.stock < qty) {
            throw fail(409, 'insufficient_stock', { productId: p.id, available: p.stock });
          }
          const line_total = Math.round(qty * p.price);
          subtotal += line_total;
          lines.push({ p, qty, line_total });
        }
        const disc = Math.round(Number(discount) || 0);
        if (disc < 0 || disc > subtotal) throw fail(400, 'invalid_discount');
        const total = subtotal - disc;
        if (paymentMethod === 'cash' && cashGiven != null && Number(cashGiven) < total) {
          throw fail(400, 'cash_insufficient');
        }

        const { lastInsertRowid: saleId } = db.prepare(
          `INSERT INTO sales(client_id, employee_id, subtotal, discount, total, payment_method, cash_given)
           VALUES(?,?,?,?,?,?,?)`).run(clientId ?? null, req.user.id, subtotal, disc, total, paymentMethod,
          paymentMethod === 'cash' && cashGiven != null ? Math.round(Number(cashGiven)) : null);

        const insItem = db.prepare(
          `INSERT INTO sale_items(sale_id, product_id, name_fr, name_ar, qty, unit_price, line_total)
           VALUES(?,?,?,?,?,?,?)`);
        const updStock = db.prepare('UPDATE products SET stock = stock - ? WHERE id=?');
        const insMove = db.prepare(
          'INSERT INTO stock_movements(product_id, delta, reason, ref, employee_id) VALUES(?,?,?,?,?)');
        for (const l of lines) {
          insItem.run(saleId, l.p.id, l.p.name_fr, l.p.name_ar, l.qty, l.p.price, l.line_total);
          updStock.run(l.qty, l.p.id);
          insMove.run(l.p.id, -l.qty, 'sale', `sale:${saleId}`, req.user.id);
        }
        return { id: Number(saleId), changed: lines.map((l) => l.p.id) };
      });

      if (result.changed) broadcast('stock', { productIds: result.changed });
      return getSale(result.id, result.duplicate);
    });

    api.get('/api/sales', async (req) => {
      const date = req.query.date || new Date().toLocaleDateString('sv-SE');
      const mine = req.user.role === 'manager' ? '' : 'AND s.employee_id = @uid';
      return db.prepare(
        `SELECT s.*, e.name AS employee_name FROM sales s
         JOIN employees e ON e.id = s.employee_id
         WHERE date(s.created_at) = @date ${mine}
         ORDER BY s.id DESC`).all({ date, ...(mine ? { uid: req.user.id } : {}) });
    });

    api.get('/api/sales/:id', async (req) => {
      const s = getSale(Number(req.params.id));
      if (req.user.role !== 'manager' && s.employee_id !== req.user.id) throw fail(403, 'forbidden');
      return s;
    });

    // ---------------- Gérant uniquement ----------------
    await api.register(async (mgr) => {
      mgr.addHook('onRequest', requireManager);

      mgr.post('/api/sales/:id/void', async (req) => {
        const id = Number(req.params.id);
        const reason = String(req.body?.reason ?? '').trim();
        if (!reason) throw fail(400, 'reason_required');
        const changed = tx(() => {
          const s = db.prepare('SELECT * FROM sales WHERE id=?').get(id);
          if (!s) throw fail(404, 'not_found');
          if (s.status === 'voided') throw fail(409, 'already_voided');
          db.prepare("UPDATE sales SET status='voided', voided_by=?, void_reason=? WHERE id=?")
            .run(req.user.id, reason, id);
          const items = db.prepare('SELECT * FROM sale_items WHERE sale_id=?').all(id);
          for (const it of items) {
            db.prepare('UPDATE products SET stock = stock + ? WHERE id=?').run(it.qty, it.product_id);
            db.prepare('INSERT INTO stock_movements(product_id, delta, reason, ref, employee_id) VALUES(?,?,?,?,?)')
              .run(it.product_id, it.qty, 'void', `sale:${id}`, req.user.id);
          }
          return items.map((i) => i.product_id);
        });
        broadcast('stock', { productIds: changed });
        return getSale(id);
      });

      // Produits
      const productFields = (b) => {
        const name_fr = String(b.name_fr ?? '').trim();
        if (!name_fr) throw fail(400, 'name_required');
        const price = Math.round(Number(b.price));
        if (!(price >= 0)) throw fail(400, 'invalid_price');
        const unit = b.unit ?? 'piece';
        if (!['piece', 'kg', 'litre'].includes(unit)) throw fail(400, 'invalid_unit');
        return {
          name_fr, name_ar: String(b.name_ar ?? '').trim(),
          barcode: String(b.barcode ?? '').trim() || null,
          category_id: b.category_id || null, unit, price,
          cost: Math.round(Number(b.cost) || 0),
          min_stock: Number(b.min_stock) || 0,
          expiry_date: b.expiry_date || null,
          active: b.active === false || b.active === 0 ? 0 : 1,
        };
      };
      const uniqueBarcode = (fn) => {
        try { return fn(); } catch (e) {
          if (String(e.message).includes('UNIQUE')) throw fail(409, 'barcode_exists');
          throw e;
        }
      };

      mgr.post('/api/products', async (req) => {
        const f = productFields(req.body ?? {});
        const initial = Number(req.body?.stock) || 0;
        const id = uniqueBarcode(() => tx(() => {
          const { lastInsertRowid } = db.prepare(
            `INSERT INTO products(name_fr,name_ar,barcode,category_id,unit,price,cost,stock,min_stock,expiry_date,active)
             VALUES(@name_fr,@name_ar,@barcode,@category_id,@unit,@price,@cost,@stock,@min_stock,@expiry_date,@active)`)
            .run({ ...f, stock: initial });
          if (initial) {
            db.prepare('INSERT INTO stock_movements(product_id,delta,reason,employee_id) VALUES(?,?,?,?)')
              .run(lastInsertRowid, initial, 'initial', req.user.id);
          }
          return Number(lastInsertRowid);
        }));
        broadcast('stock', { productIds: [id] });
        return db.prepare('SELECT * FROM products WHERE id=?').get(id);
      });

      mgr.put('/api/products/:id', async (req) => {
        const id = Number(req.params.id);
        const f = productFields(req.body ?? {});
        uniqueBarcode(() => db.prepare(
          `UPDATE products SET name_fr=@name_fr,name_ar=@name_ar,barcode=@barcode,category_id=@category_id,
           unit=@unit,price=@price,cost=@cost,min_stock=@min_stock,expiry_date=@expiry_date,active=@active
           WHERE id=@id`).run({ ...f, id }));
        broadcast('stock', { productIds: [id] });
        return db.prepare('SELECT * FROM products WHERE id=?').get(id);
      });

      // Réapprovisionnement / correction d'inventaire
      mgr.post('/api/products/:id/stock', async (req) => {
        const id = Number(req.params.id);
        const delta = Number(req.body?.delta);
        const reason = ['restock', 'adjustment', 'loss'].includes(req.body?.reason) ? req.body.reason : 'adjustment';
        if (!Number.isFinite(delta) || delta === 0) throw fail(400, 'invalid_qty');
        tx(() => {
          if (!db.prepare('SELECT 1 FROM products WHERE id=?').get(id)) throw fail(404, 'not_found');
          db.prepare('UPDATE products SET stock = stock + ? WHERE id=?').run(delta, id);
          db.prepare('INSERT INTO stock_movements(product_id,delta,reason,employee_id) VALUES(?,?,?,?)')
            .run(id, delta, reason, req.user.id);
        });
        broadcast('stock', { productIds: [id] });
        return db.prepare('SELECT * FROM products WHERE id=?').get(id);
      });

      // Codes-barres internes (pour les produits qui n'en ont pas)
      mgr.post('/api/products/assign-barcodes', async () => {
        const ids = tx(() => {
          const rows = db.prepare("SELECT id FROM products WHERE active=1 AND (barcode IS NULL OR barcode='')").all();
          const upd = db.prepare('UPDATE products SET barcode=? WHERE id=?');
          for (const { id } of rows) upd.run(internalEan13(id), id);
          return rows.map((x) => x.id);
        });
        if (ids.length) broadcast('stock', { productIds: ids });
        return { assigned: ids.length };
      });

      mgr.post('/api/products/:id/barcode', async (req) => {
        const id = Number(req.params.id);
        const p = db.prepare('SELECT * FROM products WHERE id=?').get(id);
        if (!p) throw fail(404, 'not_found');
        if (!p.barcode) {
          try { db.prepare('UPDATE products SET barcode=? WHERE id=?').run(internalEan13(id), id); }
          catch (e) { if (String(e.message).includes('UNIQUE')) throw fail(409, 'barcode_exists'); throw e; }
          broadcast('stock', { productIds: [id] });
        }
        return db.prepare('SELECT * FROM products WHERE id=?').get(id);
      });

      // Photos de référence d'un produit
      mgr.get('/api/products/:id/images', async (req) =>
        db.prepare('SELECT id, thumb FROM product_images WHERE product_id=? ORDER BY id').all(Number(req.params.id)));

      mgr.post('/api/products/:id/images', async (req) => {
        const id = Number(req.params.id);
        const { embedding, thumb } = req.body ?? {};
        const emb = Buffer.from(String(embedding ?? ''), 'base64');
        if (emb.length !== VISION_DIM * 4) throw fail(400, 'invalid_embedding');
        if (typeof thumb !== 'string' || !thumb.startsWith('data:image/jpeg;base64,') || thumb.length > 40000) throw fail(400, 'invalid_image');
        if (!db.prepare('SELECT 1 FROM products WHERE id=?').get(id)) throw fail(404, 'not_found');
        const n = db.prepare('SELECT COUNT(*) c FROM product_images WHERE product_id=?').get(id).c;
        if (n >= 12) throw fail(409, 'too_many_images');
        const { lastInsertRowid } = db.prepare(
          'INSERT INTO product_images(product_id, model, embedding, thumb) VALUES(?,?,?,?)').run(id, VISION_MODEL, emb, thumb);
        return { id: Number(lastInsertRowid) };
      });

      mgr.delete('/api/product-images/:id', async (req) => {
        db.prepare('DELETE FROM product_images WHERE id=?').run(Number(req.params.id));
        return { ok: true };
      });

      // Employés
      mgr.get('/api/employees', async () =>
        db.prepare('SELECT id,name,role,lang,active FROM employees ORDER BY name').all());

      mgr.post('/api/employees', async (req) => {
        const { name, role = 'seller', pin } = req.body ?? {};
        if (!String(name ?? '').trim()) throw fail(400, 'name_required');
        if (!['manager', 'seller'].includes(role)) throw fail(400, 'invalid_input');
        if (!validPin(pin)) throw fail(400, 'invalid_pin');
        const { hash, salt } = hashPin(pin);
        const { lastInsertRowid } = db.prepare(
          'INSERT INTO employees(name,role,pin_hash,pin_salt) VALUES(?,?,?,?)').run(name.trim(), role, hash, salt);
        return { id: Number(lastInsertRowid) };
      });

      mgr.put('/api/employees/:id', async (req) => {
        const id = Number(req.params.id);
        const { name, role, active, pin } = req.body ?? {};
        const emp = db.prepare('SELECT * FROM employees WHERE id=?').get(id);
        if (!emp) throw fail(404, 'not_found');
        const next = {
          name: name?.trim() || emp.name,
          role: role ?? emp.role,
          active: active === undefined ? emp.active : (active ? 1 : 0),
        };
        if (!['manager', 'seller'].includes(next.role)) throw fail(400, 'invalid_input');
        const losesManager = emp.role === 'manager' && emp.active && (next.role !== 'manager' || !next.active);
        if (losesManager && db.prepare("SELECT COUNT(*) c FROM employees WHERE role='manager' AND active=1").get().c <= 1) {
          throw fail(409, 'last_manager');
        }
        db.prepare('UPDATE employees SET name=?, role=?, active=? WHERE id=?').run(next.name, next.role, next.active, id);
        if (pin !== undefined && pin !== '') {
          if (!validPin(pin)) throw fail(400, 'invalid_pin');
          const { hash, salt } = hashPin(pin);
          db.prepare('UPDATE employees SET pin_hash=?, pin_salt=? WHERE id=?').run(hash, salt, id);
        }
        if (!next.active) db.prepare('DELETE FROM sessions WHERE employee_id=?').run(id);
        return { ok: true };
      });

      mgr.put('/api/settings', async (req) => {
        const b = req.body ?? {};
        if (b.shop_name !== undefined) setSetting('shop_name', String(b.shop_name).trim() || 'Mon Magasin');
        if (b.ticket_footer !== undefined) setSetting('ticket_footer', String(b.ticket_footer));
        if (b.allow_negative_stock !== undefined) setSetting('allow_negative_stock', b.allow_negative_stock ? '1' : '0');
        if (b.printer !== undefined) {
          const p = String(b.printer);
          const testFile = process.env.PRINT_TO_FILE_DIR && p === 'file:test';
          if (p && !testFile && !/^(usb:.+|tcp:[\w.\-]+(:\d{1,5})?)$/.test(p)) throw fail(400, 'invalid_input');
          setSetting('printer', p);
        }
        if (b.auto_print !== undefined) setSetting('auto_print', b.auto_print ? '1' : '0');
        if (b.printer_cut !== undefined) setSetting('printer_cut', b.printer_cut ? '1' : '0');
        return { ok: true };
      });

      mgr.get('/api/printers', async () => {
        try { return { printers: await listPrinters() }; } catch (e) { return { printers: [], error: e.message }; }
      });

      // Clôture / rapport du jour
      mgr.get('/api/reports/day', async (req) => {
        const date = req.query.date || new Date().toLocaleDateString('sv-SE');
        const done = "date(created_at)=? AND status='completed'";
        const totals = db.prepare(
          `SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total, COALESCE(SUM(discount),0) AS discounts
           FROM sales WHERE ${done}`).get(date);
        const byPayment = db.prepare(
          `SELECT payment_method, COUNT(*) AS count, SUM(total) AS total FROM sales WHERE ${done} GROUP BY payment_method`).all(date);
        const byEmployee = db.prepare(
          `SELECT e.name, COUNT(*) AS count, SUM(s.total) AS total FROM sales s
           JOIN employees e ON e.id=s.employee_id
           WHERE date(s.created_at)=? AND s.status='completed' GROUP BY e.id ORDER BY total DESC`).all(date);
        const voided = db.prepare(
          "SELECT COUNT(*) c, COALESCE(SUM(total),0) t FROM sales WHERE date(created_at)=? AND status='voided'").get(date);
        const top = db.prepare(
          `SELECT i.name_fr, i.name_ar, SUM(i.qty) AS qty, SUM(i.line_total) AS total FROM sale_items i
           JOIN sales s ON s.id=i.sale_id
           WHERE date(s.created_at)=? AND s.status='completed'
           GROUP BY i.product_id ORDER BY total DESC LIMIT 5`).all(date);
        const lowStock = db.prepare(
          'SELECT id,name_fr,name_ar,unit,stock,min_stock FROM products WHERE active=1 AND stock <= min_stock ORDER BY stock').all();
        const expiring = db.prepare(
          `SELECT id,name_fr,name_ar,expiry_date,stock FROM products
           WHERE active=1 AND expiry_date IS NOT NULL AND expiry_date <= date('now','localtime','+7 day')
           ORDER BY expiry_date`).all();
        return { date, ...totals, byPayment, byEmployee, voided, top, lowStock, expiring };
      });
    });
  });
}

function getSale(id, duplicate = false) {
  const sale = db.prepare(
    `SELECT s.*, e.name AS employee_name FROM sales s JOIN employees e ON e.id=s.employee_id WHERE s.id=?`).get(id);
  if (!sale) throw fail(404, 'not_found');
  sale.items = db.prepare('SELECT * FROM sale_items WHERE sale_id=?').all(id);
  if (duplicate) sale.duplicate = true;
  return sale;
}
