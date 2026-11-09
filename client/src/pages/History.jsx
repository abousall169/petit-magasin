import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../ctx.js';
import { errText, pname, payLabel } from '../i18n.js';
import { money, qtyFmt, today } from '../format.js';
import Modal from '../components/Modal.jsx';
import Receipt from '../components/Receipt.jsx';
import ShareButtons from '../components/ShareButtons.jsx';
import InvoiceButton from '../components/Invoice.jsx';

const ICONS = { cash: '💵', wave: '🌊', orange_money: '🟠', mobile: '📱', credit: '📒', mixed: '➗' };
const round3 = (n) => Math.round(n * 1000) / 1000;

export default function History() {
  const { user, t, notify, reloadProducts, reloadCustomers, printSale } = useApp();
  const isManager = user.role === 'manager';
  const [date, setDate] = useState(today());
  const [reviewOnly, setReviewOnly] = useState(false);
  const [toReview, setToReview] = useState(0);
  const [sales, setSales] = useState(null);
  const [open, setOpen] = useState(null);
  const [voiding, setVoiding] = useState(false);
  const [refunding, setRefunding] = useState(false);
  const [reason, setReason] = useState('');

  const load = useCallback(() => {
    api(reviewOnly ? '/sales?review=1' : `/sales?date=${date}`).then(setSales).catch(() => setSales([]));
    if (isManager) api('/sales?review=1').then((l) => setToReview(l.length)).catch(() => {});
  }, [date, reviewOnly, isManager]);
  useEffect(load, [load]);

  const openSale = (s) => api(`/sales/${s.id}`).then(setOpen);
  const afterChange = (s) => { setOpen(s); load(); reloadProducts(); reloadCustomers(); };

  const doVoid = async () => {
    try {
      afterChange(await api(`/sales/${open.id}/void`, { method: 'POST', body: { reason } }));
      setVoiding(false); setReason('');
    } catch (e) { notify(errText(t, e.code), 'err'); }
  };

  const markReviewed = async () => {
    try { afterChange(await api(`/sales/${open.id}/reviewed`, { method: 'POST' })); } catch (e) { notify(errText(t, e.code), 'err'); }
  };

  const sum = (sales ?? []).filter((s) => s.status === 'completed').reduce((a, s) => a + s.total - (s.refunded_total ?? 0), 0);
  const close = () => { setOpen(null); setVoiding(false); setRefunding(false); };

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col p-3">
      <div className="mb-3 flex items-center gap-2">
        <h1 className="flex-1 text-lg font-bold">{t.history}</h1>
        {isManager && toReview > 0 && (
          <button className={`rounded-full px-3 py-2 text-sm font-medium ${reviewOnly ? 'bg-amber-500 text-white' : 'border border-amber-400 bg-amber-50 text-amber-900'}`} onClick={() => setReviewOnly(!reviewOnly)}>
            ⚠ {t.toReview} ({toReview})
          </button>
        )}
        {isManager && <input type="date" className="input !w-auto" value={date} max={today()} onChange={(e) => { setDate(e.target.value || today()); setReviewOnly(false); }} />}
      </div>
      <div className="card mb-3 flex items-center justify-between p-3">
        <span className="text-slate-600">{t.revenue}</span>
        <span className="text-xl font-extrabold text-green-700">{money(sum)}</span>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pb-3">
        {sales === null ? <p className="text-center text-slate-400">{t.loading}</p> : !sales.length ? <p className="py-10 text-center text-slate-400">{t.noSales}</p> :
          sales.map((s) => (
            <button key={s.id} onClick={() => openSale(s)} className="card flex w-full items-center justify-between p-3 text-start">
              <div className="min-w-0">
                <div className="font-semibold">
                  #{s.id} · {reviewOnly ? s.created_at.slice(0, 16) : s.created_at.slice(11, 16)}
                  {s.status === 'voided' && <span className="ms-1 rounded bg-red-100 px-2 text-xs text-red-700">{t.voided}</span>}
                  {s.needs_review && <span className="ms-1 rounded bg-amber-100 px-2 text-xs text-amber-800">⚠</span>}
                  {s.refunded_total > 0 && <span className="ms-1 rounded bg-slate-200 px-2 text-xs">{t.refunded}</span>}
                </div>
                <div className="truncate text-sm text-slate-500">{s.employee_name} · {ICONS[s.payment_method] ?? '💳'}{s.customer_name ? ` · ${s.customer_name}` : ''}</div>
              </div>
              <div className={`text-lg font-bold ${s.status === 'voided' ? 'text-slate-400 line-through' : ''}`}>{money(s.total)}</div>
            </button>
          ))}
      </div>

      {open && !refunding && (
        <Modal title={`${t.sale} #${open.id}`} onClose={close}>
          <Receipt sale={open} />
          {open.needs_review && (
            <div className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
              <p className="font-medium">⚠ {t.reviewReasons} : {open.needs_review.split(',').map((r) => t[`review_${r}`] ?? r).join(', ')}</p>
              {isManager && <button className="btn btn-secondary mt-2 !min-h-9 w-full !py-1" onClick={markReviewed}>✓ {t.markReviewed}</button>}
            </div>
          )}
          {open.status === 'voided' && <p className="mt-3 text-sm text-red-700">{t.voidedBy} #{open.voided_by} : {open.void_reason}</p>}
          {open.refunds?.map((r) => (
            <p key={r.id} className="mt-2 text-sm text-slate-600">↩ {r.created_at.slice(0, 16)} · {r.employee_name} · {money(r.amount)} ({payLabel(t, r.method)}) : {r.reason}</p>
          ))}
          <div className="mt-4 grid gap-3">
            <button className="btn btn-secondary" onClick={() => printSale(open)}>🖨 {t.print}</button>
            <ShareButtons sale={open} />
            <InvoiceButton sale={open} />
            {isManager && open.status === 'completed' && !voiding && (
              <button className="btn btn-secondary" onClick={() => setRefunding(true)}>↩ {t.refundItems}</button>
            )}
            {isManager && open.status === 'completed' && !voiding && (
              <button className="btn btn-danger" onClick={() => setVoiding(true)}>{t.voidSale}</button>
            )}
            {voiding && (
              <>
                <input className="input" autoFocus placeholder={t.voidReason} value={reason} onChange={(e) => setReason(e.target.value)} />
                <button className="btn btn-danger" disabled={!reason.trim()} onClick={doVoid}>{t.voidSale}</button>
              </>
            )}
          </div>
        </Modal>
      )}
      {open && refunding && <RefundDialog sale={open} onClose={() => setRefunding(false)} onDone={(s) => { afterChange(s); setRefunding(false); }} />}
    </div>
  );
}

function RefundDialog({ sale, onClose, onDone }) {
  const { t, lang, notify } = useApp();
  const firstMethod = sale.payment_method === 'mixed' ? 'cash' : sale.payment_method;
  const [qtys, setQtys] = useState({});
  const [method, setMethod] = useState(firstMethod);
  const [restock, setRestock] = useState(true);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const left = (it) => round3(it.qty - it.returned_qty);
  const items = sale.items
    .map((it) => ({ saleItemId: it.id, qty: Number(String(qtys[it.id] ?? '').replace(',', '.')) || 0, it }))
    .filter((x) => x.qty > 0);
  const invalid = items.some((x) => x.qty > left(x.it));
  const ratio = sale.subtotal > 0 ? sale.total / sale.subtotal : 0;
  const estimate = items.reduce((a, x) => a + Math.round((x.it.line_total * ratio * x.qty) / x.it.qty), 0);
  const methods = ['cash', 'wave', 'orange_money', 'mobile', ...(sale.customer_id ? ['credit'] : [])];

  const submit = async () => {
    setBusy(true);
    try {
      onDone(await api(`/sales/${sale.id}/refund`, { method: 'POST', body: { items: items.map(({ saleItemId, qty }) => ({ saleItemId, qty })), method, restock, reason } }));
    } catch (e) { notify(errText(t, e.code), 'err'); } finally { setBusy(false); }
  };

  return (
    <Modal title={`↩ ${t.refundItems} #${sale.id}`} onClose={onClose}>
      <div className="grid gap-3">
        {sale.items.map((it) => (
          <div key={it.id} className="flex items-center justify-between gap-3 border-b border-slate-100 pb-2">
            <div className="min-w-0">
              <div className="truncate font-medium">{pname(it, lang)}</div>
              <div className="text-sm text-slate-500">{t.maxQty}: {qtyFmt(left(it))}</div>
            </div>
            <input className="input !w-24" inputMode="decimal" disabled={left(it) <= 0} placeholder="0" value={qtys[it.id] ?? ''}
              onChange={(e) => setQtys({ ...qtys, [it.id]: e.target.value.replace(/[^\d.,]/g, '') })} />
          </div>
        ))}
        <div>
          <label className="label">{t.refundMethod}</label>
          <select className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
            {methods.map((m) => <option key={m} value={m}>{payLabel(t, m)}</option>)}
          </select>
        </div>
        <label className="flex items-center gap-3"><input type="checkbox" className="h-5 w-5" checked={restock} onChange={(e) => setRestock(e.target.checked)} />{t.restockItems}</label>
        <input className="input" placeholder={t.reason} value={reason} onChange={(e) => setReason(e.target.value)} />
        {estimate > 0 && <div className="text-end text-xl font-bold text-green-700">≈ {money(estimate)}</div>}
        <button className="btn btn-primary" disabled={busy || !items.length || invalid || !reason.trim()} onClick={submit}>{t.confirm}</button>
      </div>
    </Modal>
  );
}
