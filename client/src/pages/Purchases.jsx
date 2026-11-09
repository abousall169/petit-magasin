import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../ctx.js';
import { errText, payLabel, pname } from '../i18n.js';
import { money, qtyFmt } from '../format.js';
import Modal from '../components/Modal.jsx';

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const digits = (s) => s.replace(/\D/g, '');
const decimal = (s) => s.replace(/[^\d.,]/g, '').replace(',', '.');
const OUT_METHODS = ['cash', 'wave', 'orange_money', 'mobile', 'bank'];
const STATUS_STYLE = { ordered: 'bg-amber-100 text-amber-800', received: 'bg-green-100 text-green-800', cancelled: 'bg-slate-200 text-slate-600' };

export default function Purchases() {
  const { t, notify, reloadProducts } = useApp();
  const [list, setList] = useState(null);
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(null);

  const load = useCallback(() => {
    api(`/purchases${status ? `?status=${status}` : ''}`).then(setList).catch(() => setList([]));
  }, [status]);
  useEffect(load, [load]);

  const label = { ordered: t.statusOrdered, received: t.statusReceived, cancelled: t.statusCancelled };
  const openOne = (p) => api(`/purchases/${p.id}`).then(setOpen).catch((e) => notify(errText(t, e.code), 'err'));
  const act = async (path, body) => {
    try {
      setOpen(await api(`/purchases/${open.id}/${path}`, { method: 'POST', ...(body ? { body } : {}) }));
      load();
      reloadProducts();
    } catch (e) { notify(errText(t, e.code), 'err'); }
  };

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col p-3">
      <div className="mb-3 flex items-center gap-2 overflow-x-auto">
        {[['', t.all], ['ordered', t.statusOrdered], ['received', t.statusReceived]].map(([id, l]) => (
          <button key={id} className={`whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium ${status === id ? 'bg-green-600 text-white' : 'border border-slate-200 bg-white'}`} onClick={() => setStatus(id)}>{l}</button>
        ))}
        <div className="flex-1" />
        <button className="btn btn-primary whitespace-nowrap" onClick={() => setCreating(true)}>＋ {t.add}</button>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pb-3">
        {list === null ? <p className="text-center text-slate-400">{t.loading}</p> : !list.length ? <p className="py-10 text-center text-slate-400">{t.nothing}</p> :
          list.map((p) => (
            <button key={p.id} onClick={() => openOne(p)} className="card flex w-full items-center justify-between gap-3 p-3 text-start">
              <span className="min-w-0">
                <span className="block truncate font-semibold">#{p.id}{p.reference ? ` · ${p.reference}` : ''}<span className={`ms-2 rounded px-2 text-xs ${STATUS_STYLE[p.status]}`}>{label[p.status]}</span></span>
                <span className="block truncate text-sm text-slate-500">{p.supplier_name ?? '—'} · {p.created_at.slice(0, 10)}</span>
              </span>
              <span className="text-end">
                <span className="block whitespace-nowrap font-bold">{money(p.total)}</span>
                {p.status !== 'cancelled' && p.total - p.paid > 0 && <span className="block whitespace-nowrap text-xs text-red-600">{t.toPay}: {money(p.total - p.paid)}</span>}
              </span>
            </button>
          ))}
      </div>
      {creating && <NewPurchase onClose={() => setCreating(false)} onSaved={() => { setCreating(false); load(); reloadProducts(); notify(t.saved); }} />}
      {open && <PurchaseDetail purchase={open} label={label} onClose={() => setOpen(null)} onAct={act} />}
    </div>
  );
}

function PurchaseDetail({ purchase, label, onClose, onAct }) {
  const { t, lang } = useApp();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const due = purchase.total - purchase.paid;
  return (
    <Modal title={`#${purchase.id}${purchase.reference ? ` · ${purchase.reference}` : ''}`} onClose={onClose}>
      <p className="mb-2 text-sm text-slate-600">{purchase.supplier_name ?? '—'} · {label[purchase.status]} · {purchase.created_at.slice(0, 16)}</p>
      {purchase.items.map((it) => (
        <div key={it.id} className="flex justify-between gap-2 border-b border-slate-100 py-2 text-sm">
          <span className="min-w-0">
            <span className="font-medium">{pname(it, lang)}</span>
            <span className="block text-slate-500">{qtyFmt(it.qty)} × {qtyFmt(it.unit_cost)}{it.expiry_date ? ` · ${it.expiry_date}` : ''}{it.lot_code ? ` · ${it.lot_code}` : ''}</span>
          </span>
          <span className="whitespace-nowrap font-semibold">{money(Math.round(it.qty * it.unit_cost))}</span>
        </div>
      ))}
      <div className="mt-3 flex justify-between text-lg font-bold"><span>{t.total}</span><span>{money(purchase.total)}</span></div>
      <div className="flex justify-between text-sm"><span>{t.paid}</span><span>{money(purchase.paid)}</span></div>
      {purchase.status !== 'cancelled' && <div className="flex justify-between text-sm font-semibold text-red-600"><span>{t.toPay}</span><span>{money(due)}</span></div>}
      {purchase.status !== 'cancelled' && due > 0 && (
        <div className="mt-3 space-y-2 rounded-xl border border-slate-200 p-3">
          <div className="flex gap-2">
            <input className="input !min-h-10 !py-1" inputMode="numeric" placeholder={t.amount} value={amount} onChange={(e) => setAmount(digits(e.target.value))} />
            <select className="input !min-h-10 !py-1" value={method} onChange={(e) => setMethod(e.target.value)}>
              {OUT_METHODS.map((m) => <option key={m} value={m}>{payLabel(t, m)}</option>)}
            </select>
          </div>
          <button className="btn btn-secondary !min-h-10 w-full !py-1" disabled={!(Number(amount) > 0) || Number(amount) > due} onClick={() => { onAct('payments', { amount: Number(amount), method }); setAmount(''); }}>{t.recordPayment}</button>
        </div>
      )}
      {purchase.status === 'ordered' && (
        <div className="mt-4 grid gap-3">
          <button className="btn btn-primary" onClick={() => onAct('receive')}>📦 {t.receiveGoods}</button>
          <button className="btn btn-danger" onClick={() => window.confirm(`${t.cancelOrder} ?`) && onAct('cancel')}>{t.cancelOrder}</button>
        </div>
      )}
    </Modal>
  );
}

function NewPurchase({ onClose, onSaved }) {
  const { products, t, lang, notify } = useApp();
  const [suppliers, setSuppliers] = useState([]);
  const [supplierId, setSupplierId] = useState('');
  const [reference, setReference] = useState('');
  const [items, setItems] = useState([]);
  const [q, setQ] = useState('');
  const [received, setReceived] = useState(true);
  const [paid, setPaid] = useState('');
  const [method, setMethod] = useState('cash');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api('/suppliers').then((l) => setSuppliers(l.filter((s) => s.active))).catch(() => {}); }, []);

  const found = useMemo(() => {
    const n = norm(q.trim());
    if (!n) return [];
    return products.filter((p) => !items.some((x) => x.product_id === p.id) &&
      (norm(p.name_fr).includes(n) || norm(p.name_ar).includes(n) || (p.barcode ?? '').includes(n))).slice(0, 8);
  }, [products, q, items]);

  const add = (p) => { setItems([...items, { product_id: p.id, p, qty: '', unit_cost: p.cost ? String(p.cost) : '', expiry_date: '', lot_code: '' }]); setQ(''); };
  const set = (i, patch) => setItems(items.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const total = items.reduce((a, x) => a + Math.round((Number(x.qty) || 0) * (Number(x.unit_cost) || 0)), 0);
  const valid = items.length > 0 && items.every((x) => Number(x.qty) > 0 && (x.p.unit !== 'piece' || Number.isInteger(Number(x.qty)))) && Number(paid || 0) <= total;

  const save = async () => {
    setBusy(true);
    try {
      await api('/purchases', { method: 'POST', body: {
        supplier_id: supplierId || null, reference, receive: received, paid: Number(paid) || 0, method,
        items: items.map(({ product_id, qty, unit_cost, expiry_date, lot_code }) => ({ product_id, qty: Number(qty), unit_cost: Number(unit_cost) || 0, expiry_date, lot_code })),
      } });
      onSaved();
    } catch (e) { notify(errText(t, e.code), 'err'); } finally { setBusy(false); }
  };

  return (
    <Modal title={t.newPurchase} onClose={onClose} wide>
      <div className="grid gap-3">
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">{t.supplier}</label>
            <select className="input" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">—</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select></div>
          <div><label className="label">{t.invoiceRef}</label><input className="input" value={reference} onChange={(e) => setReference(e.target.value)} /></div>
        </div>
        <div>
          <label className="label">{t.addProduct}</label>
          <input className="input" placeholder={t.search} value={q} onChange={(e) => setQ(e.target.value)} />
          {found.map((p) => <button key={p.id} className="block w-full border-b border-slate-100 p-2 text-start" onClick={() => add(p)}>{pname(p, lang)}</button>)}
        </div>
        {items.map((x, i) => (
          <div key={x.product_id} className="rounded-xl border border-slate-200 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="truncate font-semibold">{pname(x.p, lang)}</span>
              <button className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-slate-100" aria-label={t.delete} onClick={() => setItems(items.filter((_, j) => j !== i))}>×</button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div><label className="label">{t.qty} ({t.perUnit[x.p.unit]})</label><input className="input !min-h-10 !py-1" inputMode="decimal" value={x.qty} onChange={(e) => set(i, { qty: decimal(e.target.value) })} /></div>
              <div><label className="label">{t.cost}</label><input className="input !min-h-10 !py-1" inputMode="numeric" value={x.unit_cost} onChange={(e) => set(i, { unit_cost: digits(e.target.value) })} /></div>
              <div><label className="label">{t.expiry}</label><input type="date" className="input !min-h-10 !py-1" value={x.expiry_date} onChange={(e) => set(i, { expiry_date: e.target.value })} /></div>
              <div><label className="label">{t.lotCode}</label><input className="input !min-h-10 !py-1" value={x.lot_code} onChange={(e) => set(i, { lot_code: e.target.value })} /></div>
            </div>
          </div>
        ))}
        <div className="text-end text-xl font-bold">{money(total)}</div>
        <label className="flex items-center gap-3"><input type="checkbox" className="h-5 w-5" checked={received} onChange={(e) => setReceived(e.target.checked)} />{t.goodsReceivedNow}</label>
        <div className="grid grid-cols-2 gap-2">
          <div><label className="label">{t.paidNow}</label><input className="input" inputMode="numeric" placeholder="0" value={paid} onChange={(e) => setPaid(digits(e.target.value))} /></div>
          <div><label className="label">{t.payment}</label>
            <select className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
              {OUT_METHODS.map((m) => <option key={m} value={m}>{payLabel(t, m)}</option>)}
            </select></div>
        </div>
        <button className="btn btn-primary" disabled={busy || !valid} onClick={save}>{t.save}</button>
      </div>
    </Modal>
  );
}
