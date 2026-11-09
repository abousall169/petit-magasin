import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../ctx.js';
import { errText } from '../i18n.js';
import { money } from '../format.js';

const digits = (s) => s.replace(/\D/g, '');
const Row = ({ a, b, strong }) => (
  <div className={`flex justify-between gap-3 border-b border-slate-100 py-2 last:border-0 ${strong ? 'font-bold' : ''}`}><span>{a}</span><span className="whitespace-nowrap font-semibold">{b}</span></div>
);

export default function Cash() {
  const { t, notify } = useApp();
  const [data, setData] = useState(null);
  const [opening, setOpening] = useState('');
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const load = useCallback(() => { api('/cash').then(setData).catch(() => {}); }, []);
  useEffect(load, [load]);

  const run = async (path, body, after) => {
    try { await api(path, { method: 'POST', body }); after?.(); load(); notify(t.saved); }
    catch (e) { notify(errText(t, e.code), 'err'); }
  };

  if (!data) return <p className="p-6 text-center text-slate-400">{t.loading}</p>;
  const b = data.breakdown;
  const diff = counted === '' || !b ? null : Number(counted) - b.expected;
  const diffText = (v) => (v === 0 ? t.cashExact : v > 0 ? `${t.cashOver} ${money(v)}` : `${t.cashShort} ${money(-v)}`);

  return (
    <div className="mx-auto h-full max-w-3xl space-y-3 overflow-y-auto p-3">
      {!data.session ? (
        <section className="card space-y-3 p-4">
          <h2 className="font-bold">🔓 {t.openCash}</h2>
          <div><label className="label">{t.openingFloat}</label><input className="input" inputMode="numeric" placeholder="0" value={opening} onChange={(e) => setOpening(digits(e.target.value))} /></div>
          <button className="btn btn-primary w-full" onClick={() => run('/cash/open', { opening_float: Number(opening) || 0 }, () => setOpening(''))}>{t.openCash}</button>
        </section>
      ) : (
        <section className="card space-y-1 p-4">
          <h2 className="mb-1 font-bold">🟢 {t.cashOpenSince} {data.session.opened_at.slice(0, 16)}</h2>
          <Row a={t.openingFloat} b={money(b.opening_float)} />
          <Row a={t.cashSales} b={`+ ${money(b.sales)}`} />
          <Row a={t.creditRepaid} b={`+ ${money(b.repayments)}`} />
          <Row a={t.refunded} b={`- ${money(b.refunds)}`} />
          <Row a={t.expenses} b={`- ${money(b.expenses)}`} />
          <Row a={t.supplierPayments} b={`- ${money(b.suppliers)}`} />
          <Row a={t.cashExpected} b={money(b.expected)} strong />
          <div className="space-y-3 pt-3">
            <div><label className="label">{t.cashCounted}</label><input className="input !text-2xl" inputMode="numeric" value={counted} onChange={(e) => setCounted(digits(e.target.value))} /></div>
            {diff != null && <p className={`rounded-xl p-3 text-center font-bold ${diff === 0 ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-700'}`}>{diffText(diff)}</p>}
            <input className="input" placeholder={t.note} value={note} onChange={(e) => setNote(e.target.value)} />
            <button className="btn btn-danger w-full" disabled={counted === ''} onClick={() => run('/cash/close', { counted: Number(counted), note }, () => { setCounted(''); setNote(''); })}>🔒 {t.closeCash}</button>
          </div>
        </section>
      )}

      <section className="card p-4">
        <h2 className="mb-2 font-bold">{t.previousClosings}</h2>
        {!data.history.length && <p className="text-slate-400">{t.nothing}</p>}
        {data.history.map((s) => (
          <div key={s.id} className="border-b border-slate-100 py-2 text-sm last:border-0">
            <div className="flex justify-between gap-2">
              <span className="font-medium">{s.closed_at.slice(0, 16)}</span>
              <span className={`font-bold ${s.difference === 0 ? 'text-green-700' : 'text-red-600'}`}>{diffText(s.difference)}</span>
            </div>
            <div className="text-slate-500">{t.cashExpected}: {money(s.expected)} · {t.cashCounted}: {money(s.counted)}{s.closed_by_name ? ` · ${s.closed_by_name}` : ''}{s.note ? ` · ${s.note}` : ''}</div>
          </div>
        ))}
      </section>
    </div>
  );
}
