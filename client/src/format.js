const nf = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3, useGrouping: true });

// Les nombres sont isolés en gauche-à-droite (LRI…PDI) pour ne pas être inversés dans le texte arabe.
const ltr = (s) => `⁦${s}⁩`;
const grouped = (n) => nf.format(n).replace(/[  ]/g, ' ');

let currency = 'FCFA';
/** La monnaie est choisie dans Réglages ; les montants restent entiers (pas de centimes). */
export const setCurrency = (c) => { currency = c || 'FCFA'; };

/** 1500 -> "1 500 FCFA" (chiffres latins dans toutes les langues). */
export const money = (n) => ltr(`${grouped(Math.round(n || 0))} ${currency}`);
export const qtyFmt = (n) => ltr(grouped(n || 0));

export function dateTime(s) {
  if (!s) return '';
  return s.replace('T', ' ').slice(0, 16);
}
export const today = () => new Date().toLocaleDateString('sv-SE');
export const localNow = () => new Date().toLocaleString('sv-SE');
export const isoDate = (d) => d.toLocaleDateString('sv-SE');
