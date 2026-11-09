import { db, tx, getSetting, setSetting } from './db.js';
import { listPrinters, escposFromBitmap, validateBitmap, sendToPrinter, DRAWER_PULSE } from './print/print.js';
import {
  hashPin, verifyPin, createSession, requireAuth, requireManager,
  checkRateLimit, recordAttempt,
} from './auth.js';
import { fail, broadcast, addSseClient, isDate, text } from './util.js';
import { addLot, addMovement, changeStock, consumeLots, syncExpiry } from './stock.js';
import { saleRoutes, saleManagerRoutes } from './sales.js';
import { customerRoutes, customerManagerRoutes } from './customers.js';
import { purchaseRoutes } from './purchases.js';
import { cashRoutes } from './cash.js';
import { reportRoutes } from './reports.js';
import { backupRoutes } from './backup.js';

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

const validPin = (p) => /^\d{4,6}$/.test(String(p ?? ''));
const LANGS = ['fr', 'ar', 'en'];
const flag = (k, d = '0') => getSetting(k, d) === '1';

export default async function routes(app) {
  app.setErrorHandler((err, req, reply) => {
    if (err.status) return reply.code(err.status).send({ error: err.message, ...err.extra });
    if (err.validation) return reply.code(400).send({ error: 'invalid_input', detail: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: 'invalid_input' });
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
      const remove = addSseClient(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.raw.on('close', () => { clearInterval(ping); remove(); });
    });

    api.get('/api/me', async (req) => req.user);

    api.post('/api/logout', async (req) => {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      db.prepare('DELETE FROM sessions WHERE token=?').run(token);
      return { ok: true };
    });

    api.put('/api/me/lang', async (req) => {
      const lang = req.body?.lang;
      if (!LANGS.includes(lang)) throw fail(400, 'invalid_input');
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
      shop_address: getSetting('shop_address', ''),
      shop_phone: getSetting('shop_phone', ''),
      shop_tax_id: getSetting('shop_tax_id', ''),
      ticket_footer: getSetting('ticket_footer'),
      allow_negative_stock: flag('allow_negative_stock'),
      printer: getSetting('printer', ''),
      auto_print: flag('auto_print'),
      printer_cut: flag('printer_cut', '1'),
      paper_width: Number(getSetting('paper_width', '80')),
      cash_drawer: flag('cash_drawer'),
      tax_enabled: flag('tax_enabled'),
      tax_rate: Number(getSetting('tax_rate', '18')),
      seller_max_discount: Number(getSetting('seller_max_discount', '100')),
      seller_can_change_price: flag('seller_can_change_price'),
      seller_can_credit: flag('seller_can_credit', '1'),
      phone_prefix: getSetting('phone_prefix', '221'),
      currency: getSetting('currency', 'FCFA'),
    }));

    // ---- Impression thermique : le navigateur dessine le ticket (FR/AR), le serveur l'envoie en ESC/POS ----
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
        `SELECT p.*, (SELECT COUNT(*) FROM product_images i WHERE i.product_id = p.id) AS image_count,
                (SELECT COUNT(*) FROM stock_lots l WHERE l.product_id = p.id AND l.qty > 0) AS lot_count
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

    saleRoutes(api);
    customerRoutes(api);

    // ---------------- Gérant uniquement ----------------
    await api.register(async (mgr) => {
      mgr.addHook('onRequest', requireManager);

      saleManagerRoutes(mgr);
      customerManagerRoutes(mgr);
      purchaseRoutes(mgr);
      cashRoutes(mgr);
      reportRoutes(mgr);
      backupRoutes(mgr);

      // Catégories
      const categoryFields = (b) => {
        const name_fr = text(b.name_fr, 80);
        if (!name_fr) throw fail(400, 'name_required');
        return { name_fr, name_ar: text(b.name_ar, 80), icon: text(b.icon, 8) || '🛒' };
      };
      mgr.post('/api/categories', async (req) => {
        const f = categoryFields(req.body ?? {});
        const { lastInsertRowid } = db.prepare('INSERT INTO categories(name_fr, name_ar, icon) VALUES(@name_fr, @name_ar, @icon)').run(f);
        broadcast('settings');
        return db.prepare('SELECT * FROM categories WHERE id=?').get(lastInsertRowid);
      });
      mgr.put('/api/categories/:id', async (req) => {
        const id = Number(req.params.id);
        const res = db.prepare('UPDATE categories SET name_fr=@name_fr, name_ar=@name_ar, icon=@icon WHERE id=@id')
          .run({ ...categoryFields(req.body ?? {}), id });
        if (!res.changes) throw fail(404, 'not_found');
        broadcast('settings');
        return db.prepare('SELECT * FROM categories WHERE id=?').get(id);
      });
      mgr.delete('/api/categories/:id', async (req) => {
        const id = Number(req.params.id);
        tx(() => {
          db.prepare('UPDATE products SET category_id = NULL WHERE category_id = ?').run(id);
          db.prepare('DELETE FROM categories WHERE id = ?').run(id);
        });
        broadcast('settings');
        return { ok: true };
      });

      // Produits
      const productFields = (b) => {
        const name_fr = String(b.name_fr ?? '').trim();
        if (!name_fr) throw fail(400, 'name_required');
        const price = Math.round(Number(b.price));
        if (!(price >= 0)) throw fail(400, 'invalid_price');
        const unit = b.unit ?? 'piece';
        if (!['piece', 'kg', 'litre'].includes(unit)) throw fail(400, 'invalid_unit');
        const rate = b.tax_rate === '' || b.tax_rate == null ? null : Number(b.tax_rate);
        if (rate != null && !(rate >= 0 && rate <= 100)) throw fail(400, 'invalid_input');
        return {
          name_fr, name_ar: String(b.name_ar ?? '').trim(),
          barcode: String(b.barcode ?? '').trim() || null,
          category_id: b.category_id || null, unit, price,
          cost: Math.round(Number(b.cost) || 0),
          min_stock: Number(b.min_stock) || 0,
          expiry_date: b.expiry_date || null,
          tax_rate: rate,
          active: b.active === false || b.active === 0 ? 0 : 1,
        };
      };
      const uniqueBarcode = (fn) => {
        try { return fn(); } catch (e) {
          if (String(e.message).includes('UNIQUE')) throw fail(409, 'barcode_exists');
          throw e;
        }
      };

      const insertProduct = (f, initial, employeeId) => {
        const { lastInsertRowid } = db.prepare(
          `INSERT INTO products(name_fr,name_ar,barcode,category_id,unit,price,cost,stock,min_stock,expiry_date,tax_rate,active)
           VALUES(@name_fr,@name_ar,@barcode,@category_id,@unit,@price,@cost,@stock,@min_stock,@expiry_date,@tax_rate,@active)`)
          .run({ ...f, stock: initial });
        const id = Number(lastInsertRowid);
        if (initial) {
          addMovement(id, initial, 'initial', null, employeeId);
          if (f.expiry_date && initial > 0) addLot(id, { qty: initial, expiry: f.expiry_date, source: 'initial' });
        }
        return id;
      };

      mgr.post('/api/products', async (req) => {
        const f = productFields(req.body ?? {});
        const initial = Number(req.body?.stock) || 0;
        const id = uniqueBarcode(() => tx(() => insertProduct(f, initial, req.user.id)));
        broadcast('stock', { productIds: [id] });
        return db.prepare('SELECT * FROM products WHERE id=?').get(id);
      });

      /** La date saisie sur la fiche s'applique au lot unique ; avec plusieurs lots, elle est calculée. */
      const applyExpiry = (id, date) => {
        const lots = db.prepare('SELECT * FROM stock_lots WHERE product_id = ? AND qty > 0').all(id);
        if (lots.length === 1) db.prepare('UPDATE stock_lots SET expiry_date = ? WHERE id = ?').run(date, lots[0].id);
        if (lots.length === 0) {
          const { stock } = db.prepare('SELECT stock FROM products WHERE id = ?').get(id);
          if (date && stock > 0) addLot(id, { qty: stock, expiry: date, source: 'fiche' });
          return;
        }
        syncExpiry(id);
      };

      mgr.put('/api/products/:id', async (req) => {
        const id = Number(req.params.id);
        const f = productFields(req.body ?? {});
        uniqueBarcode(() => tx(() => {
          db.prepare(
            `UPDATE products SET name_fr=@name_fr,name_ar=@name_ar,barcode=@barcode,category_id=@category_id,
             unit=@unit,price=@price,cost=@cost,min_stock=@min_stock,expiry_date=@expiry_date,tax_rate=@tax_rate,active=@active
             WHERE id=@id`).run({ ...f, id });
          applyExpiry(id, f.expiry_date);
        }));
        broadcast('stock', { productIds: [id] });
        return db.prepare('SELECT * FROM products WHERE id=?').get(id);
      });

      // Réapprovisionnement / correction d'inventaire
      mgr.post('/api/products/:id/stock', async (req) => {
        const id = Number(req.params.id);
        const b = req.body ?? {};
        const delta = Number(b.delta);
        const reason = ['restock', 'adjustment', 'loss'].includes(b.reason) ? b.reason : 'adjustment';
        if (!Number.isFinite(delta) || delta === 0) throw fail(400, 'invalid_qty');
        const expiry = b.expiry_date || null;
        if (expiry && !isDate(expiry)) throw fail(400, 'invalid_input');
        tx(() => {
          if (!db.prepare('SELECT 1 FROM products WHERE id=?').get(id)) throw fail(404, 'not_found');
          changeStock(id, delta);
          if (delta < 0) consumeLots(id, -delta);
          else if (expiry || b.lot_code) addLot(id, { qty: delta, expiry, code: text(b.lot_code, 60), source: reason });
          addMovement(id, delta, reason, null, req.user.id);
        });
        broadcast('stock', { productIds: [id] });
        return db.prepare('SELECT * FROM products WHERE id=?').get(id);
      });

      mgr.get('/api/products/:id/lots', async (req) =>
        db.prepare(`SELECT * FROM stock_lots WHERE product_id = ? AND qty > 0
                    ORDER BY (expiry_date IS NULL OR expiry_date = ''), expiry_date, id`).all(Number(req.params.id)));

      // Historique des entrées et sorties
      mgr.get('/api/stock-movements', async (req) => {
        const productId = Number(req.query.productId) || null;
        const limit = Math.min(Number(req.query.limit) || 200, 1000);
        return db.prepare(
          `SELECT m.*, e.name AS employee_name, p.name_fr, p.name_ar, p.unit
           FROM stock_movements m JOIN products p ON p.id = m.product_id LEFT JOIN employees e ON e.id = m.employee_id
           ${productId ? 'WHERE m.product_id = @productId' : ''} ORDER BY m.id DESC LIMIT @limit`)
          .all(productId ? { productId, limit } : { limit });
      });

      // Import depuis un fichier CSV (les colonnes sont celles de l'export)
      mgr.post('/api/products/import', { bodyLimit: 10 * 1024 * 1024 }, async (req) => {
        const rows = req.body?.rows;
        if (!Array.isArray(rows)) throw fail(400, 'invalid_input');
        const updateStock = !!req.body.updateStock;
        const out = { created: 0, updated: 0, errors: [] };
        const changed = tx(() => {
          const ids = [];
          const findCategory = (name) => {
            const clean = text(name, 80);
            if (!clean) return null;
            const hit = db.prepare('SELECT id FROM categories WHERE lower(name_fr) = lower(?)').get(clean);
            if (hit) return hit.id;
            return Number(db.prepare("INSERT INTO categories(name_fr, name_ar) VALUES(?, '')").run(clean).lastInsertRowid);
          };
          rows.forEach((r, i) => {
            try {
              const barcode = String(r.barcode ?? '').trim();
              const found = (barcode && db.prepare('SELECT * FROM products WHERE barcode = ?').get(barcode))
                || db.prepare('SELECT * FROM products WHERE lower(name_fr) = lower(?)').get(String(r.name_fr ?? '').trim());
              const f = productFields({
                ...r, active: r.active === undefined ? (found ? found.active : 1) : Number(r.active) !== 0,
                barcode: barcode || found?.barcode || '',
                name_ar: r.name_ar ?? found?.name_ar ?? '',
                unit: r.unit || found?.unit || 'piece',
                price: r.price === undefined || r.price === '' ? found?.price : r.price,
                category_id: r.category ? findCategory(r.category) : found?.category_id ?? null,
                cost: r.cost === undefined || r.cost === '' ? found?.cost ?? 0 : r.cost,
                min_stock: r.min_stock === undefined || r.min_stock === '' ? found?.min_stock ?? 0 : r.min_stock,
                expiry_date: r.expiry_date || found?.expiry_date || null,
                tax_rate: found?.tax_rate ?? null,
              });
              if (!found) {
                ids.push(insertProduct(f, Number(r.stock) || 0, req.user.id));
                out.created += 1;
                return;
              }
              db.prepare(
                `UPDATE products SET name_fr=@name_fr,name_ar=@name_ar,barcode=@barcode,category_id=@category_id,
                 unit=@unit,price=@price,cost=@cost,min_stock=@min_stock,expiry_date=@expiry_date,tax_rate=@tax_rate,active=@active
                 WHERE id=@id`).run({ ...f, id: found.id });
              if (updateStock && r.stock !== undefined && r.stock !== '') {
                const delta = Number(r.stock) - found.stock;
                if (delta) {
                  changeStock(found.id, delta);
                  if (delta < 0) consumeLots(found.id, -delta);
                  addMovement(found.id, delta, 'adjustment', 'import', req.user.id);
                }
              }
              ids.push(found.id);
              out.updated += 1;
            } catch (e) {
              out.errors.push({ line: i + 2, error: String(e.message).includes('UNIQUE') ? 'barcode_exists' : e.message });
            }
          });
          return ids;
        });
        broadcast('stock', { productIds: changed });
        return out;
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
        for (const [k, max] of [['ticket_footer', 300], ['shop_address', 200], ['shop_phone', 50], ['shop_tax_id', 60]]) {
          if (b[k] !== undefined) setSetting(k, text(b[k], max));
        }
        for (const k of ['allow_negative_stock', 'auto_print', 'printer_cut', 'cash_drawer', 'tax_enabled', 'seller_can_change_price', 'seller_can_credit']) {
          if (b[k] !== undefined) setSetting(k, b[k] ? '1' : '0');
        }
        for (const k of ['tax_rate', 'seller_max_discount']) {
          if (b[k] === undefined) continue;
          const v = Number(b[k]);
          if (!(v >= 0 && v <= 100)) throw fail(400, 'invalid_input');
          setSetting(k, String(v));
        }
        if (b.paper_width !== undefined) {
          if (![58, 80].includes(Number(b.paper_width))) throw fail(400, 'invalid_input');
          setSetting('paper_width', String(Number(b.paper_width)));
        }
        if (b.currency !== undefined) setSetting('currency', text(b.currency, 8) || 'FCFA');
        if (b.phone_prefix !== undefined) setSetting('phone_prefix', String(b.phone_prefix).replace(/\D/g, '').slice(0, 4));
        if (b.printer !== undefined) {
          const p = String(b.printer);
          const testFile = process.env.PRINT_TO_FILE_DIR && p === 'file:test';
          if (p && !testFile && !/^(usb:.+|tcp:[\w.\-]+(:\d{1,5})?)$/.test(p)) throw fail(400, 'invalid_input');
          setSetting('printer', p);
        }
        broadcast('settings');
        return { ok: true };
      });

      mgr.get('/api/printers', async () => {
        try { return { printers: await listPrinters() }; } catch (e) { return { printers: [], error: e.message }; }
      });

      mgr.post('/api/drawer', async () => {
        const target = getSetting('printer', '');
        if (!target) throw fail(400, 'no_printer');
        try { await sendToPrinter(target, DRAWER_PULSE); } catch (e) { throw fail(502, 'print_failed', { detail: e.message }); }
        return { ok: true };
      });
    });
  });
}
