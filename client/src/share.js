// Envoi du ticket ou d'un rappel de dette par WhatsApp ou SMS (ouvre l'application du téléphone, message pré-rempli).
import { pname, payLabel } from './i18n.js';
import { money, qtyFmt, dateTime } from './format.js';

const plain = (s) => String(s).replace(/[⁦-⁩]/g, '');

export function ticketText(sale, { lang, t, shop, footer }) {
  const lines = [shop || t.appName, `${sale.id ? `${t.receipt} #${sale.id}` : t.receipt} · ${dateTime(sale.created_at)}`, ''];
  for (const it of sale.items ?? []) {
    lines.push(`${pname(it, lang)} : ${qtyFmt(it.qty)} × ${qtyFmt(it.unit_price)} = ${qtyFmt(it.line_total)}`);
  }
  lines.push('');
  if (sale.discount > 0) lines.push(`${t.discount} : -${money(sale.discount)}`);
  lines.push(`${t.total} : ${money(sale.total)}`);
  for (const p of sale.payments ?? []) lines.push(`${payLabel(t, p.method)} : ${money(p.amount)}`);
  if (footer) lines.push('', footer);
  return plain(lines.join('\n'));
}

export const debtText = (customer, { t, shop }) =>
  plain(`${shop || t.appName}\n${customer.name}, ${t.debtReminder} ${money(customer.balance)}.`);

export function intlPhone(phone, prefix) {
  let digits = String(phone ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('00')) return digits.slice(2);
  if (prefix && !digits.startsWith(prefix)) digits = prefix + digits.replace(/^0/, '');
  return digits;
}

export const whatsappUrl = (phone, message, prefix) =>
  `https://wa.me/${intlPhone(phone, prefix)}?text=${encodeURIComponent(message)}`;
export const smsUrl = (phone, message) =>
  `sms:${String(phone ?? '').replace(/[^\d+]/g, '')}?&body=${encodeURIComponent(message)}`;
