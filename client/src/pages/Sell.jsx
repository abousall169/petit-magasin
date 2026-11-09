import { useMemo, useRef, useState } from 'react';
import { api, enqueueSale, readQueue } from '../api.js';
import { useApp } from '../ctx.js';
import { pname, cname, errText } from '../i18n.js';
import { money, qtyFmt } from '../format.js';
import Modal from '../components/Modal.jsx';
import Scanner from '../components/Scanner.jsx';
import Receipt from '../components/Receipt.jsx';
import PhotoButton from '../components/PhotoButton.jsx';
import Recognize from '../components/Recognize.jsx';
import { sameCode } from '../barcode.js';

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

export default function Sell() {
  const { products, categories, settings, user, lang, t, notify, reloadProducts, setPending, printSale } = useApp();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState(null);
  const [cart, setCart] = useState([]); // [{ productId, qty }]
  const [showCart, setShowCart] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [photo, setPhoto] = useState(null); // photo à reconnaître
  const [qtyFor, setQtyFor] = useState(null); // produit au poids/volume à saisir
  const [discount, setDiscount] = useState('');
  const [method, setMethod] = useState('cash');
  const [cashGiven, setCashGiven] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // vente terminée (ticket)
  const clientId = useRef(newId()); // identifiant unique de la vente en cours (évite les doublons)

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const allowNeg = settings.allow_negative_stock;

  const filtered = useMemo(() => {
    const n = norm(q.trim());
    return products.filter((p) => p.active && (cat == null || p.category_id === cat) &&
      (!n || norm(p.name_fr).includes(n) || norm(p.name_ar).includes(n) || (p.barcode ?? '').includes(n)));
  }, [products, q, cat]);

  const lines = cart.map((c) => ({ ...c, p: byId.get(c.productId) })).filter((l) => l.p);
  const subtotal = lines.reduce((s, l) => s + Math.round(l.qty * l.p.price), 0);
  const disc = Math.min(Math.max(Math.round(Number(discount) || 0), 0), subtotal);
  const total = subtotal - disc;
  const given = Number(cashGiven) || 0;
  const count = lines.length;

  const inCart = (id) => cart.find((c) => c.productId === id)?.qty ?? 0;

  const addProduct = (p, qty = null) => {
    if (p.unit !== 'piece' && qty == null) return setQtyFor(p);
    const add = qty ?? 1;
    const have = inCart(p.id);
    if (!allowNeg && have + add > p.stock) return notify(`${t.insufficientStock} (${qtyFmt(p.stock)})`, 'err');
    navigator.vibrate?.(15);
    setCart((c) => c.some((x) => x.productId === p.id)
      ? c.map((x) => (x.productId === p.id ? { ...x, qty: +(x.qty + add).toFixed(3) } : x))
      : [...c, { productId: p.id, qty: add }]);
  };
  const setQty = (id, qty) => setCart((c) => (qty <= 0 ? c.filter((x) => x.productId !== id) : c.map((x) => (x.productId === id ? { ...x, qty } : x))));

  const onCode = (code) => {
    const p = products.find((x) => x.active && sameCode(x.barcode, code));
    setScanning(false);
    if (!p) return notify(`${t.notFound} (${code})`, 'err');
    addProduct(p);
  };

  // Lecteur de codes-barres USB/Bluetooth : il « tape » le code puis Entrée.
  const onSearchKey = (e) => {
    if (e.key !== 'Enter' || !q.trim()) return;
    const exact = products.find((x) => x.active && sameCode(x.barcode, q));
    if (exact) { addProduct(exact); setQ(''); } else if (filtered.length === 1) { addProduct(filtered[0]); setQ(''); }
  };

  const reset = () => {
    setCart([]); setDiscount(''); setCashGiven(''); setMethod('cash'); setShowCart(false);
    clientId.current = newId();
  };

  const validate = async () => {
    if (!lines.length || busy) return;
    if (method === 'cash' && cashGiven !== '' && given < total) return notify(t.cashTooLow, 'err');
    setBusy(true);
    const payload = {
      clientId: clientId.current, paymentMethod: method, discount: disc,
      cashGiven: method === 'cash' && cashGiven !== '' ? given : null,
      items: lines.map((l) => ({ productId: l.productId, qty: l.qty })),
    };
    try {
      const sale = await api('/sales', { method: 'POST', body: payload });
      setDone(sale); reset(); reloadProducts();
      if (settings.auto_print && settings.printer) printSale(sale);
    } catch (e) {
      if (e.status === 0) {
        // Pas de réseau : on garde la vente sur l'appareil, elle partira toute seule plus tard.
        enqueueSale({ payload, at: Date.now() });
        setPending(readQueue().length);
        const local = {
          id: null, employee_name: user.name, status: 'completed', created_at: new Date().toISOString(),
          subtotal, discount: disc, total, payment_method: method, cash_given: payload.cashGiven,
          items: lines.map((l) => ({ name_fr: l.p.name_fr, name_ar: l.p.name_ar, qty: l.qty, unit_price: l.p.price, line_total: Math.round(l.qty * l.p.price) })),
        };
        setDone({ ...local, offlineSaved: true }); reset();
      } else if (e.code === 'insufficient_stock') {
        notify(`${t.insufficientStock} — ${pname(byId.get(e.data.productId) ?? {}, lang)} (${qtyFmt(e.data.available)})`, 'err');
        reloadProducts();
      } else notify(errText(t, e.code), 'err');
    } finally { setBusy(false); }
  };

  const cartPanel = (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 px-4 pt-4 pe-16 md:pe-4">
        <h2 className="text-lg font-bold">🛒 {t.cart} ({count})</h2>
        {count > 0 && <button className="text-sm font-medium text-red-600" onClick={reset}>{t.clearCart}</button>}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
        {!count ? <p className="py-10 text-center text-slate-400">{t.emptyCart}</p> : lines.map((l) => (
          <div key={l.productId} className="border-b border-slate-100 py-3">
            <div className="flex justify-between gap-2">
              <div className="font-medium">{pname(l.p, lang)}</div>
              <div className="whitespace-nowrap font-semibold">{money(l.qty * l.p.price)}</div>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <button className="btn btn-secondary !min-h-10 !w-10 !p-0 text-xl" onClick={() => setQty(l.productId, l.p.unit === 'piece' ? l.qty - 1 : 0)}>
                {l.p.unit === 'piece' ? '−' : '🗑'}
              </button>
              {l.p.unit === 'piece' ? (
                <span className="w-10 text-center text-lg font-bold">{l.qty}</span>
              ) : (
                <button className="min-w-16 rounded-lg bg-slate-100 px-2 py-2 text-center font-bold" onClick={() => setQtyFor(l.p)}>
                  {qtyFmt(l.qty)} {t.perUnit[l.p.unit]}
                </button>
              )}
              {l.p.unit === 'piece' && (
                <button className="btn btn-secondary !min-h-10 !w-10 !p-0 text-xl" onClick={() => addProduct(l.p)}>+</button>
              )}
              <span className="text-sm text-slate-500">× {money(l.p.price)}</span>
            </div>
          </div>
        ))}
      </div>

      {count > 0 && (
        <div className="space-y-3 border-t border-slate-200 p-4">
          <div className="flex items-center gap-2">
            <label className="w-24 text-sm text-slate-600">{t.discount}</label>
            <input className="input !min-h-10 !py-2" inputMode="numeric" value={discount} placeholder="0"
              onChange={(e) => setDiscount(e.target.value.replace(/\D/g, ''))} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            {[['cash', '💵', t.cash], ['mobile', '📱', t.mobile]].map(([m, ic, label]) => (
              <button key={m} onClick={() => setMethod(m)}
                className={`btn !py-3 ${method === m ? 'btn-primary' : 'btn-secondary'}`}>{ic} {label}</button>
            ))}
          </div>
          <div className="flex items-end justify-between">
            <span className="text-slate-600">{t.total}</span>
            <span className="text-3xl font-extrabold text-green-700">{money(total)}</span>
          </div>
          {method === 'cash' && (
            <div className="space-y-2">
              <input className="input" inputMode="numeric" placeholder={t.cashGiven} value={cashGiven}
                onChange={(e) => setCashGiven(e.target.value.replace(/\D/g, ''))} />
              <div className="flex flex-wrap gap-2">
                <button className="btn btn-secondary !min-h-9 !px-3 !py-1 text-sm" onClick={() => setCashGiven(String(total))}>{t.total}</button>
                {[500, 1000, 2000, 5000, 10000].filter((v) => v >= total).map((v) => (
                  <button key={v} className="btn btn-secondary !min-h-9 !px-3 !py-1 text-sm" onClick={() => setCashGiven(String(v))}>{qtyFmt(v)}</button>
                ))}
              </div>
              {cashGiven !== '' && given >= total && (
                <div className="flex justify-between rounded-xl bg-amber-50 px-3 py-2 text-lg font-bold text-amber-900">
                  <span>{t.change}</span><span>{money(given - total)}</span>
                </div>
              )}
            </div>
          )}
          <button className="btn btn-primary w-full !py-4 text-lg" disabled={busy || (method === 'cash' && cashGiven !== '' && given < total)} onClick={validate}>
            ✓ {method === 'mobile' ? t.validateMobile : t.validateSale}
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div className="flex h-full">
      {/* Catalogue */}
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="space-y-2 p-3 pb-1">
          <div className="flex gap-2">
            <input className="input" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onSearchKey} placeholder={t.search} enterKeyHint="search" />
            <button className="btn btn-primary !px-4" onClick={() => setScanning(true)} aria-label={t.scan} title={t.scan}><svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="2" y="4" width="2" height="16"/><rect x="6" y="4" width="1" height="16"/><rect x="9" y="4" width="3" height="16"/><rect x="14" y="4" width="1" height="16"/><rect x="17" y="4" width="2" height="16"/><rect x="21" y="4" width="1" height="16"/></svg></button>
            <PhotoButton onFile={setPhoto} className="btn btn-primary !px-4" title={t.photoSearch}>📸</PhotoButton>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            <Chip active={cat == null} onClick={() => setCat(null)}>{t.all}</Chip>
            {categories.map((c) => (
              <Chip key={c.id} active={cat === c.id} onClick={() => setCat(c.id)}>{c.icon} {cname(c, lang)}</Chip>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3 pt-1 pb-24 md:pb-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {filtered.map((p) => {
              const out = p.stock <= 0;
              const n = inCart(p.id);
              return (
                <button key={p.id} onClick={() => addProduct(p)} disabled={out && !allowNeg}
                  className={`card relative flex min-h-24 flex-col justify-between p-3 text-start transition active:scale-[.97] disabled:opacity-40 ${n ? 'ring-2 ring-green-600' : ''}`}>
                  {n > 0 && <span className="absolute end-2 top-2 rounded-full bg-green-600 px-2 text-sm font-bold text-white">{qtyFmt(n)}</span>}
                  <span className="pe-8 font-semibold leading-tight">{pname(p, lang)}</span>
                  <span>
                    <span className="block font-bold text-green-700">{money(p.price)}<span className="text-xs font-normal text-slate-500"> / {t.perUnit[p.unit]}</span></span>
                    <span className={`text-xs ${out ? 'font-semibold text-red-600' : p.stock <= p.min_stock ? 'text-amber-600' : 'text-slate-400'}`}>
                      {out ? t.outOfStock : `${t.inStock}: ${qtyFmt(p.stock)}`}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          {!filtered.length && <p className="py-10 text-center text-slate-400">{t.notFound}</p>}
        </div>
      </section>

      {/* Panier : colonne fixe sur tablette */}
      <aside className="hidden w-[380px] shrink-0 border-s border-slate-200 bg-white md:block">{cartPanel}</aside>

      {/* Panier : barre + volet sur téléphone */}
      {count > 0 && !showCart && (
        <button onClick={() => setShowCart(true)}
          className="fixed inset-x-3 bottom-20 z-30 flex items-center justify-between rounded-2xl bg-green-600 px-5 py-4 text-white shadow-xl md:hidden">
          <span className="font-semibold">🛒 {t.cart} ({count})</span>
          <span className="text-lg font-extrabold">{money(total)}</span>
        </button>
      )}
      {showCart && (
        <div className="fixed inset-0 z-40 bg-white md:hidden">
          <button onClick={() => setShowCart(false)} className="absolute end-3 top-3 z-10 grid h-10 w-10 place-items-center rounded-full bg-slate-100 text-xl">×</button>
          {cartPanel}
        </div>
      )}

      {photo && <Recognize file={photo} onClose={() => setPhoto(null)} onPick={(p) => { setPhoto(null); addProduct(p); }} />}
      {scanning && <Scanner onDetect={onCode} onClose={() => setScanning(false)} />}
      {qtyFor && <QtyDialog product={qtyFor} current={inCart(qtyFor.id)} onClose={() => setQtyFor(null)}
        onOk={(qty) => { setQtyFor(null); if (inCart(qtyFor.id)) setQty(qtyFor.id, qty); else addProduct(qtyFor, qty); }} />}
      {done && (
        <Modal title={`✅ ${t.saleSaved}`} onClose={() => setDone(null)}>
          {done.offlineSaved && <p className="mb-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{t.savedOffline}</p>}
          <Receipt sale={done} />
          <div className="mt-4 grid grid-cols-2 gap-3">
            <button className="btn btn-secondary" onClick={() => printSale(done)} disabled={done.offlineSaved && !!settings.printer}>🖨 {t.print}</button>
            <button className="btn btn-primary" onClick={() => setDone(null)}>{t.newSale}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

const Chip = ({ active, onClick, children }) => (
  <button onClick={onClick} className={`whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium ${active ? 'bg-green-600 text-white' : 'bg-white text-slate-700 border border-slate-200'}`}>
    {children}
  </button>
);

function QtyDialog({ product, current, onOk, onClose }) {
  const { t, lang } = useApp();
  const [v, setV] = useState(current ? String(current) : '');
  const n = Number(String(v).replace(',', '.'));
  return (
    <Modal title={pname(product, lang)} onClose={onClose}>
      <label className="label">{t.qty} ({t.perUnit[product.unit]})</label>
      <input className="input !text-2xl" autoFocus inputMode="decimal" value={v}
        onChange={(e) => setV(e.target.value.replace(/[^\d.,]/g, ''))}
        onKeyDown={(e) => e.key === 'Enter' && n > 0 && onOk(n)} />
      <div className="mt-2 grid grid-cols-4 gap-2">
        {[0.25, 0.5, 1, 2].map((x) => <button key={x} className="btn btn-secondary !min-h-10" onClick={() => setV(String(x))}>{x}</button>)}
      </div>
      {n > 0 && <div className="mt-3 text-end text-xl font-bold text-green-700">{money(n * product.price)}</div>}
      <button className="btn btn-primary mt-4 w-full" disabled={!(n > 0)} onClick={() => onOk(n)}>{t.confirm}</button>
    </Modal>
  );
}
