import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../ctx.js';
import { errText } from '../i18n.js';
import { money } from '../format.js';
import Modal from '../components/Modal.jsx';

const empty = { name: '', phone: '', address: '', note: '', active: true };

export default function Suppliers() {
  const { t, notify } = useApp();
  const [list, setList] = useState([]);
  const [form, setForm] = useState(null);
  const load = useCallback(() => { api('/suppliers').then(setList).catch(() => {}); }, []);
  useEffect(load, [load]);

  const save = async () => {
    try {
      await api(form.id ? `/suppliers/${form.id}` : '/suppliers', { method: form.id ? 'PUT' : 'POST', body: form });
      setForm(null);
      load();
      notify(t.saved);
    } catch (e) { notify(errText(t, e.code), 'err'); }
  };

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col p-3">
      <button className="btn btn-primary mb-3 self-end" onClick={() => setForm({ ...empty })}>＋ {t.add}</button>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pb-3">
        {list.map((s) => (
          <button key={s.id} onClick={() => setForm({ ...s, active: !!s.active })} className={`card flex w-full items-center justify-between gap-3 p-3 text-start ${s.active ? '' : 'opacity-50'}`}>
            <span className="min-w-0"><span className="block truncate font-semibold">{s.name}</span><span className="text-sm text-slate-500" dir="ltr">{s.phone}</span></span>
            <span className={`whitespace-nowrap font-bold ${s.balance > 0 ? 'text-red-600' : 'text-slate-400'}`}>{money(s.balance)}</span>
          </button>
        ))}
        {!list.length && <p className="py-10 text-center text-slate-400">{t.nothing}</p>}
      </div>
      {form && (
        <Modal title={form.id ? t.edit : t.newSupplier} onClose={() => setForm(null)}>
          <div className="grid gap-3">
            <div><label className="label">{t.name}</label><input className="input" autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div><label className="label">{t.phone}</label><input className="input" dir="ltr" inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
            <div><label className="label">{t.address}</label><input className="input" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></div>
            <div><label className="label">{t.note}</label><input className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></div>
            {form.id && <label className="flex items-center gap-3"><input type="checkbox" className="h-5 w-5" checked={!!form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />{t.active}</label>}
            <button className="btn btn-primary" disabled={!form.name.trim()} onClick={save}>{t.save}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
