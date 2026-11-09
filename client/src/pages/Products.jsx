import { useEffect, useMemo, useState } from 'react';
import { api, download } from '../api.js';
import { useApp } from '../ctx.js';
import { pname, cname, errText } from '../i18n.js';
import { money, qtyFmt } from '../format.js';
import { productsFromCsv } from '../csv.js';
import Modal from '../components/Modal.jsx';
import Scanner from '../components/Scanner.jsx';
import PhotoButton from '../components/PhotoButton.jsx';
import { analyzePhoto } from '../vision.js';
import Labels from './Labels.jsx';
import { normalizeCode } from '../barcode.js';

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const empty = { name_fr: '', name_ar: '', barcode: '', category_id: '', unit: 'piece', price: '', cost: '', stock: '', min_stock: '', expiry_date: '', tax_rate: '', active: true };

export default function Products() {
  const { products, categories, settings, lang, t, notify, reloadProducts } = useApp();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all'); // all | low
  const [edit, setEdit] = useState(null);
  const [stockFor, setStockFor] = useState(null);
  const [historyFor, setHistoryFor] = useState(null);
  const [importing, setImporting] = useState(false);
  const [view, setView] = useState('list'); // list | labels

  const list = useMemo(() => {
    const n = norm(q);
    return products.filter((p) => (!n || norm(p.name_fr).includes(n) || norm(p.name_ar).includes(n) || (p.barcode ?? '').includes(n)) &&
      (filter === 'all' || p.stock <= p.min_stock));
  }, [products, q, filter]);

  if (view === 'labels') return <Labels onBack={() => setView('list')} />;

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col p-3">
      <div className="mb-3 flex gap-2">
        <input className="input" placeholder={t.search} value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn btn-secondary whitespace-nowrap" onClick={() => setView('labels')} title={t.labels}>🏷 <span className="hidden sm:inline">{t.labels}</span></button>
        <button className="btn btn-primary whitespace-nowrap" onClick={() => setEdit({ ...empty })}>＋ {t.add}</button>
      </div>
      <div className="mb-3 flex items-center gap-2">
        <button className={`rounded-full px-4 py-2 text-sm font-medium ${filter === 'all' ? 'bg-green-600 text-white' : 'bg-white border border-slate-200'}`} onClick={() => setFilter('all')}>{t.all} ({products.length})</button>
        <button className={`rounded-full px-4 py-2 text-sm font-medium ${filter === 'low' ? 'bg-amber-500 text-white' : 'bg-white border border-slate-200'}`} onClick={() => setFilter('low')}>⚠ {t.lowStock}</button>
        <div className="flex-1" />
        <button className="text-sm text-slate-600 underline" onClick={() => setImporting(true)}>⬆ {t.importCsv}</button>
        <button className="text-sm text-slate-600 underline" onClick={() => download('/export/products.csv', 'produits.csv').catch(() => notify(t.generic, 'err'))}>⬇ {t.exportCsv}</button>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pb-3">
        {list.map((p) => (
          <div key={p.id} className={`card flex items-center gap-3 p-3 ${p.active ? '' : 'opacity-50'}`}>
            <button className="min-w-0 flex-1 text-start" onClick={() => setEdit({ ...p, active: !!p.active, tax_rate: p.tax_rate ?? '' })}>
              <div className="truncate font-semibold">{pname(p, lang)}</div>
              <div className="text-sm text-slate-500">{money(p.price)} / {t.perUnit[p.unit]}{p.barcode ? ` · ${p.barcode}` : ''} · <span className={p.image_count ? '' : 'text-amber-600'}>📸 {p.image_count}</span></div>
            </button>
            <button onClick={() => setStockFor(p)}
              className={`rounded-xl px-3 py-2 text-center ${p.stock <= p.min_stock ? 'bg-amber-100 text-amber-900' : 'bg-slate-100'}`}>
              <div className="text-lg font-bold">{qtyFmt(p.stock)}</div>
              <div className="text-xs">{t.perUnit[p.unit]}</div>
            </button>
          </div>
        ))}
        {!list.length && <p className="py-10 text-center text-slate-400">{t.notFound}</p>}
      </div>

      {edit && <ProductForm initial={edit} categories={categories} settings={settings} lang={lang} t={t}
        onClose={() => setEdit(null)}
        onHistory={() => { setHistoryFor(edit); setEdit(null); }}
        onSaved={() => { setEdit(null); reloadProducts(); notify(t.saved); }}
        onError={(e) => notify(errText(t, e.code), 'err')} />}

      {stockFor && <StockDialog product={stockFor} t={t} lang={lang} onClose={() => setStockFor(null)}
        onHistory={() => { setHistoryFor(stockFor); setStockFor(null); }}
        onSaved={() => { setStockFor(null); reloadProducts(); notify(t.saved); }}
        onError={(e) => notify(errText(t, e.code), 'err')} />}

      {historyFor && <MovementsDialog product={historyFor} onClose={() => setHistoryFor(null)} />}
      {importing && <ImportDialog onClose={() => setImporting(false)} onDone={reloadProducts} />}
    </div>
  );
}

function Field({ label, children }) {
  return <div><label className="label">{label}</label>{children}</div>;
}

function ProductForm({ initial, categories, settings, lang, t, onClose, onSaved, onError, onHistory }) {
  const [f, setF] = useState(initial);
  const [scan, setScan] = useState(false);
  const [busy, setBusy] = useState(false);
  const isNew = !initial.id;
  const [photos, setPhotos] = useState([]); // [{ id?, thumb, embedding? }] — celles sans id sont à envoyer à l'enregistrement
  const [removed, setRemoved] = useState([]);
  const [analyzing, setAnalyzing] = useState(0);
  const [autoBarcode, setAutoBarcode] = useState(false); // créer un code interne à l'enregistrement
  const [lots, setLots] = useState([]);
  useEffect(() => {
    if (isNew) return;
    api(`/products/${f.id}/images`).then(setPhotos).catch(() => {});
    api(`/products/${f.id}/lots`).then(setLots).catch(() => {});
  }, []); // eslint-disable-line
  const addFiles = async (files) => {
    const room = 12 - photos.length;
    if (files.length > room) onError({ code: 'too_many_images' });
    for (const file of files.slice(0, Math.max(room, 0))) {
      setAnalyzing((n) => n + 1);
      try { const a = await analyzePhoto(file); setPhotos((ps) => [...ps, { key: Math.random(), ...a }]); }
      catch (e) { console.error(e); onError({ code: 'vision_error' }); }
      finally { setAnalyzing((n) => n - 1); }
    }
  };
  const removePhoto = (ph) => { setPhotos((ps) => ps.filter((x) => x !== ph)); if (ph.id) setRemoved((r) => [...r, ph.id]); };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const num = (k) => (e) => setF({ ...f, [k]: e.target.value.replace(/[^\d.,]/g, '').replace(',', '.') });

  const save = async () => {
    setBusy(true);
    try {
      const body = { ...f, barcode: normalizeCode(f.barcode), category_id: f.category_id ? Number(f.category_id) : null };
      const saved = await api(isNew ? '/products' : `/products/${f.id}`, { method: isNew ? 'POST' : 'PUT', body });
      if (autoBarcode && !body.barcode) await api(`/products/${saved.id}/barcode`, { method: 'POST' });
      for (const id of removed) await api(`/product-images/${id}`, { method: 'DELETE' });
      for (const ph of photos.filter((x) => !x.id)) {
        await api(`/products/${saved.id}/images`, { method: 'POST', body: { embedding: ph.embedding, thumb: ph.thumb } });
      }
      onSaved();
    } catch (e) { onError(e); } finally { setBusy(false); }
  };

  return (
    <Modal title={isNew ? t.newProduct : t.edit} onClose={onClose}>
      <div className="grid gap-3">
        <Field label={t.nameFr}><input className="input" value={f.name_fr} onChange={set('name_fr')} autoFocus /></Field>
        <Field label={t.nameAr}><input className="input" dir="rtl" value={f.name_ar} onChange={set('name_ar')} /></Field>
        <Field label={t.barcode}>
          <div className="flex gap-2">
            <input className="input" inputMode="numeric" value={f.barcode ?? ''} onChange={(e) => { setAutoBarcode(false); set('barcode')(e); }}
              placeholder={autoBarcode ? t.barcodeAuto : ''} />
            <button className="btn btn-secondary" type="button" onClick={() => setScan(true)} title={t.scan}>📷</button>
          </div>
          {!f.barcode && (
            <button type="button" className={`mt-2 text-sm underline ${autoBarcode ? 'text-green-700' : 'text-slate-600'}`} onClick={() => setAutoBarcode((v) => !v)}>
              {autoBarcode ? '✓ ' : '🏷 '}{autoBarcode ? t.barcodeAuto : t.genBarcode}
            </button>
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t.category}>
            <select className="input" value={f.category_id ?? ''} onChange={set('category_id')}>
              <option value="">—</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.icon} {cname(c, lang)}</option>)}
            </select>
          </Field>
          <Field label={t.unit}>
            <select className="input" value={f.unit} onChange={set('unit')}>
              <option value="piece">{t.piece}</option><option value="kg">{t.kg}</option><option value="litre">{t.litre}</option>
            </select>
          </Field>
          <Field label={`${t.price} (${settings.currency})`}><input className="input" inputMode="numeric" value={f.price} onChange={num('price')} /></Field>
          <Field label={`${t.cost} (${settings.currency})`}><input className="input" inputMode="numeric" value={f.cost} onChange={num('cost')} /></Field>
          {isNew && <Field label={t.stock}><input className="input" inputMode="decimal" value={f.stock} onChange={num('stock')} /></Field>}
          <Field label={t.minStock}><input className="input" inputMode="decimal" value={f.min_stock} onChange={num('min_stock')} /></Field>
          {settings.tax_enabled && <Field label={`${t.taxRate} (%)`}><input className="input" inputMode="decimal" value={f.tax_rate ?? ''} placeholder={String(settings.tax_rate)} onChange={num('tax_rate')} /></Field>}
        </div>
        {lots.length > 1 ? (
          <div>
            <label className="label">{t.lots}</label>
            {lots.map((l) => (
              <div key={l.id} className="flex justify-between border-b border-slate-100 py-2 text-sm">
                <span>{l.expiry_date ?? '—'}{l.code ? ` · ${l.code}` : ''}</span><span className="font-semibold">{qtyFmt(l.qty)}</span>
              </div>
            ))}
          </div>
        ) : <Field label={t.expiry}><input type="date" className="input" value={f.expiry_date ?? ''} onChange={set('expiry_date')} /></Field>}
        <div>
          <label className="label">📸 {t.photoRef} ({photos.length}/12)</label>
          <p className="mb-2 text-sm text-slate-500">{t.photoHint}</p>
          <div className="flex flex-wrap gap-2">
            {photos.map((ph) => (
              <div key={ph.id ?? ph.key} className="relative">
                <img src={ph.thumb} alt="" className="h-20 w-20 rounded-xl object-cover" />
                <button type="button" onClick={() => removePhoto(ph)} className="absolute -end-2 -top-2 grid h-7 w-7 place-items-center rounded-full bg-red-600 text-white shadow" aria-label={t.delete}>×</button>
              </div>
            ))}
            {analyzing > 0 && <div className="grid h-20 w-20 place-items-center rounded-xl bg-slate-100 text-center text-xs text-slate-500">{t.analyzing}</div>}
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <PhotoButton onFile={(x) => addFiles([x])} className="btn btn-secondary !min-h-11" disabled={analyzing > 0 || photos.length >= 12}>📸 {t.addPhoto}</PhotoButton>
            <PhotoButton onFile={addFiles} camera={false} multiple className="btn btn-secondary !min-h-11" disabled={analyzing > 0 || photos.length >= 12}>🖼 {t.fromGallery}</PhotoButton>
          </div>
        </div>
        {!isNew && <label className="flex items-center gap-3"><input type="checkbox" className="h-5 w-5" checked={!!f.active} onChange={set('active')} /> {t.active}</label>}
        <button className="btn btn-primary" disabled={busy || analyzing > 0 || !f.name_fr.trim() || f.price === ''} onClick={save}>{t.save}</button>
        {!isNew && <button className="btn btn-secondary" onClick={onHistory}>📜 {t.stockHistory}</button>}
      </div>
      {scan && <Scanner onDetect={(c) => { setF({ ...f, barcode: c }); setScan(false); }} onClose={() => setScan(false)} />}
    </Modal>
  );
}

function StockDialog({ product, t, lang, onClose, onSaved, onError, onHistory }) {
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('restock');
  const [expiry, setExpiry] = useState('');
  const [lotCode, setLotCode] = useState('');
  const d = Number(delta);
  const save = async () => {
    try {
      await api(`/products/${product.id}/stock`, { method: 'POST', body: { delta: d, reason, expiry_date: d > 0 ? expiry : '', lot_code: d > 0 ? lotCode : '' } });
      onSaved();
    } catch (e) { onError(e); }
  };
  return (
    <Modal title={pname(product, lang)} onClose={onClose}>
      <p className="mb-3 text-slate-600">{t.stock}: <b>{qtyFmt(product.stock)} {t.perUnit[product.unit]}</b></p>
      <label className="label">{t.addQty}</label>
      <input className="input !text-2xl" autoFocus inputMode="decimal" value={delta} onChange={(e) => setDelta(e.target.value.replace(/[^\d.,-]/g, '').replace(',', '.'))} />
      <div className="my-3 grid grid-cols-3 gap-2">
        {[['restock', t.restock], ['adjustment', t.adjust], ['loss', '🗑']].map(([k, l]) => (
          <button key={k} className={`btn !min-h-10 ${reason === k ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setReason(k)}>{l}</button>
        ))}
      </div>
      {d > 0 && (
        <div className="mb-3 grid grid-cols-2 gap-2">
          <div><label className="label">{t.expiry}</label><input type="date" className="input !min-h-10 !py-1" value={expiry} onChange={(e) => setExpiry(e.target.value)} /></div>
          <div><label className="label">{t.lotCode}</label><input className="input !min-h-10 !py-1" value={lotCode} onChange={(e) => setLotCode(e.target.value)} /></div>
        </div>
      )}
      <button className="btn btn-primary w-full" disabled={!Number.isFinite(d) || d === 0} onClick={save}>{t.save}</button>
      <button className="btn btn-secondary mt-2 w-full" onClick={onHistory}>📜 {t.stockHistory}</button>
    </Modal>
  );
}

function MovementsDialog({ product, onClose }) {
  const { t, lang } = useApp();
  const [rows, setRows] = useState(null);
  useEffect(() => { api(`/stock-movements?productId=${product.id}`).then(setRows).catch(() => setRows([])); }, [product.id]);
  const LABEL = { sale: t.moveSale, void: t.voided, refund: t.refunded, restock: t.restock, adjustment: t.adjust, loss: t.moveLoss, initial: t.moveInitial, purchase: t.purchase };
  return (
    <Modal title={`📜 ${pname(product, lang)}`} onClose={onClose}>
      {rows === null && <p className="py-6 text-center text-slate-400">{t.loading}</p>}
      {rows?.length === 0 && <p className="py-6 text-center text-slate-400">{t.nothing}</p>}
      {rows?.map((m) => (
        <div key={m.id} className="flex justify-between gap-2 border-b border-slate-100 py-2 text-sm">
          <span className="min-w-0">
            <span className="font-medium">{LABEL[m.reason] ?? m.reason}{m.ref ? ` · ${m.ref.replace('sale:', '#').replace('purchase:', '#')}` : ''}</span>
            <span className="block text-slate-500">{m.created_at.slice(0, 16)}{m.employee_name ? ` · ${m.employee_name}` : ''}</span>
          </span>
          <span className={`whitespace-nowrap font-semibold ${m.delta > 0 ? 'text-green-700' : 'text-red-600'}`}>{m.delta > 0 ? '+' : ''}{qtyFmt(m.delta)}</span>
        </div>
      ))}
    </Modal>
  );
}

function ImportDialog({ onClose, onDone }) {
  const { t, notify } = useApp();
  const [parsed, setParsed] = useState(null);
  const [updateStock, setUpdateStock] = useState(false);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setResult(null);
    setParsed(productsFromCsv(await file.text()));
  };
  const send = async () => {
    setBusy(true);
    try {
      setResult(await api('/products/import', { method: 'POST', body: { rows: parsed.rows, updateStock } }));
      setParsed(null);
      onDone();
    } catch (err) { notify(errText(t, err.code), 'err'); } finally { setBusy(false); }
  };

  return (
    <Modal title={`⬆ ${t.importCsv}`} onClose={onClose}>
      <p className="mb-3 text-sm text-slate-600">{t.importHint}</p>
      <input type="file" accept=".csv,text/csv" className="input" onChange={onFile} />
      {parsed && (
        <div className="mt-3 grid gap-3">
          <p className="font-medium">{parsed.rows.length} {t.linesFound}</p>
          {parsed.ignored.length > 0 && <p className="text-sm text-amber-700">{t.columnsIgnored} : {parsed.ignored.join(', ')}</p>}
          <label className="flex items-center gap-3"><input type="checkbox" className="h-5 w-5" checked={updateStock} onChange={(e) => setUpdateStock(e.target.checked)} />{t.importUpdateStock}</label>
          <button className="btn btn-primary" disabled={busy || !parsed.rows.length} onClick={send}>{t.importCsv}</button>
        </div>
      )}
      {result && (
        <div className="mt-3 rounded-xl bg-slate-100 p-3 text-sm">
          <p>{t.created} : <b>{result.created}</b> · {t.updated} : <b>{result.updated}</b> · {t.errors} : <b>{result.errors.length}</b></p>
          {result.errors.slice(0, 20).map((e, i) => <p key={i} className="text-red-700">{t.line} {e.line} : {errText(t, e.error)}</p>)}
        </div>
      )}
    </Modal>
  );
}
