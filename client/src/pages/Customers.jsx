import { useMemo, useState } from 'react';
import { api, download } from '../api.js';
import { useApp } from '../ctx.js';
import { errText, payLabel } from '../i18n.js';
import { money } from '../format.js';
import { debtText, smsUrl, whatsappUrl } from '../share.js';
import Modal from '../components/Modal.jsx';

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const digits = (s) => s.replace(/\D/g, '');
const empty = { name: '', phone: '', address: '', note: '', credit_limit: '', active: true };
const RECEIVE = ['cash', 'wave', 'orange_money', 'mobile'];

export default function Customers() {
  const { customers, user, t, notify, reloadCustomers } = useApp();
  const isManager = user.role === 'manager';
  const [q, setQ] = useState('');
  const [onlyDebt, setOnlyDebt] = useState(false);
  const [form, setForm] = useState(null);
  const [detail, setDetail] = useState(null);

  const list = useMemo(() => {
    const n = norm(q.trim());
    return customers.filter((c) => (!n || norm(c.name).includes(n) || c.phone.includes(n)) && (!onlyDebt || c.balance > 0));
  }, [customers, q, onlyDebt]);
  const totalDebt = customers.reduce((a, c) => a + Math.max(c.balance, 0), 0);

  const openDetail = async (c) => {
    try { setDetail(await api(`/customers/${c.id}`)); } catch (e) { notify(e.status === 0 ? t.needServer : errText(t, e.code), 'err'); }
  };
  const save = async () => {
    try {
      if (form.id) setDetail(await api(`/customers/${form.id}`, { method: 'PUT', body: form }));
      else await api('/customers', { method: 'POST', body: form });
      setForm(null);
      reloadCustomers();
      notify(t.saved);
    } catch (e) { notify(e.status === 0 ? t.needServer : errText(t, e.code), 'err'); }
  };

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col p-3">
      <div className="mb-3 flex gap-2">
        <input className="input" placeholder={t.searchCustomer} value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn btn-primary whitespace-nowrap" onClick={() => setForm({ ...empty })}>＋ {t.add}</button>
      </div>
      <div className="card mb-3 flex items-center justify-between p-3">
        <span className="text-slate-600">{t.totalDebts}</span>
        <span className="text-xl font-extrabold text-red-600">{money(totalDebt)}</span>
      </div>
      <div className="mb-3 flex items-center gap-2">
        <button className={`rounded-full px-4 py-2 text-sm font-medium ${!onlyDebt ? 'bg-green-600 text-white' : 'border border-slate-200 bg-white'}`} onClick={() => setOnlyDebt(false)}>{t.all} ({customers.length})</button>
        <button className={`rounded-full px-4 py-2 text-sm font-medium ${onlyDebt ? 'bg-amber-500 text-white' : 'border border-slate-200 bg-white'}`} onClick={() => setOnlyDebt(true)}>📒 {t.withDebt}</button>
        <div className="flex-1" />
        {isManager && <button className="text-sm text-slate-600 underline" onClick={() => download('/export/customers.csv', 'clients.csv').catch(() => notify(t.generic, 'err'))}>⬇ CSV</button>}
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pb-3">
        {list.map((c) => (
          <button key={c.id} onClick={() => openDetail(c)} className={`card flex w-full items-center justify-between gap-3 p-3 text-start ${c.active ? '' : 'opacity-50'}`}>
            <span className="min-w-0"><span className="block truncate font-semibold">{c.name}</span><span className="text-sm text-slate-500" dir="ltr">{c.phone}</span></span>
            <span className={`whitespace-nowrap font-bold ${c.balance > 0 ? 'text-red-600' : 'text-slate-400'}`}>{money(c.balance)}</span>
          </button>
        ))}
        {!list.length && <p className="py-10 text-center text-slate-400">{t.nothing}</p>}
      </div>

      {detail && !form && <CustomerDetail customer={detail} isManager={isManager} onClose={() => setDetail(null)}
        onChange={(c) => { setDetail(c); reloadCustomers(); }}
        onEdit={() => setForm({ ...detail, active: !!detail.active })} />}

      {form && (
        <Modal title={form.id ? t.edit : t.newCustomer} onClose={() => setForm(null)}>
          <div className="grid gap-3">
            <div><label className="label">{t.name}</label><input className="input" autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div><label className="label">{t.phone}</label><input className="input" dir="ltr" inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
            <div><label className="label">{t.address}</label><input className="input" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></div>
            {isManager && <div><label className="label">{t.creditLimit}</label><input className="input" inputMode="numeric" value={form.credit_limit} placeholder="0" onChange={(e) => setForm({ ...form, credit_limit: digits(e.target.value) })} /></div>}
            <div><label className="label">{t.note}</label><input className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></div>
            {form.id && <label className="flex items-center gap-3"><input type="checkbox" className="h-5 w-5" checked={!!form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />{t.active}</label>}
            <button className="btn btn-primary" disabled={!form.name.trim()} onClick={save}>{t.save}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function CustomerDetail({ customer, isManager, onClose, onChange, onEdit }) {
  const { settings, t, notify } = useApp();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [reference, setReference] = useState('');
  const [adjust, setAdjust] = useState(null);
  const [busy, setBusy] = useState(false);

  const LEDGER = { sale: t.ledgerSale, payment: t.ledgerPayment, void: t.voided, refund: t.refunded, adjust: t.ledgerAdjust };
  const message = debtText(customer, { t, shop: settings.shop_name });

  const pay = async () => {
    setBusy(true);
    try {
      onChange(await api(`/customers/${customer.id}/payments`, { method: 'POST', body: { amount: Number(amount), method, reference } }));
      setAmount(''); setReference('');
      notify(t.saved);
    } catch (e) { notify(e.status === 0 ? t.needServer : errText(t, e.code), 'err'); } finally { setBusy(false); }
  };
  const doAdjust = async () => {
    try {
      onChange(await api(`/customers/${customer.id}/adjust`, { method: 'POST', body: { amount: Number(adjust.amount), note: adjust.note } }));
      setAdjust(null);
    } catch (e) { notify(errText(t, e.code), 'err'); }
  };

  return (
    <Modal title={customer.name} onClose={onClose}>
      <div className="mb-3 flex items-center justify-between rounded-xl bg-slate-100 p-3">
        <span>{t.balanceDue}</span>
        <span className={`text-2xl font-extrabold ${customer.balance > 0 ? 'text-red-600' : 'text-green-700'}`}>{money(customer.balance)}</span>
      </div>
      {customer.phone && <p className="mb-1 text-sm text-slate-600" dir="ltr">{customer.phone}</p>}
      {customer.address && <p className="mb-1 text-sm text-slate-600">{customer.address}</p>}
      {customer.credit_limit > 0 && <p className="mb-1 text-sm text-slate-600">{t.creditLimit} : {money(customer.credit_limit)}</p>}
      {customer.note && <p className="mb-1 text-sm text-slate-600">{customer.note}</p>}

      {customer.balance > 0 && (
        <div className="my-3 space-y-2 rounded-xl border border-slate-200 p-3">
          <h3 className="font-bold">{t.recordPayment}</h3>
          <input className="input" inputMode="numeric" placeholder={t.amount} value={amount} onChange={(e) => setAmount(digits(e.target.value))} />
          <div className="grid grid-cols-2 gap-2">
            {RECEIVE.map((m) => <button key={m} className={`btn !min-h-10 !py-1 text-sm ${method === m ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMethod(m)}>{payLabel(t, m)}</button>)}
          </div>
          {method !== 'cash' && <input className="input !min-h-10 !py-1" dir="ltr" placeholder={t.reference} value={reference} onChange={(e) => setReference(e.target.value)} />}
          <button className="btn btn-primary w-full" disabled={busy || !(Number(amount) > 0)} onClick={pay}>{t.confirm}</button>
          {customer.phone && (
            <div className="grid grid-cols-2 gap-2">
              <a className="btn btn-secondary !min-h-10 !py-1 text-sm" target="_blank" rel="noreferrer" href={whatsappUrl(customer.phone, message, settings.phone_prefix)}>💬 {t.remind}</a>
              <a className="btn btn-secondary !min-h-10 !py-1 text-sm" href={smsUrl(customer.phone, message)}>✉️ {t.sms}</a>
            </div>
          )}
        </div>
      )}

      <div className="my-3 flex gap-2">
        {isManager && <button className="btn btn-secondary !min-h-10 flex-1 !py-1 text-sm" onClick={onEdit}>{t.edit}</button>}
        {isManager && <button className="btn btn-secondary !min-h-10 flex-1 !py-1 text-sm" onClick={() => setAdjust({ amount: '', note: '' })}>{t.adjustBalance}</button>}
      </div>
      {adjust && (
        <div className="mb-3 space-y-2 rounded-xl border border-slate-200 p-3">
          <input className="input !min-h-10 !py-1" inputMode="numeric" dir="ltr" placeholder="+1000 / -500" value={adjust.amount} onChange={(e) => setAdjust({ ...adjust, amount: e.target.value.replace(/[^\d-]/g, '') })} />
          <input className="input !min-h-10 !py-1" placeholder={t.note} value={adjust.note} onChange={(e) => setAdjust({ ...adjust, note: e.target.value })} />
          <button className="btn btn-primary !min-h-10 w-full !py-1" disabled={!Number(adjust.amount)} onClick={doAdjust}>{t.confirm}</button>
        </div>
      )}

      <h3 className="mb-1 mt-4 font-bold">{t.accountHistory}</h3>
      {!customer.ledger.length && <p className="py-3 text-center text-slate-400">{t.nothing}</p>}
      {customer.ledger.map((l) => (
        <div key={l.id} className="flex justify-between gap-2 border-b border-slate-100 py-2 text-sm">
          <span className="min-w-0">
            <span className="font-medium">{LEDGER[l.kind]}{l.sale_id ? ` #${l.sale_id}` : ''}{l.method ? ` · ${payLabel(t, l.method)}` : ''}</span>
            <span className="block text-slate-500">{l.created_at.slice(0, 16)}{l.employee_name ? ` · ${l.employee_name}` : ''}{l.note ? ` · ${l.note}` : ''}</span>
          </span>
          <span className={`whitespace-nowrap font-semibold ${l.amount > 0 ? 'text-red-600' : 'text-green-700'}`}>{l.amount > 0 ? '+' : ''}{money(l.amount)}</span>
        </div>
      ))}
    </Modal>
  );
}
