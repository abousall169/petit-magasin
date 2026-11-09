import { useApp } from '../ctx.js';
import { ticketText, smsUrl, whatsappUrl } from '../share.js';

/** Envoi du ticket par WhatsApp ou SMS, à partir du téléphone du client s'il est connu. */
export default function ShareButtons({ sale }) {
  const { settings, lang, t } = useApp();
  const text = ticketText(sale, { lang, t, shop: settings.shop_name, footer: settings.ticket_footer });
  return (
    <div className="grid grid-cols-2 gap-3">
      <a className="btn btn-secondary" target="_blank" rel="noreferrer" href={whatsappUrl(sale.customer_phone, text, settings.phone_prefix)}>💬 {t.whatsapp}</a>
      <a className="btn btn-secondary" href={smsUrl(sale.customer_phone, text)}>✉️ {t.sms}</a>
    </div>
  );
}
