import { useState } from 'react';
import { useApp } from '../ctx.js';
import { pname, payLabel } from '../i18n.js';
import { money, qtyFmt, dateTime } from '../format.js';
import Modal from './Modal.jsx';
import PrintA4 from './PrintA4.jsx';

function InvoiceDoc({ sale, customer, settings, lang, t }) {
  const cell = { padding: '4px 6px', borderBottom: '1px solid #bbb' };
  const num = { ...cell, textAlign: 'end', whiteSpace: 'nowrap' };
  const Total = ({ a, b, bold }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 24, fontWeight: bold ? 700 : 400, fontSize: bold ? 15 : 12, marginTop: 3 }}><span>{a}</span><span>{b}</span></div>
  );
  return (
    <div dir={lang === 'ar' ? 'rtl' : 'ltr'} style={{ color: '#000', fontSize: 12, lineHeight: 1.4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 24, marginBottom: 24 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{settings.shop_name}</div>
          {settings.shop_address && <div>{settings.shop_address}</div>}
          {settings.shop_phone && <div>{settings.shop_phone}</div>}
          {settings.shop_tax_id && <div>{settings.shop_tax_id}</div>}
        </div>
        <div style={{ textAlign: 'end' }}>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{t.invoice} {t.invoiceNo}{sale.id}</div>
          <div>{dateTime(sale.created_at)}</div>
        </div>
      </div>
      {(customer.name || customer.address) && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 700 }}>{t.billedTo}</div>
          {customer.name && <div>{customer.name}</div>}
          {customer.address && <div>{customer.address}</div>}
        </div>
      )}
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ fontWeight: 700 }}>
            <td style={cell}>{t.designation}</td><td style={num}>{t.qty}</td><td style={num}>{t.unitPrice}</td>
            <td style={num}>{t.discount}</td><td style={num}>{t.total}</td>
          </tr>
        </thead>
        <tbody>
          {sale.items.map((it) => (
            <tr key={it.id}>
              <td style={cell}>{pname(it, lang)}</td><td style={num}>{qtyFmt(it.qty)}</td><td style={num}>{qtyFmt(it.unit_price)}</td>
              <td style={num}>{it.line_discount > 0 ? qtyFmt(it.line_discount) : ''}</td><td style={num}>{qtyFmt(it.line_total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginTop: 12, marginInlineStart: 'auto', width: '45%' }}>
        {sale.discount > 0 && <Total a={t.subtotal} b={money(sale.subtotal)} />}
        {sale.discount > 0 && <Total a={t.discount} b={`- ${money(sale.discount)}`} />}
        <Total a={t.total} b={money(sale.total)} bold />
        {sale.tax_total > 0 && <Total a={t.taxIncluded} b={money(sale.tax_total)} />}
        {sale.refunded_total > 0 && <Total a={t.refunded} b={`- ${money(sale.refunded_total)}`} />}
        {(sale.payments ?? []).map((p, i) => <Total key={i} a={payLabel(t, p.method)} b={money(p.amount)} />)}
      </div>
    </div>
  );
}

/** Bouton « Facture A4 » : demande le nom du client si besoin, puis imprime. */
export default function InvoiceButton({ sale }) {
  const { settings, t, lang } = useApp();
  const [form, setForm] = useState(null);
  const [printing, setPrinting] = useState(false);
  if (!sale.id) return null;
  const open = () => setForm({ name: sale.customer_name ?? '', address: sale.customer_address ?? '' });
  return (
    <>
      <button className="btn btn-secondary" onClick={open}>📄 {t.invoice}</button>
      {form && (
        <Modal title={t.invoice} onClose={() => setForm(null)}>
          <div className="grid gap-3">
            <div><label className="label">{t.customer}</label><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div><label className="label">{t.address}</label><input className="input" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></div>
            <button className="btn btn-primary" onClick={() => setPrinting(true)}>🖨 {t.printInvoice}</button>
          </div>
        </Modal>
      )}
      {printing && (
        <PrintA4 onDone={() => { setPrinting(false); setForm(null); }}>
          <InvoiceDoc sale={sale} customer={form ?? {}} settings={settings} lang={lang} t={t} />
        </PrintA4>
      )}
    </>
  );
}
