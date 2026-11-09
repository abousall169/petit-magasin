import { useCallback, useEffect, useState } from 'react';
import { api, download } from '../api.js';
import { useApp } from '../ctx.js';
import { errText, payLabel } from '../i18n.js';
import { money, today, isoDate } from '../format.js';
import Modal from '../components/Modal.jsx';

const METHODS = ['cash', 'wave', 'orange_money', 'mobile', 'bank'];
const monthStart = () => { const d = new Date(); return isoDate(new Date(d.getFullYear(), d.getMonth(), 1)); };

export default function Expenses() {
  const { t, notify } = useApp();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [list, setList] = useState(null);
  const [form, setForm] = useState(null);
  const load = useCallback(() => { api(`/expenses?from=${from}&to=${to}`).then(setList).catch(() => setList([])); }, [from, to]);
  useEffect(load, [load]);

  const categories = t.expenseCategories;
  const total = (list ?? []).reduce((a, x) => a + x.amount, 0);
  const save = async () => {
    try {
      await api('/expenses', { method: 'POST', body: { ...form, amount: Number(form.amount) } });
      setForm(null);
      load();
      notify(t.saved);
    } catch (e) { notify(errText(t, e.code), 'err'); }
  };
  const remove = async (x) => {
    if (!window.confirm(`${t.delete} ?`)) return;
    try { await api(`/expenses/${x.id}`, { method: 'DELETE' }); load(); } catch (e) { notify(errText(t, e.code), 'err'); }
  };

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col p-3">
      <div className="mb-3 grid grid-cols-2 gap-2">
        <input type="date" className="input" aria-label={t.from} value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
        <input type="date" className="input" aria-label={t.to} value={to} min={from} max={today()} onChange={(e) => e.target.value && setTo(e.target.value)} />
      </div>
      <div className="card mb-3 flex items-center justify-between p-3">
        <span className="text-slate-600">{t.total}</span>
        <span className="text-xl font-extrabold text-red-600">{money(total)}</span>
      </div>
      <div className="mb-3 flex items-center justify-between">
        <button className="text-sm text-slate-600 underline" onClick={() => download(`/export/expenses.csv?from=${from}&to=${to}`, `depenses-${from}-${to}.csv`).catch(() => notify(t.generic, 'err'))}>⬇ {t.exportCsv}</button>
        <button className="btn btn-primary" onClick={() => setForm({ category: categories[0], amount: '', method: 'cash', note: '', expense_date: today() })}>＋ {t.add}</button>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pb-3">
        {list?.map((x) => (
          <div key={x.id} className="card flex items-center justify-between gap-3 p-3">
            <div className="min-w-0">
              <div className="truncate font-semibold">{x.category || t.other}</div>
              <div className="truncate text-sm text-slate-500">{x.expense_date} · {payLabel(t, x.method)}{x.note ? ` · ${x.note}` : ''}</div>
            </div>
            <div className="flex items-center gap-2">
              <span className="whitespace-nowrap font-bold">{money(x.amount)}</span>
              <button className="grid h-8 w-8 place-items-center rounded-full bg-slate-100" aria-label={t.delete} onClick={() => remove(x)}>×</button>
            </div>
          </div>
        ))}
        {list?.length === 0 && <p className="py-10 text-center text-slate-400">{t.nothing}</p>}
      </div>
      {form && (
        <Modal title={t.newExpense} onClose={() => setForm(null)}>
          <div className="grid gap-3">
            <div><label className="label">{t.amount}</label><input className="input !text-2xl" autoFocus inputMode="numeric" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value.replace(/\D/g, '') })} /></div>
            <div><label className="label">{t.category}</label>
              <select className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select></div>
            <div><label className="label">{t.payment}</label>
              <select className="input" value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
                {METHODS.map((m) => <option key={m} value={m}>{payLabel(t, m)}</option>)}
              </select></div>
            <div><label className="label">{t.date}</label><input type="date" className="input" value={form.expense_date} max={today()} onChange={(e) => setForm({ ...form, expense_date: e.target.value })} /></div>
            <input className="input" placeholder={t.note} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            <button className="btn btn-primary" disabled={!(Number(form.amount) > 0) || !form.expense_date} onClick={save}>{t.save}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
