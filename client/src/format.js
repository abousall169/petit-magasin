const nf = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3, useGrouping: true });

// Les nombres sont isolés en gauche-à-droite (LRI…PDI) pour ne pas être inversés dans le texte arabe.
const ltr = (s) => `⁦${s}⁩`;

/** 1500 -> "1 500 FCFA" (chiffres latins dans les deux langues ; le FCFA n'a pas de décimales). */
export const money = (n) => ltr(`${nf.format(Math.round(n || 0)).replace(/[  ]/g, ' ')} FCFA`);
export const qtyFmt = (n) => ltr(nf.format(n || 0).replace(/[  ]/g, ' '));

export function dateTime(s) {
  if (!s) return '';
  return s.replace('T', ' ').slice(0, 16);
}
export const today = () => new Date().toLocaleDateString('sv-SE');
