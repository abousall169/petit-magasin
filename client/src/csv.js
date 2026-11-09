// Lecture d'un fichier CSV de produits (colonnes de l'export, ou fichier Excel enregistré en CSV).

function parseRows(source) {
  const src = source.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const count = (ch) => firstLine.split(ch).length - 1;
  const sep = count(';') >= count(',') ? ';' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

const HEADERS = {
  code_barres: 'barcode', code_barre: 'barcode', codebarres: 'barcode', barcode: 'barcode', code: 'barcode', ean: 'barcode',
  nom: 'name_fr', nom_fr: 'name_fr', name: 'name_fr', produit: 'name_fr', designation: 'name_fr',
  nom_ar: 'name_ar', categorie: 'category', category: 'category', unite: 'unit', unit: 'unit',
  prix: 'price', prix_vente: 'price', price: 'price', cout: 'cost', prix_achat: 'cost', cost: 'cost',
  stock: 'stock', quantite: 'stock', qty: 'stock', seuil: 'min_stock', stock_min: 'min_stock', min_stock: 'min_stock',
  peremption: 'expiry_date', expiry_date: 'expiry_date', actif: 'active', active: 'active',
};
const headerKey = (h) => h.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\s'’-]+/g, '_');
const number = (s) => s.replace(/[\s  ]/g, '').replace(',', '.');
const unit = (s) => {
  const v = s.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (['kg', 'kilo', 'kilos', 'kilogramme'].includes(v)) return 'kg';
  if (['l', 'litre', 'litres'].includes(v)) return 'litre';
  return v ? 'piece' : '';
};
const date = (s) => {
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s.trim());
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : s.trim();
};
const cleanText = (s) => s.replace(/^'(?=[=+\-@])/, '').trim();

/** Renvoie { rows, ignored } : ignored = noms des colonnes non reconnues. */
export function productsFromCsv(source) {
  const [head, ...body] = parseRows(source);
  if (!head) return { rows: [], ignored: [] };
  const keys = head.map((h) => HEADERS[headerKey(h)] ?? null);
  const ignored = head.filter((_, i) => !keys[i]);
  const rows = body.map((cells) => {
    const r = {};
    keys.forEach((k, i) => {
      if (!k || cells[i] === undefined) return;
      const v = cells[i];
      if (['price', 'cost', 'stock', 'min_stock', 'active'].includes(k)) r[k] = number(v);
      else if (k === 'unit') r[k] = unit(v);
      else if (k === 'expiry_date') r[k] = date(v);
      else r[k] = cleanText(v);
    });
    return r;
  });
  return { rows, ignored };
}
