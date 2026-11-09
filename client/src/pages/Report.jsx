import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../ctx.js';
import { pname } from '../i18n.js';
import { money, qtyFmt, today } from '../format.js';

export default function Report() {
  const { t, lang, user } = useApp();
  const [date, setDate] = useState(today());
  const [r, setR] = useState(null);
  useEffect(() => { api(`/reports/day?date=${date}`).then(setR).catch(() => setR(null)); }, [date]);

  const Card = ({ title, children }) => (
    <section className="card p-4"><h2 className="mb-2 font-bold">{title}</h2>{children}</section>
  );
  const Row = ({ a, b }) => <div className="flex justify-between border-b border-slate-100 py-2 last:border-0"><span>{a}</span><span className="font-semibold">{b}</span></div>;

  return (
    <div className="mx-auto h-full max-w-3xl space-y-3 overflow-y-auto p-3">
      <div className="flex items-center gap-2">
        <h1 className="flex-1 text-lg font-bold">{t.report}</h1>
        <input type="date" className="input !w-auto" value={date} max={today()} onChange={(e) => setDate(e.target.value || today())} />
      </div>
      {!r ? <p className="text-center text-slate-400">{t.loading}</p> : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="card bg-green-600 p-4 text-white">
              <div className="text-sm opacity-90">{t.revenue}</div>
              <div className="text-2xl font-extrabold">{money(r.total)}</div>
            </div>
            <div className="card p-4">
              <div className="text-sm text-slate-500">{t.salesCount}</div>
              <div className="text-2xl font-extrabold">{r.count}</div>
              {r.discounts > 0 && <div className="text-xs text-slate-500">{t.discounts}: {money(r.discounts)}</div>}
            </div>
          </div>

          <Card title={t.byPayment}>
            {r.byPayment.length ? r.byPayment.map((p) => (
              <Row key={p.payment_method} a={`${p.payment_method === 'cash' ? '💵 ' + t.cash : '📱 ' + t.mobile} (${p.count})`} b={money(p.total)} />
            )) : <p className="text-slate-400">{t.nothing}</p>}
          </Card>
          <Card title={t.byEmployee}>
            {r.byEmployee.length ? r.byEmployee.map((e) => <Row key={e.name} a={`${e.name} (${e.count})`} b={money(e.total)} />) : <p className="text-slate-400">{t.nothing}</p>}
          </Card>
          <Card title={t.topProducts}>
            {r.top.length ? r.top.map((p, i) => <Row key={i} a={`${pname(p, lang)} × ${qtyFmt(p.qty)}`} b={money(p.total)} />) : <p className="text-slate-400">{t.nothing}</p>}
          </Card>
          {r.voided.c > 0 && <Card title={`${t.cancelled} (${r.voided.c})`}><Row a={t.total} b={money(r.voided.t)} /></Card>}
          {r.lowStock.length > 0 && (
            <Card title={`⚠ ${t.lowStock}`}>
              {r.lowStock.map((p) => <Row key={p.id} a={pname(p, lang)} b={`${qtyFmt(p.stock)} ${t.perUnit[p.unit]}`} />)}
            </Card>
          )}
          {r.expiring.length > 0 && (
            <Card title={`⏳ ${t.expiringSoon}`}>
              {r.expiring.map((p) => <Row key={p.id} a={pname(p, lang)} b={p.expiry_date} />)}
            </Card>
          )}
          <div className="h-2" />
        </>
      )}
    </div>
  );
}
