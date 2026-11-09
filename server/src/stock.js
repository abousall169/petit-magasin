// Mouvements de stock et lots (péremption).
import { db } from './db.js';
import { round3 } from './util.js';

export function addMovement(productId, delta, reason, ref, employeeId) {
  db.prepare('INSERT INTO stock_movements(product_id, delta, reason, ref, employee_id) VALUES(?,?,?,?,?)')
    .run(productId, delta, reason, ref ?? null, employeeId ?? null);
}

export function changeStock(productId, delta) {
  db.prepare('UPDATE products SET stock = ROUND(stock + ?, 3) WHERE id=?').run(delta, productId);
}

/** La date affichée sur le produit suit le lot qui périme le plus tôt. */
export function syncExpiry(productId) {
  db.prepare(`UPDATE products SET expiry_date = (
      SELECT MIN(expiry_date) FROM stock_lots
      WHERE product_id = @id AND qty > 0 AND expiry_date IS NOT NULL AND expiry_date <> '')
    WHERE id = @id`).run({ id: productId });
}

export function addLot(productId, { qty, expiry = null, code = '', source = '' }) {
  db.prepare('INSERT INTO stock_lots(product_id, code, expiry_date, qty, source) VALUES(?,?,?,?,?)')
    .run(productId, code, expiry || null, qty, source);
  syncExpiry(productId);
}

/** Retire qty des lots, péremption la plus proche d'abord. Renvoie la répartition pour pouvoir la restituer. */
export function consumeLots(productId, qty) {
  const lots = db.prepare(`SELECT id, qty FROM stock_lots WHERE product_id = ? AND qty > 0
    ORDER BY (expiry_date IS NULL OR expiry_date = ''), expiry_date, id`).all(productId);
  const update = db.prepare('UPDATE stock_lots SET qty = ROUND(qty - ?, 3) WHERE id = ?');
  const used = [];
  let left = qty;
  for (const lot of lots) {
    if (left <= 0) break;
    const take = Math.min(lot.qty, left);
    update.run(take, lot.id);
    used.push({ lot: lot.id, qty: take });
    left = round3(left - take);
  }
  if (used.length) syncExpiry(productId);
  return used;
}

/** Remet qty dans les lots d'où venait une ligne de vente (retour ou annulation). */
export function restoreLots(saleItem, qty) {
  const alloc = JSON.parse(saleItem.lots || '[]');
  if (!alloc.length) return;
  const update = db.prepare('UPDATE stock_lots SET qty = ROUND(qty + ?, 3) WHERE id = ?');
  let left = qty;
  for (let i = alloc.length - 1; i >= 0 && left > 0; i--) {
    const give = Math.min(alloc[i].qty, left);
    update.run(give, alloc[i].lot);
    alloc[i].qty = round3(alloc[i].qty - give);
    left = round3(left - give);
  }
  db.prepare('UPDATE sale_items SET lots = ? WHERE id = ?').run(JSON.stringify(alloc.filter((a) => a.qty > 0)), saleItem.id);
  syncExpiry(saleItem.product_id);
}
