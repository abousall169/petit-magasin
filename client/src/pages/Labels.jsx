import { useMemo, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../ctx.js';
import { pname, errText } from '../i18n.js';
import { encode } from '../barcode.js';
import { Label, LabelSheets, LAYOUTS, printSheets } from '../components/Label.jsx';
import { printLabelBitmap } from '../printer.js';

/** Étiquettes de codes-barres : choix des produits et des quantités, impression A4 ou sur l'imprimante de tickets. */
export default function Labels({ onBack }) {
  const { products, settings, lang, t, notify, reloadProducts } = useApp();
  const [sel, setSel] = useState({}); // productId -> nombre d'étiquettes
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [layoutId, setLayoutId] = useState('4x10');
  const [showPrice, setShowPrice] = useState(true);
  const [showAr, setShowAr] = useState(true);
  const [cutLines, setCutLines] = useState(true);
  const [busy, setBusy] = useState(null); // texte de progression

  const active = useMemo(() => products.filter((p) => p.active), [products]);
  const missing = active.filter((p) => !p.barcode);
  const list = onlyMissing ? missing : active;
  const layout = LAYOUTS.find((l) => l.id === layoutId);

  const items = useMemo(() => active.flatMap((p) => (sel[p.id] > 0 && encode(p.barcode) ? Array(sel[p.id]).fill(p) : [])), [active, sel]);
  const setQty = (id, q) => setSel((s) => ({ ...s, [id]: Math.max(0, Math.min(99, q)) }));

  const generate = async () => {
    try {
      const r = await api('/products/assign-barcodes', { method: 'POST' });
      await reloadProducts();
      notify(`${r.assigned} ${t.codesCreated}`);
    } catch (e) { notify(errText(t, e.code), 'err'); }
  };

  const printThermal = async () => {
    if (items.length > 60 && !window.confirm(`${items.length} ${t.labelsCount} ?`)) return;
    try {
      for (let i = 0; i < items.length; i++) {
        setBusy(`${t.printingLabels} ${i + 1}/${items.length}`);
        await printLabelBitmap(items[i], { lang, showPrice, showAr, paper: settings.paper_width });
      }
      notify(t.printSent);
    } catch (e) {
      notify(`${t.printFailed}${e.data?.detail ? ` : ${e.data.detail}` : ''}`, 'err');
    } finally { setBusy(null); }
  };

  const total = items.length;
  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col p-3">
      <div className="mb-2 flex items-center gap-3">
        <button className="btn btn-secondary !min-h-10 !px-3" onClick={onBack}>{lang === 'ar' ? '→' : '←'}</button>
        <h1 className="flex-1 text-lg font-bold">🏷 {t.labels}</h1>
      </div>
      <p className="mb-2 text-sm text-slate-500">{t.labelsHint}</p>

      <div className="mb-2 flex flex-wrap items-center gap-2">
        <button className={`rounded-full px-4 py-2 text-sm font-medium ${!onlyMissing ? 'bg-green-600 text-white' : 'border border-slate-200 bg-white'}`} onClick={() => setOnlyMissing(false)}>{t.all} ({active.length})</button>
        <button className={`rounded-full px-4 py-2 text-sm font-medium ${onlyMissing ? 'bg-amber-500 text-white' : 'border border-slate-200 bg-white'}`} onClick={() => setOnlyMissing(true)}>{t.withoutBarcode} ({missing.length})</button>
        <div className="flex-1" />
        {missing.length > 0 && <button className="btn btn-primary !min-h-10 !py-1" onClick={generate}>🏷 {t.genMissing} ({missing.length})</button>}
      </div>

      <div className="mb-2 flex gap-3 text-sm">
        <button className="text-green-700 underline" onClick={() => setSel(Object.fromEntries(list.filter((p) => encode(p.barcode)).map((p) => [p.id, sel[p.id] || 1])))}>{t.selectAll}</button>
        <button className="text-slate-500 underline" onClick={() => setSel({})}>{t.selectNone}</button>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pb-2">
        {list.map((p) => {
          const ok = !!encode(p.barcode);
          const q = sel[p.id] || 0;
          return (
            <div key={p.id} className={`card flex items-center gap-3 p-3 ${q ? 'ring-2 ring-green-600' : ''}`}>
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold">{pname(p, lang)}</div>
                <div className={`text-sm ${ok ? 'text-slate-500' : 'text-amber-600'}`}>{p.barcode ? (ok ? p.barcode : `${p.barcode} — ${t.cantEncode}`) : t.noCodeYet}</div>
              </div>
              <div className="flex items-center gap-1">
                <button className="btn btn-secondary !min-h-10 !w-10 !p-0 text-xl" disabled={!ok || !q} onClick={() => setQty(p.id, q - 1)}>−</button>
                <span className="w-8 text-center text-lg font-bold">{q}</span>
                <button className="btn btn-secondary !min-h-10 !w-10 !p-0 text-xl" disabled={!ok} onClick={() => setQty(p.id, q + 1)}>+</button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="space-y-3 border-t border-slate-200 pt-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <select className="input !min-h-10 !py-1 sm:col-span-2" value={layoutId} onChange={(e) => setLayoutId(e.target.value)} aria-label={t.labelFormat}>
            {LAYOUTS.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-5 w-5" checked={showPrice} onChange={(e) => setShowPrice(e.target.checked)} />{t.showPrice}</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-5 w-5" checked={showAr} onChange={(e) => setShowAr(e.target.checked)} />{t.showArabicName}</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-5 w-5" checked={cutLines} onChange={(e) => setCutLines(e.target.checked)} />{t.cutLines}</label>
        </div>
        {items[0] && (
          <div className="flex items-center gap-3">
            <span className="text-sm text-slate-500">{t.preview}</span>
            <div className="overflow-hidden rounded border border-slate-300"><Label product={items[0]} lang={lang} showPrice={showPrice} showAr={showAr} w={200 / layout.cols} h={287 / layout.rows} cutLines={cutLines} /></div>
          </div>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          <button className="btn btn-primary" disabled={!total || !!busy} onClick={printSheets}>🖨 {t.printSheet} ({total})</button>
          <button className="btn btn-secondary" disabled={!total || !!busy || !settings.printer} onClick={printThermal}>{busy ?? `🧾 ${t.printThermal}`}</button>
        </div>
      </div>
      {total > 0 && <LabelSheets items={items} layout={layout} lang={lang} showPrice={showPrice} showAr={showAr} cutLines={cutLines} />}
    </div>
  );
}
