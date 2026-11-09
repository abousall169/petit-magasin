// Évolutions de la structure de la base. PRAGMA user_version indique la version déjà appliquée.
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export const SCHEMA_VERSION = 1;

function v1(db) {
  db.exec(`
  CREATE TABLE customers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    credit_limit INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  -- La table sales est refaite : l'ancienne limitait le paiement à espèces/mobile.
  CREATE TABLE sales_new (
    id INTEGER PRIMARY KEY,
    client_id TEXT UNIQUE,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    customer_id INTEGER REFERENCES customers(id),
    subtotal INTEGER NOT NULL,
    discount INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL,
    tax_total INTEGER NOT NULL DEFAULT 0,
    payment_method TEXT NOT NULL,
    cash_given INTEGER,
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','voided')),
    voided_by INTEGER REFERENCES employees(id),
    void_reason TEXT,
    offline INTEGER NOT NULL DEFAULT 0,
    needs_review TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    synced_at TEXT
  );
  INSERT INTO sales_new (id, client_id, employee_id, subtotal, discount, total, payment_method, cash_given,
                         status, voided_by, void_reason, created_at)
    SELECT id, client_id, employee_id, subtotal, discount, total, payment_method, cash_given,
           status, voided_by, void_reason, created_at FROM sales;
  DROP TABLE sales;
  ALTER TABLE sales_new RENAME TO sales;
  CREATE INDEX idx_sales_created ON sales(created_at);
  CREATE INDEX idx_sales_customer ON sales(customer_id);

  ALTER TABLE sale_items ADD COLUMN unit_cost INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sale_items ADD COLUMN list_price INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sale_items ADD COLUMN line_discount INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sale_items ADD COLUMN tax_rate REAL NOT NULL DEFAULT 0;
  ALTER TABLE sale_items ADD COLUMN tax_amount INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sale_items ADD COLUMN returned_qty REAL NOT NULL DEFAULT 0;
  ALTER TABLE sale_items ADD COLUMN lots TEXT NOT NULL DEFAULT '[]';
  UPDATE sale_items SET list_price = unit_price,
    unit_cost = COALESCE((SELECT cost FROM products p WHERE p.id = sale_items.product_id), 0);

  ALTER TABLE products ADD COLUMN tax_rate REAL;

  CREATE TABLE sale_payments (
    id INTEGER PRIMARY KEY,
    sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    method TEXT NOT NULL,
    amount INTEGER NOT NULL,
    reference TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX idx_payments_sale ON sale_payments(sale_id);
  INSERT INTO sale_payments (sale_id, method, amount) SELECT id, payment_method, total FROM sales;

  -- Compte client : solde = somme des montants (positif = le client doit de l'argent).
  CREATE TABLE customer_ledger (
    id INTEGER PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    kind TEXT NOT NULL CHECK (kind IN ('sale','payment','void','refund','adjust')),
    amount INTEGER NOT NULL,
    method TEXT,
    reference TEXT NOT NULL DEFAULT '',
    sale_id INTEGER REFERENCES sales(id),
    employee_id INTEGER REFERENCES employees(id),
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX idx_ledger_customer ON customer_ledger(customer_id);

  CREATE TABLE refunds (
    id INTEGER PRIMARY KEY,
    sale_id INTEGER NOT NULL REFERENCES sales(id),
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    amount INTEGER NOT NULL,
    method TEXT NOT NULL,
    restock INTEGER NOT NULL DEFAULT 1,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX idx_refunds_sale ON refunds(sale_id);
  CREATE TABLE refund_items (
    id INTEGER PRIMARY KEY,
    refund_id INTEGER NOT NULL REFERENCES refunds(id) ON DELETE CASCADE,
    sale_item_id INTEGER NOT NULL REFERENCES sale_items(id),
    qty REAL NOT NULL,
    amount INTEGER NOT NULL,
    tax_amount INTEGER NOT NULL DEFAULT 0
  );

  -- Lots : quantités restantes par date de péremption (consommées en commençant par la plus proche).
  CREATE TABLE stock_lots (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id),
    code TEXT NOT NULL DEFAULT '',
    expiry_date TEXT,
    qty REAL NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX idx_lots_product ON stock_lots(product_id);
  INSERT INTO stock_lots (product_id, expiry_date, qty, source)
    SELECT id, expiry_date, stock, 'migration' FROM products
    WHERE expiry_date IS NOT NULL AND expiry_date <> '' AND stock > 0;

  CREATE TABLE suppliers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE purchases (
    id INTEGER PRIMARY KEY,
    supplier_id INTEGER REFERENCES suppliers(id),
    reference TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'ordered' CHECK (status IN ('ordered','received','cancelled')),
    total INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    employee_id INTEGER REFERENCES employees(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    received_at TEXT
  );
  CREATE TABLE purchase_items (
    id INTEGER PRIMARY KEY,
    purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id),
    qty REAL NOT NULL,
    unit_cost INTEGER NOT NULL DEFAULT 0,
    expiry_date TEXT,
    lot_code TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE purchase_payments (
    id INTEGER PRIMARY KEY,
    purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL,
    method TEXT NOT NULL,
    employee_id INTEGER REFERENCES employees(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE expenses (
    id INTEGER PRIMARY KEY,
    category TEXT NOT NULL DEFAULT '',
    amount INTEGER NOT NULL,
    method TEXT NOT NULL DEFAULT 'cash',
    note TEXT NOT NULL DEFAULT '',
    expense_date TEXT NOT NULL,
    employee_id INTEGER REFERENCES employees(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX idx_expenses_date ON expenses(expense_date);

  CREATE TABLE cash_sessions (
    id INTEGER PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
    opening_float INTEGER NOT NULL DEFAULT 0,
    opened_by INTEGER REFERENCES employees(id),
    opened_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    closed_by INTEGER REFERENCES employees(id),
    closed_at TEXT,
    expected INTEGER,
    counted INTEGER,
    difference INTEGER,
    note TEXT NOT NULL DEFAULT ''
  );

  CREATE INDEX idx_movements_product ON stock_movements(product_id, id);
  `);
}

/** Applique les évolutions manquantes. Une copie de la base est faite avant de toucher à des données existantes. */
export function migrate(db, { dataDir = null } = {}) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  if (current >= SCHEMA_VERSION) return;

  const used = db.prepare('SELECT (SELECT COUNT(*) FROM sales) + (SELECT COUNT(*) FROM products) AS n').get().n;
  if (dataDir && used > 0) {
    const dir = resolve(dataDir, 'avant-mise-a-jour');
    mkdirSync(dir, { recursive: true });
    const stamp = db.prepare("SELECT strftime('%Y-%m-%d-%H-%M-%S', 'now', 'localtime') AS v").get().v;
    const file = resolve(dir, `magasin-v${current}-${stamp}.db`);
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    console.log(`💾 Copie de sécurité avant mise à jour : ${file}`);
  }

  // Les clés étrangères doivent être coupées hors transaction pour pouvoir refaire une table.
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    if (current < 1) v1(db);
    const broken = db.prepare('PRAGMA foreign_key_check').all();
    if (broken.length) throw new Error(`Liens incohérents après migration (${broken.length})`);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
