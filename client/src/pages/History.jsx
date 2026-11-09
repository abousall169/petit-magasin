import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../ctx.js';
import { errText } from '../i18n.js';
import { money, today } from '../format.js';
import Modal from '../components/Modal.jsx';
import Receipt from '../components/Receipt.jsx';

export default function History() {
  const { user, t, notify, reloadProducts, printSale } = useApp();
  const isManager = user.role === 'manager';
  const [date, setDate] = useState(today());
  const [sales, setSales] = useState(null);
  const [open, setOpen] = useState(null);
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');

  const load = useCallback(() => {
    api(`/sales?date=${date}`).then(setSales).catch(() => setSales([]));
  }, [date]);
  useEffect(load, [load]);

  const openSale = (s) => api(`/sales/${s.id}`).then(setOpen);

  const doVoid = async () => {
    try {
      const s = await api(`/sales/${open.id}/void`, { method: 'POST', body: { reason } });
      setOpen(s); setVoiding(false); setReason(''); load(); reloadProducts();
    } catch (e) { notify(errText(t, e.code), 'err'); }
  };

  const sum = (sales ?? []).filter((s) => s.status === 'completed').reduce((a, s) => a + s.total, 0);

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col p-3">
      <div className="mb-3 flex items-center gap-2">
        <h1 className="flex-1 text-lg font-bold">{t.history}</h1>
        {isManager && <input type="date" className="input !w-auto" value={date} max={today()} onChange={(e) => setDate(e.target.value || today())} />}
      </div>
      <div className="card mb-3 flex items-center justify-between p-3">
        <span className="text-slate-600">{t.revenue}</span>
        <span className="text-xl font-extrabold text-green-700">{money(sum)}</span>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pb-3">
        {sales === null ? <p className="text-center text-slate-400">{t.loading}</p> : !sales.length ? <p className="py-10 text-center text-slate-400">{t.noSales}</p> :
          sales.map((s) => (
            <button key={s.id} onClick={() => openSale(s)} className="card flex w-full items-center justify-between p-3 text-start">
              <div>
                <div className="font-semibold">#{s.id} · {s.created_at.slice(11, 16)} {s.status === 'voided' && <span className="ms-1 rounded bg-red-100 px-2 text-xs text-red-700">{t.voided}</span>}</div>
                <div className="text-sm text-slate-500">{s.employee_name} · {s.payment_method === 'cash' ? '💵' : '📱'}</div>
              </div>
              <div className={`text-lg font-bold ${s.status === 'voided' ? 'text-slate-400 line-through' : ''}`}>{money(s.total)}</div>
            </button>
          ))}
      </div>

      {open && (
        <Modal title={`${t.sale} #${open.id}`} onClose={() => { setOpen(null); setVoiding(false); }}>
          <Receipt sale={open} />
          {open.status === 'voided' && <p className="mt-3 text-sm text-red-700">{t.voidedBy} #{open.voided_by} : {open.void_reason}</p>}
          <div className="mt-4 grid gap-3">
            <button className="btn btn-secondary" onClick={() => printSale(open)}>🖨 {t.print}</button>
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
    </div>
  );
}
