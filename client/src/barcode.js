// Encodeurs de codes-barres (sans dépendance) : EAN-13 / EAN-8 / UPC-A, et Code 128 (repli pour tout autre code).
// encode(texte) -> { kind, text, bits } où bits est un tableau de 0/1 (1 = barre noire), sans marges.

const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const R = L.map((p) => [...p].map((c) => (c === '1' ? '0' : '1')).join(''));
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

export function eanCheckDigit(body) {
  // body = 12 chiffres (EAN-13) ou 7 (EAN-8) ; poids 3 pour le dernier chiffre du corps, puis 1, 3, 1…
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += Number(body[body.length - 1 - i]) * (i % 2 === 0 ? 3 : 1);
  return String((10 - (sum % 10)) % 10);
}
export const isValidEAN = (s) => /^\d{8}$|^\d{13}$/.test(s) && eanCheckDigit(s.slice(0, -1)) === s.slice(-1);

function ean13Bits(code) {
  const parity = PARITY[Number(code[0])];
  let bits = '101';
  for (let i = 0; i < 6; i++) bits += (parity[i] === 'L' ? L : G)[Number(code[i + 1])];
  bits += '01010';
  for (let i = 7; i < 13; i++) bits += R[Number(code[i])];
  return bits + '101';
}
function ean8Bits(code) {
  let bits = '101';
  for (let i = 0; i < 4; i++) bits += L[Number(code[i])];
  bits += '01010';
  for (let i = 4; i < 8; i++) bits += R[Number(code[i])];
  return bits + '101';
}

// Code 128 : largeurs (barre, espace, barre, espace, barre, espace) de chaque valeur 0..105 + arrêt (106)
const C128 = ('212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 ' +
  '221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 ' +
  '231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 ' +
  '314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 ' +
  '111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 ' +
  '114131 311141 411131 211412 211214 211232 2331112').split(' ');
const widthsToBits = (w) => [...w].map((n, i) => (i % 2 === 0 ? '1' : '0').repeat(Number(n))).join('');

function code128Bits(text) {
  // Code 128-B (ASCII 32..126). Les nombres pairs de chiffres sont plus compacts en C, mais B reste simple et sûr.
  const vals = [104, ...[...text].map((ch) => ch.charCodeAt(0) - 32)];
  let sum = vals[0];
  for (let i = 1; i < vals.length; i++) sum += vals[i] * i;
  vals.push(sum % 103, 106);
  return vals.map((v) => widthsToBits(C128[v])).join('');
}

/** Choisit le bon format : EAN-13/8 valides (et UPC-A 12 chiffres) sinon Code 128. */
export function encode(raw) {
  let text = String(raw ?? '').trim();
  if (!text) return null;
  if (/^\d{12}$/.test(text) && isValidEAN('0' + text)) text = '0' + text; // UPC-A = EAN-13 commençant par 0
  if (text.length === 13 && isValidEAN(text)) return { kind: 'ean13', text, bits: [...ean13Bits(text)].map(Number) };
  if (text.length === 8 && isValidEAN(text)) return { kind: 'ean8', text, bits: [...ean8Bits(text)].map(Number) };
  if (/^[\x20-\x7e]{1,40}$/.test(text)) return { kind: 'code128', text, bits: [...code128Bits(text)].map(Number) };
  return null; // caractères non supportés / trop long
}

/** Découpe les bits en segments noirs { x, w } (en modules) pour le dessin. */
export function bars(bits) {
  const out = []; let x = 0;
  while (x < bits.length) {
    if (bits[x]) { let w = 1; while (bits[x + w]) w++; out.push({ x, w }); x += w; } else x++;
  }
  return out;
}

/** Chiffres lisibles sous le code : positions (en modules, relatives aux barres) pour EAN. */
export function humanReadable(code) {
  if (code.kind === 'ean13') {
    const t = code.text;
    return [{ s: t[0], x: -6, anchor: 'start' }, { s: t.slice(1, 7), x: 3 + 21, anchor: 'middle' }, { s: t.slice(7), x: 50 + 21, anchor: 'middle' }];
  }
  if (code.kind === 'ean8') {
    return [{ s: code.text.slice(0, 4), x: 3 + 14, anchor: 'middle' }, { s: code.text.slice(4), x: 36 + 14, anchor: 'middle' }];
  }
  return [{ s: code.text, x: code.bits.length / 2, anchor: 'middle' }];
}

/** Code interne unique pour un produit : EAN-13 « usage magasin » (préfixe 20) + n° du produit. */
export const internalEan13 = (productId) => {
  const body = `20${String(productId).padStart(10, '0')}`;
  return body + eanCheckDigit(body);
};

/**
 * Forme canonique d'un code lu ou saisi : un UPC-A (12 chiffres) est un EAN-13 qui commence par 0.
 * Les lecteurs renvoient l'un ou l'autre selon le cas : on compare toujours les formes canoniques.
 */
export const normalizeCode = (s) => {
  const t = String(s ?? '').trim();
  return /^\d{12}$/.test(t) ? `0${t}` : t;
};
export const sameCode = (a, b) => !!a && !!b && normalizeCode(a) === normalizeCode(b);
