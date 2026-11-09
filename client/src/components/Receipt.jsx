import { createPortal } from 'react-dom';
import { useApp } from '../ctx.js';
import { useI18n, pname } from '../i18n.js';
import { money, qtyFmt, dateTime } from '../format.js';

function Body({ sale, lang, t, shop, footer }) {
  const items = sale.items ?? [];
  return (
    <div dir={lang === 'ar' ? 'rtl' : 'ltr'} style={{ fontFamily: 'inherit' }}>
      <div style={{ textAlign: 'center', fontWeight: 700, fontSize: '1.15em' }}>{shop}</div>
      <div style={{ textAlign: 'center', fontSize: '.85em' }}>
        {sale.id ? `${t.receipt} #${sale.id}` : t.offline} · {dateTime(sale.created_at)}
      </div>
      <div style={{ textAlign: 'center', fontSize: '.85em' }}>{t.seller}: {sale.employee_name}</div>
      {sale.status === 'voided' && <div style={{ textAlign: 'center', fontWeight: 700 }}>*** {t.voided} ***</div>}
      <hr style={{ margin: '6px 0', borderTop: '1px dashed #000' }} />
      {items.map((it, i) => (
        <div key={i} style={{ marginBottom: 3 }}>
          <div>{pname(it, lang)}</div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>{qtyFmt(it.qty)} × {qtyFmt(it.unit_price)}</span>
            <span>{qtyFmt(it.line_total)}</span>
          </div>
        </div>
      ))}
      <hr style={{ margin: '6px 0', borderTop: '1px dashed #000' }} />
      {sale.discount > 0 && (
        <>
          <Row a={t.subtotal} b={money(sale.subtotal)} />
          <Row a={t.discount} b={`- ${money(sale.discount)}`} />
        </>
      )}
      <Row a={t.total} b={money(sale.total)} bold />
      <Row a={t.payment} b={sale.payment_method === 'cash' ? t.cash : t.mobile} />
      {sale.payment_method === 'cash' && sale.cash_given != null && (
        <>
          <Row a={t.cashGiven} b={money(sale.cash_given)} />
          <Row a={t.change} b={money(sale.cash_given - sale.total)} />
        </>
      )}
      {footer && <div style={{ textAlign: 'center', marginTop: 8, fontSize: '.85em' }}>{footer}</div>}
    </div>
  );
}
const Row = ({ a, b, bold }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: bold ? 700 : 400, fontSize: bold ? '1.1em' : undefined }}>
    <span>{a}</span><span>{b}</span>
  </div>
);

/** Ticket visible à l'écran + copie cachée (portail) imprimée par window.print(). */
export default function Receipt({ sale }) {
  const { settings } = useApp();
  const { lang, t } = useI18n();
  const props = { sale, lang, t, shop: settings.shop_name, footer: settings.ticket_footer };
  return (
    <>
      <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-sm"><Body {...props} /></div>
      {createPortal(<div id="receipt-print"><Body {...props} /></div>, document.body)}
    </>
  );
}
