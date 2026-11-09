import { useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../ctx.js';
import { cname, errText } from '../i18n.js';
import Modal from '../components/Modal.jsx';

export default function Categories() {
  const { categories, products, lang, t, notify, reloadAll } = useApp();
  const [form, setForm] = useState(null);
  const countOf = (id) => products.filter((p) => p.category_id === id).length;

  const save = async () => {
    try {
      await api(form.id ? `/categories/${form.id}` : '/categories', { method: form.id ? 'PUT' : 'POST', body: form });
      setForm(null);
      await reloadAll();
      notify(t.saved);
    } catch (e) { notify(errText(t, e.code), 'err'); }
  };
  const remove = async () => {
    if (!window.confirm(`${t.delete} « ${form.name_fr} » ?`)) return;
    try {
      await api(`/categories/${form.id}`, { method: 'DELETE' });
      setForm(null);
      await reloadAll();
      notify(t.saved);
    } catch (e) { notify(errText(t, e.code), 'err'); }
  };

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col p-3">
      <button className="btn btn-primary mb-3 self-end" onClick={() => setForm({ name_fr: '', name_ar: '', icon: '🛒' })}>＋ {t.add}</button>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pb-3">
        {categories.map((c) => (
          <button key={c.id} onClick={() => setForm({ ...c })} className="card flex w-full items-center justify-between p-3 text-start">
            <span className="font-semibold">{c.icon} {cname(c, lang)}</span>
            <span className="text-sm text-slate-500">{countOf(c.id)}</span>
          </button>
        ))}
      </div>
      {form && (
        <Modal title={form.id ? t.edit : t.add} onClose={() => setForm(null)}>
          <div className="grid gap-3">
            <div><label className="label">{t.nameFr}</label><input className="input" autoFocus value={form.name_fr} onChange={(e) => setForm({ ...form, name_fr: e.target.value })} /></div>
            <div><label className="label">{t.nameAr}</label><input className="input" dir="rtl" value={form.name_ar} onChange={(e) => setForm({ ...form, name_ar: e.target.value })} /></div>
            <div><label className="label">{t.icon}</label><input className="input" value={form.icon} onChange={(e) => setForm({ ...form, icon: e.target.value })} /></div>
            <button className="btn btn-primary" disabled={!form.name_fr.trim()} onClick={save}>{t.save}</button>
            {form.id && <button className="btn btn-danger" onClick={remove}>{t.delete}</button>}
            {form.id && countOf(form.id) > 0 && <p className="text-sm text-slate-500">{t.categoryDeleteHint}</p>}
          </div>
        </Modal>
      )}
    </div>
  );
}
