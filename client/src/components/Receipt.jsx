import { createPortal } from 'react-dom';
import { useApp } from '../ctx.js';
import { useI18n, pname, payLabel, cashPart } from '../i18n.js';
import { money, qtyFmt, dateTime } from '../format.js';

function Body({ sale, lang, t, settings }) {
  const items = sale.items ?? [];
  const payments = sale.payments?.length ? sale.payments : [{ method: sale.payment_method, amount: sale.total }];
  const center = { textAlign: 'center', fontSize: '.85em' };
  return (
    <div dir={lang === 'ar' ? 'rtl' : 'ltr'} style={{ fontFamily: 'inherit' }}>
      <div style={{ textAlign: 'center', fontWeight: 700, fontSize: '1.15em' }}>{settings.shop_name}</div>
      {settings.shop_address && <div style={center}>{settings.shop_address}</div>}
      {settings.shop_phone && <div style={center}>{settings.shop_phone}</div>}
      {settings.shop_tax_id && <div style={center}>{settings.shop_tax_id}</div>}
      <div style={center}>{sale.id ? `${t.receipt} #${sale.id}` : t.offline} · {dateTime(sale.created_at)}</div>
      <div style={center}>{t.seller}: {sale.employee_name}</div>
      {sale.customer_name && <div style={center}>{t.customer}: {sale.customer_name}</div>}
      {sale.status === 'voided' && <div style={{ textAlign: 'center', fontWeight: 700 }}>*** {t.voided} ***</div>}
      <hr style={{ margin: '6px 0', borderTop: '1px dashed #000' }} />
      {items.map((it, i) => (
        <div key={i} style={{ marginBottom: 3 }}>
          <div>{pname(it, lang)}</div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>{qtyFmt(it.qty)} × {qtyFmt(it.unit_price)}{it.line_discount > 0 ? ` (-${qtyFmt(it.line_discount)})` : ''}</span>
            <span>{qtyFmt(it.line_total)}</span>
          </div>
          {it.returned_qty > 0 && <div style={{ fontSize: '.85em' }}>{t.returnedQty}: {qtyFmt(it.returned_qty)}</div>}
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
      {sale.tax_total > 0 && <Row a={t.taxIncluded} b={money(sale.tax_total)} />}
      {payments.length > 1
        ? payments.map((p, i) => <Row key={i} a={payLabel(t, p.method)} b={money(p.amount)} />)
        : <Row a={t.payment} b={payLabel(t, payments[0].method)} />}
      {payments.filter((p) => p.reference).map((p, i) => <Row key={i} a={t.referenceShort} b={p.reference} />)}
      {sale.cash_given != null && (
        <>
          <Row a={t.cashGiven} b={money(sale.cash_given)} />
          <Row a={t.change} b={money(sale.cash_given - cashPart(sale))} />
        </>
      )}
      {sale.refunded_total > 0 && <Row a={t.refunded} b={`- ${money(sale.refunded_total)}`} />}
      {settings.ticket_footer && <div style={{ textAlign: 'center', marginTop: 8, fontSize: '.85em' }}>{settings.ticket_footer}</div>}
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
  const props = { sale, lang, t, settings };
  return (
    <>
      <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-sm"><Body {...props} /></div>
      {createPortal(<div id="receipt-print" style={{ width: settings.paper_width === 58 ? '48mm' : undefined }}><Body {...props} /></div>, document.body)}
    </>
  );
}
