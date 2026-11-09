import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPin } from './auth.js';
import { alimentation } from './profiles/alimentation.js';
import { migrate } from './migrations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.DATA_DIR || resolve(__dirname, '../../data');
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(resolve(DATA_DIR, 'magasin.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('manager','seller')),
  pin_hash TEXT NOT NULL,
  pin_salt TEXT NOT NULL,
  lang TEXT NOT NULL DEFAULT 'fr',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name_fr TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '🛒'
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  name_fr TEXT NOT NULL,
  name_ar TEXT NOT NULL DEFAULT '',
  barcode TEXT UNIQUE,
  category_id INTEGER REFERENCES categories(id),
  unit TEXT NOT NULL DEFAULT 'piece' CHECK (unit IN ('piece','kg','litre')),
  price INTEGER NOT NULL CHECK (price >= 0),
  cost INTEGER NOT NULL DEFAULT 0,
  stock REAL NOT NULL DEFAULT 0,
  min_stock REAL NOT NULL DEFAULT 0,
  expiry_date TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY,
  client_id TEXT UNIQUE,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  subtotal INTEGER NOT NULL,
  discount INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash','mobile')),
  cash_given INTEGER,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','voided')),
  voided_by INTEGER REFERENCES employees(id),
  void_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS sale_items (
  id INTEGER PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  name_fr TEXT NOT NULL,
  name_ar TEXT NOT NULL DEFAULT '',
  qty REAL NOT NULL,
  unit_price INTEGER NOT NULL,
  line_total INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  delta REAL NOT NULL,
  reason TEXT NOT NULL,
  ref TEXT,
  employee_id INTEGER REFERENCES employees(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Reconnaissance par photo : une ligne = une photo de référence d'un produit (empreinte numérique + miniature)
CREATE TABLE IF NOT EXISTS product_images (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  embedding BLOB NOT NULL,
  thumb TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_images_product ON product_images(product_id);
CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
CREATE INDEX IF NOT EXISTS idx_items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
`);

migrate(db, { dataDir: DATA_DIR });

/** Exécute fn dans une transaction (BEGIN IMMEDIATE = écritures sérialisées). */
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const getSetting = (k, d = null) =>
  db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value ?? d;
export const setSetting = (k, v) =>
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));

/** Premier lancement : gérant par défaut + catégories et paramètres du profil. */
export function seedIfEmpty() {
  if (db.prepare('SELECT COUNT(*) c FROM employees').get().c === 0) {
    const { hash, salt } = hashPin('1234');
    db.prepare('INSERT INTO employees(name,role,pin_hash,pin_salt,lang) VALUES(?,?,?,?,?)')
      .run('Gérant', 'manager', hash, salt, 'fr');
    console.log('⚠️  Compte gérant créé : PIN 1234 — à changer dès la première connexion.');
  }
  if (db.prepare('SELECT COUNT(*) c FROM categories').get().c === 0) {
    const ins = db.prepare('INSERT INTO categories(name_fr,name_ar,icon) VALUES(?,?,?)');
    for (const c of alimentation.categories) ins.run(c.fr, c.ar, c.icon);
  }
  if (!getSetting('shop_name')) setSetting('shop_name', alimentation.defaultShopName);
  if (!getSetting('ticket_footer')) setSetting('ticket_footer', 'Merci de votre visite ! / شكراً لزيارتكم');
  if (!getSetting('profile')) setSetting('profile', alimentation.id);
}
