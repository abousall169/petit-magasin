import { useMemo, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../ctx.js';
import { errText } from '../i18n.js';
import { money } from '../format.js';
import Modal from './Modal.jsx';

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Choix d'un client à la caisse, avec création rapide. */
export default function CustomerPicker({ onPick, onClose }) {
  const { customers, t, notify, reloadCustomers } = useApp();
  const [q, setQ] = useState('');
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);

  const list = useMemo(() => {
    const n = norm(q.trim());
    return customers.filter((c) => c.active && (!n || norm(c.name).includes(n) || c.phone.includes(n)));
  }, [customers, q]);

  const create = async () => {
    setBusy(true);
    try {
      const c = await api('/customers', { method: 'POST', body: form });
      await reloadCustomers();
      onPick(c);
    } catch (e) {
      notify(e.status === 0 ? t.needServer : errText(t, e.code), 'err');
    } finally { setBusy(false); }
  };

  if (form) {
    return (
      <Modal title={t.newCustomer} onClose={() => setForm(null)}>
        <div className="grid gap-3">
          <div><label className="label">{t.name}</label><input className="input" autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div><label className="label">{t.phone}</label><input className="input" dir="ltr" inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
          <button className="btn btn-primary" disabled={busy || !form.name.trim()} onClick={create}>{t.save}</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={t.chooseCustomer} onClose={onClose}>
      <div className="mb-3 flex gap-2">
        <input className="input" autoFocus value={q} placeholder={t.searchCustomer} onChange={(e) => setQ(e.target.value)} />
        <button className="btn btn-primary whitespace-nowrap" onClick={() => setForm({ name: q.trim(), phone: '' })}>＋</button>
      </div>
      <button className="mb-1 w-full rounded-xl bg-slate-100 p-3 text-start font-medium" onClick={() => onPick(null)}>{t.noCustomer}</button>
      {list.map((c) => (
        <button key={c.id} onClick={() => onPick(c)} className="flex w-full items-center justify-between gap-3 border-b border-slate-100 p-3 text-start">
          <span className="min-w-0"><span className="block truncate font-medium">{c.name}</span><span className="text-sm text-slate-500" dir="ltr">{c.phone}</span></span>
          {c.balance > 0 && <span className="whitespace-nowrap text-sm font-semibold text-red-600">{money(c.balance)}</span>}
        </button>
      ))}
      {!list.length && <p className="py-6 text-center text-slate-400">{t.nothing}</p>}
    </Modal>
  );
}
