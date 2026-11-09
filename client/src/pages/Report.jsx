import { useEffect, useState } from 'react';
import { api, download } from '../api.js';
import { useApp } from '../ctx.js';
import { payLabel, pname } from '../i18n.js';
import { money, qtyFmt, today, isoDate } from '../format.js';
import PrintA4 from '../components/PrintA4.jsx';

const RANGES = {
  today: () => [today(), today()],
  week: () => {
    const d = new Date();
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return [isoDate(d), today()];
  },
  month: () => {
    const d = new Date();
    return [isoDate(new Date(d.getFullYear(), d.getMonth(), 1)), today()];
  },
  year: () => [`${new Date().getFullYear()}-01-01`, today()],
};

const Card = ({ title, children }) => (
  <section className="card p-4"><h2 className="mb-2 font-bold">{title}</h2>{children}</section>
);
const Row = ({ a, b, strong }) => (
  <div className={`flex justify-between gap-3 border-b border-slate-100 py-2 last:border-0 ${strong ? 'font-bold' : ''}`}><span>{a}</span><span className="whitespace-nowrap font-semibold">{b}</span></div>
);

export default function Report() {
  const { t, lang, settings, notify } = useApp();
  const [range, setRange] = useState('today');
  const [[from, to], setDates] = useState(RANGES.today());
  const [r, setR] = useState(null);
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    setR(null);
    api(`/reports?from=${from}&to=${to}`).then(setR).catch(() => setR(null));
  }, [from, to]);

  const choose = (id) => { setRange(id); if (RANGES[id]) setDates(RANGES[id]()); };
  const setFrom = (v) => { if (v && v <= to) setDates([v, to]); };
  const setTo = (v) => { if (v && v >= from) setDates([from, v]); };
  const exportCsv = (kind, name) => download(`/export/${kind}.csv?from=${from}&to=${to}`, `${name}-${from}-${to}.csv`).catch(() => notify(t.generic, 'err'));
  const title = from === to ? from : `${from} → ${to}`;

  return (
    <div className="mx-auto h-full max-w-3xl space-y-3 overflow-y-auto p-3">
      <div className="flex gap-2 overflow-x-auto">
        {[['today', t.today], ['week', t.week], ['month', t.month], ['year', t.year], ['custom', t.custom]].map(([id, l]) => (
          <button key={id} onClick={() => choose(id)} className={`whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium ${range === id ? 'bg-green-600 text-white' : 'border border-slate-200 bg-white'}`}>{l}</button>
        ))}
      </div>
      {range === 'custom' && (
        <div className="grid grid-cols-2 gap-2">
          <input type="date" className="input" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label={t.from} />
          <input type="date" className="input" value={to} min={from} max={today()} onChange={(e) => setTo(e.target.value)} aria-label={t.to} />
        </div>
      )}
      {!r ? <p className="text-center text-slate-400">{t.loading}</p> : (
        <>
          <p className="text-center text-sm text-slate-500">{title}</p>
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

          <Card title={`💰 ${t.profit}`}>
            <Row a={t.revenue} b={money(r.total)} />
            {r.tax > 0 && <Row a={t.taxCollected} b={`- ${money(r.tax)}`} />}
            <Row a={t.costOfGoods} b={`- ${money(r.cost)}`} />
            <Row a={t.grossMargin} b={money(r.margin)} strong />
            <Row a={t.expenses} b={`- ${money(r.expenses)}`} />
            <Row a={t.netProfit} b={<span className={r.net < 0 ? 'text-red-600' : 'text-green-700'}>{money(r.net)}</span>} strong />
            {r.missingCost > 0 && <p className="mt-2 rounded-lg bg-amber-50 p-2 text-sm text-amber-900">⚠ {r.missingCost} {t.missingCostWarn}</p>}
          </Card>

          <Card title={t.byPayment}>
            {r.byPayment.length ? r.byPayment.map((p) => (
              <Row key={p.payment_method} a={`${payLabel(t, p.payment_method)} (${p.count})`} b={money(p.total)} />
            )) : <p className="text-slate-400">{t.nothing}</p>}
          </Card>
          <Card title={`📒 ${t.customerCredit}`}>
            <Row a={t.creditGiven} b={money(r.creditGiven)} />
            <Row a={t.creditRepaid} b={money(r.creditPaid)} />
            <Row a={t.totalDebts} b={money(r.debts)} strong />
            {r.payables > 0 && <Row a={t.supplierDebts} b={money(r.payables)} />}
          </Card>
          <Card title={t.byEmployee}>
            {r.byEmployee.length ? r.byEmployee.map((e) => <Row key={e.name} a={`${e.name} (${e.count})`} b={money(e.total)} />) : <p className="text-slate-400">{t.nothing}</p>}
          </Card>
          <Card title={t.topProducts}>
            {r.top.length ? r.top.map((p, i) => <Row key={i} a={`${pname(p, lang)} × ${qtyFmt(p.qty)}`} b={money(p.total)} />) : <p className="text-slate-400">{t.nothing}</p>}
          </Card>
          {r.series.length > 1 && (
            <Card title={r.grouped === 'month' ? t.perMonth : t.perDay}>
              {r.series.map((x) => <Row key={x.period} a={`${x.period} (${x.count})`} b={money(x.revenue)} />)}
            </Card>
          )}
          {r.expensesByCategory.length > 0 && (
            <Card title={t.expenses}>
              {r.expensesByCategory.map((x) => <Row key={x.category} a={x.category || t.other} b={money(x.total)} />)}
            </Card>
          )}
          {(r.voided.c > 0 || r.refunds.count > 0) && (
            <Card title={t.cancelled}>
              {r.voided.c > 0 && <Row a={`${t.voided} (${r.voided.c})`} b={money(r.voided.t)} />}
              {r.refunds.count > 0 && <Row a={`${t.refunded} (${r.refunds.count})`} b={money(r.refunds.total)} />}
            </Card>
          )}
          {r.toReview > 0 && <p className="rounded-xl bg-amber-50 p-3 text-sm font-medium text-amber-900">⚠ {t.toReview} : {r.toReview}</p>}
          {r.lowStock.length > 0 && (
            <Card title={`⚠ ${t.lowStock}`}>
              {r.lowStock.map((p) => <Row key={p.id} a={pname(p, lang)} b={`${qtyFmt(p.stock)} ${t.perUnit[p.unit]}`} />)}
            </Card>
          )}
          {r.expiring.length > 0 && (
            <Card title={`⏳ ${t.expiringSoon}`}>
              {r.expiring.map((p, i) => <Row key={i} a={`${pname(p, lang)}${p.code ? ` (${p.code})` : ''} × ${qtyFmt(p.stock)}`} b={p.expiry_date} />)}
            </Card>
          )}
          <div className="grid grid-cols-3 gap-2 pb-3">
            <button className="btn btn-secondary !px-2 text-sm" onClick={() => setPrinting(true)}>🖨 {t.printReport}</button>
            <button className="btn btn-secondary !px-2 text-sm" onClick={() => exportCsv('report', 'rapport')}>⬇ {t.report}</button>
            <button className="btn btn-secondary !px-2 text-sm" onClick={() => exportCsv('sales', 'ventes')}>⬇ {t.salesCount}</button>
          </div>
          {printing && (
            <PrintA4 onDone={() => setPrinting(false)}>
              <ReportPrint r={r} title={title} shop={settings.shop_name} t={t} lang={lang} />
            </PrintA4>
          )}
        </>
      )}
    </div>
  );
}

function ReportPrint({ r, title, shop, t, lang }) {
  const row = { display: 'flex', justifyContent: 'space-between', gap: 16, padding: '3px 0', borderBottom: '1px solid #ccc' };
  const P = ({ a, b, bold }) => <div style={{ ...row, fontWeight: bold ? 700 : 400 }}><span>{a}</span><span>{b}</span></div>;
  const H = ({ children }) => <h2 style={{ fontSize: 14, fontWeight: 700, margin: '14px 0 4px' }}>{children}</h2>;
  return (
    <div dir={lang === 'ar' ? 'rtl' : 'ltr'} style={{ color: '#000', fontSize: 12 }}>
      <h1 style={{ fontSize: 18, fontWeight: 700 }}>{shop} — {t.report}</h1>
      <div>{title}</div>
      <H>{t.profit}</H>
      <P a={`${t.salesCount}`} b={r.count} />
      <P a={t.revenue} b={money(r.total)} />
      {r.tax > 0 && <P a={t.taxCollected} b={money(r.tax)} />}
      <P a={t.costOfGoods} b={money(r.cost)} />
      <P a={t.grossMargin} b={money(r.margin)} bold />
      <P a={t.expenses} b={money(r.expenses)} />
      <P a={t.netProfit} b={money(r.net)} bold />
      <H>{t.byPayment}</H>
      {r.byPayment.map((p) => <P key={p.payment_method} a={payLabel(t, p.payment_method)} b={money(p.total)} />)}
      <H>{t.byEmployee}</H>
      {r.byEmployee.map((e) => <P key={e.name} a={`${e.name} (${e.count})`} b={money(e.total)} />)}
      <H>{t.topProducts}</H>
      {r.top.map((p, i) => <P key={i} a={`${pname(p, lang)} × ${qtyFmt(p.qty)}`} b={money(p.total)} />)}
      {r.series.length > 1 && <H>{r.grouped === 'month' ? t.perMonth : t.perDay}</H>}
      {r.series.length > 1 && r.series.map((x) => <P key={x.period} a={`${x.period} (${x.count})`} b={money(x.revenue)} />)}
    </div>
  );
}
