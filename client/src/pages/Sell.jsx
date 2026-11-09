import { useEffect, useMemo, useState } from 'react';
import { api, enqueueSale, getToken, readQueue, requestQueuedPrint } from '../api.js';
import { useApp } from '../ctx.js';
import { pname, cname, errText, payLabel } from '../i18n.js';
import { money, qtyFmt, localNow } from '../format.js';
import Modal from '../components/Modal.jsx';
import Scanner from '../components/Scanner.jsx';
import Receipt from '../components/Receipt.jsx';
import PhotoButton from '../components/PhotoButton.jsx';
import Recognize from '../components/Recognize.jsx';
import CustomerPicker from '../components/CustomerPicker.jsx';
import ShareButtons from '../components/ShareButtons.jsx';
import InvoiceButton from '../components/Invoice.jsx';
import { sameCode } from '../barcode.js';

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const digits = (s) => s.replace(/\D/g, '');

// Le panier en cours survit à un changement d'onglet et à un rechargement de la page.
const DRAFT_KEY = 'magasin.draft';
const HELD_KEY = 'magasin.heldCarts';
const readJson = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const newDraft = () => ({ clientId: newId(), cart: [], discount: '', method: 'cash', cashGiven: '', reference: '', customerId: null, split: [] });

const MOBILE_METHODS = ['wave', 'orange_money', 'mobile'];
const METHOD_ICONS = { cash: '💵', wave: '🌊', orange_money: '🟠', mobile: '📱', credit: '📒', split: '➗' };

export default function Sell() {
  const { products, categories, customers, settings, user, lang, t, notify, reloadProducts, reloadCustomers, setPending, printSale } = useApp();
  const isManager = user.role === 'manager';
  const canPrice = isManager || !!settings.seller_can_change_price;
  const canCredit = isManager || settings.seller_can_credit !== false;
  const maxDiscount = isManager ? 100 : settings.seller_max_discount ?? 100;

  const [q, setQ] = useState('');
  const [cat, setCat] = useState(null);
  const [draft, setDraft] = useState(() => ({ ...newDraft(), ...readJson(DRAFT_KEY, {}) }));
  const [held, setHeld] = useState(() => readJson(HELD_KEY, []));
  const [showCart, setShowCart] = useState(false);
  const [showHeld, setShowHeld] = useState(false);
  const [picking, setPicking] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [photo, setPhoto] = useState(null); // photo à reconnaître
  const [qtyFor, setQtyFor] = useState(null); // produit au poids/volume à saisir
  const [lineFor, setLineFor] = useState(null); // ligne dont on change le prix ou la remise
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // vente terminée (ticket)

  useEffect(() => { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); }, [draft]);
  useEffect(() => { localStorage.setItem(HELD_KEY, JSON.stringify(held)); }, [held]);

  const patch = (p) => setDraft((d) => ({ ...d, ...p }));
  const setCart = (fn) => setDraft((d) => ({ ...d, cart: fn(d.cart) }));
  const { cart, discount, method, cashGiven, reference, customerId, split } = draft;

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const customer = customers.find((c) => c.id === customerId) ?? null;
  const allowNeg = settings.allow_negative_stock;

  const filtered = useMemo(() => {
    const n = norm(q.trim());
    return products.filter((p) => p.active && (cat == null || p.category_id === cat) &&
      (!n || norm(p.name_fr).includes(n) || norm(p.name_ar).includes(n) || (p.barcode ?? '').includes(n)));
  }, [products, q, cat]);

  const lines = cart.map((c) => {
    const p = byId.get(c.productId);
    if (!p) return null;
    const unit = c.price ?? p.price;
    const gross = Math.round(c.qty * unit);
    const ld = Math.min(Math.round(c.lineDiscount || 0), gross);
    return { ...c, p, unit, gross, ld, lineTotal: gross - ld };
  }).filter(Boolean);
  const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  const disc = Math.min(Math.max(Math.round(Number(discount) || 0), 0), subtotal);
  const total = subtotal - disc;
  const catalog = lines.reduce((s, l) => s + Math.round(l.qty * l.p.price), 0);
  const overDiscount = (catalog - total) * 100 > catalog * maxDiscount;
  const given = Number(cashGiven) || 0;
  const count = lines.length;

  const payments = method === 'split'
    ? split.map((s) => ({ method: s.method, amount: Math.round(Number(s.amount) || 0), reference: s.reference ?? '' })).filter((s) => s.amount > 0)
    : [{ method, amount: total, reference }];
  const allocated = payments.reduce((s, p) => s + p.amount, 0);
  const remaining = total - allocated;
  const usesCredit = payments.some((p) => p.method === 'credit');

  const inCart = (id) => cart.find((c) => c.productId === id)?.qty ?? 0;

  const addProduct = (p, qty = null) => {
    if (p.unit !== 'piece' && qty == null) return setQtyFor(p);
    const add = qty ?? 1;
    const have = inCart(p.id);
    if (!allowNeg && have + add > p.stock) return notify(`${t.insufficientStock} (${qtyFmt(p.stock)})`, 'err');
    navigator.vibrate?.(15);
    setCart((c) => (c.some((x) => x.productId === p.id)
      ? c.map((x) => (x.productId === p.id ? { ...x, qty: +(x.qty + add).toFixed(3) } : x))
      : [...c, { productId: p.id, qty: add }]));
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

  const reset = () => { setDraft(newDraft()); setShowCart(false); };

  // Paniers mis de côté (sur cet appareil)
  const holdCurrent = (list) => [...list, { ...draft, heldAt: localNow(), label: customer?.name ?? '', itemCount: count }];
  const hold = () => {
    if (!count) return;
    setHeld(holdCurrent);
    reset();
    notify(t.cartHeld);
  };
  const resume = (h) => {
    setHeld((list) => (count ? holdCurrent(list) : list).filter((x) => x.clientId !== h.clientId));
    const { heldAt, label, itemCount, ...rest } = h;
    setDraft({ ...newDraft(), ...rest });
    setShowHeld(false);
  };

  const chooseMethod = (m) => {
    if (m === 'split' && !split.length) {
      patch({ method: m, split: [{ method: 'cash', amount: String(total) }, { method: 'wave', amount: '' }] });
    } else patch({ method: m });
  };
  const setSplit = (i, p) => patch({ split: split.map((s, j) => (j === i ? { ...s, ...p } : s)) });

  const validate = async () => {
    if (!lines.length || busy) return;
    if (method === 'cash' && cashGiven !== '' && given < total) return notify(t.cashTooLow, 'err');
    if (usesCredit && !customer) { setPicking(true); return notify(t.customerRequired, 'err'); }
    if (remaining !== 0) return notify(t.paymentMismatch, 'err');
    if (overDiscount) return notify(`${t.discountTooHigh} (max ${maxDiscount} %)`, 'err');
    setBusy(true);
    const payload = {
      clientId: draft.clientId, customerId, discount: disc, payments,
      cashGiven: method === 'cash' && cashGiven !== '' ? given : null,
      items: lines.map((l) => ({ productId: l.productId, qty: l.qty, discount: l.ld, ...(l.price != null ? { unitPrice: l.price } : {}) })),
    };
    try {
      const sale = await api('/sales', { method: 'POST', body: payload });
      setDone(sale); reset(); reloadProducts();
      if (customerId) reloadCustomers();
      if (settings.auto_print && settings.printer) printSale(sale);
    } catch (e) {
      if (e.status === 0) {
        // Pas de réseau : on garde la vente sur l'appareil, elle partira toute seule plus tard.
        const items = lines.map((l) => ({ productId: l.productId, qty: l.qty, discount: l.ld, unitPrice: l.unit }));
        enqueueSale({ payload: { ...payload, items }, at: Date.now(), token: getToken() });
        setPending(readQueue().length);
        const ratio = subtotal > 0 ? total / subtotal : 0;
        const taxOf = (l) => {
          const rate = settings.tax_enabled ? l.p.tax_rate ?? settings.tax_rate : 0;
          const net = l.lineTotal * ratio;
          return rate > 0 ? Math.round(net - net / (1 + rate / 100)) : 0;
        };
        const local = {
          id: null, clientId: payload.clientId, employee_name: user.name, status: 'completed', created_at: localNow(),
          subtotal, discount: disc, total, payment_method: payments.length > 1 ? 'mixed' : payments[0].method,
          cash_given: payload.cashGiven, payments, customer_name: customer?.name, customer_phone: customer?.phone,
          tax_total: lines.reduce((s, l) => s + taxOf(l), 0),
          items: lines.map((l) => ({ name_fr: l.p.name_fr, name_ar: l.p.name_ar, qty: l.qty, unit_price: l.unit, line_total: l.lineTotal, line_discount: l.ld })),
        };
        setDone({ ...local, offlineSaved: true }); reset();
      } else if (e.code === 'insufficient_stock') {
        notify(`${t.insufficientStock} — ${pname(byId.get(e.data.productId) ?? {}, lang)} (${qtyFmt(e.data.available)})`, 'err');
        reloadProducts();
      } else notify(errText(t, e.code), 'err');
    } finally { setBusy(false); }
  };

  const printLater = () => {
    requestQueuedPrint(done.clientId);
    setDone({ ...done, printQueued: true });
    notify(t.printQueued);
  };

  const methods = ['cash', 'wave', 'orange_money', 'mobile', ...(canCredit ? ['credit'] : []), 'split'];
  const validateLabel = usesCredit && method === 'credit' ? t.validateCredit : MOBILE_METHODS.includes(method) ? t.validateMobile : t.validateSale;

  const cartPanel = (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 px-4 pt-4 pe-16 md:pe-4">
        <h2 className="text-lg font-bold">🛒 {t.cart} ({count})</h2>
        {count > 0 && (
          <div className="flex gap-3">
            <button className="text-sm font-medium text-slate-600" onClick={hold}>⏸ {t.hold}</button>
            <button className="text-sm font-medium text-red-600" onClick={reset}>{t.clearCart}</button>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
        {!count ? <p className="py-10 text-center text-slate-400">{t.emptyCart}</p> : lines.map((l) => (
          <div key={l.productId} className="border-b border-slate-100 py-3">
            <button className="flex w-full justify-between gap-2 text-start" onClick={() => setLineFor(l)}>
              <span className="font-medium">{pname(l.p, lang)}</span>
              <span className="whitespace-nowrap font-semibold">{money(l.lineTotal)}</span>
            </button>
            {l.ld > 0 && <div className="text-xs text-amber-700">{t.discount}: - {money(l.ld)}</div>}
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
              <button className={`text-sm underline ${l.price != null && l.price !== l.p.price ? 'font-semibold text-amber-700' : 'text-slate-500'}`} onClick={() => setLineFor(l)}>× {money(l.unit)}</button>
            </div>
          </div>
        ))}

        {count > 0 && (
          <div className="space-y-3 py-3">
            <button className="flex w-full items-center justify-between rounded-xl bg-slate-100 px-3 py-3 text-start" onClick={() => setPicking(true)}>
              <span className="text-sm text-slate-600">👤 {t.customer}</span>
              <span className="font-medium">{customer ? customer.name : t.noCustomer}{customer?.balance > 0 && <span className="ms-2 text-sm text-red-600">{money(customer.balance)}</span>}</span>
            </button>
            <div className="flex items-center gap-2">
              <label className="w-24 text-sm text-slate-600">{t.discount}</label>
              <input className="input !min-h-10 !py-2" inputMode="numeric" value={discount} placeholder="0" onChange={(e) => patch({ discount: digits(e.target.value) })} />
            </div>
            {overDiscount && <p className="text-sm font-medium text-red-600">{t.discountTooHigh} (max {maxDiscount} %)</p>}
            <div className="grid grid-cols-3 gap-2">
              {methods.map((m) => (
                <button key={m} onClick={() => chooseMethod(m)} className={`btn !min-h-11 !px-1 !py-2 text-sm ${method === m ? 'btn-primary' : 'btn-secondary'}`}>
                  {METHOD_ICONS[m]} {payLabel(t, m === 'split' ? 'mixed' : m)}
                </button>
              ))}
            </div>
            {MOBILE_METHODS.includes(method) && (
              <input className="input !min-h-10 !py-2" dir="ltr" placeholder={t.reference} value={reference} onChange={(e) => patch({ reference: e.target.value })} />
            )}
            {method === 'split' && (
              <div className="space-y-2">
                {split.map((s, i) => (
                  <div key={i} className="space-y-1">
                    <div className="flex gap-2">
                      <select className="input !min-h-10 !py-1" value={s.method} onChange={(e) => setSplit(i, { method: e.target.value })}>
                        {methods.filter((m) => m !== 'split').map((m) => <option key={m} value={m}>{payLabel(t, m)}</option>)}
                      </select>
                      <input className="input !min-h-10 !py-1" inputMode="numeric" placeholder={t.amount} value={s.amount} onChange={(e) => setSplit(i, { amount: digits(e.target.value) })} />
                      <button className="btn btn-secondary !min-h-10 !w-10 shrink-0 !p-0" onClick={() => patch({ split: split.filter((_, j) => j !== i) })}>×</button>
                    </div>
                    {MOBILE_METHODS.includes(s.method) && (
                      <input className="input !min-h-9 !py-1 text-sm" dir="ltr" placeholder={t.reference} value={s.reference ?? ''} onChange={(e) => setSplit(i, { reference: e.target.value })} />
                    )}
                  </div>
                ))}
                <button className="btn btn-secondary !min-h-9 w-full !py-1 text-sm" onClick={() => patch({ split: [...split, { method: 'cash', amount: remaining > 0 ? String(remaining) : '' }] })}>＋ {t.addPayment}</button>
                <div className="flex justify-between text-sm"><span>{t.remaining}</span><span className={`font-bold ${remaining ? 'text-red-600' : 'text-green-700'}`}>{money(remaining)}</span></div>
              </div>
            )}
            {method === 'cash' && (
              <div className="space-y-2">
                <input className="input" inputMode="numeric" placeholder={t.cashGiven} value={cashGiven} onChange={(e) => patch({ cashGiven: digits(e.target.value) })} />
                <div className="flex flex-wrap gap-2">
                  <button className="btn btn-secondary !min-h-9 !px-3 !py-1 text-sm" onClick={() => patch({ cashGiven: String(total) })}>{t.total}</button>
                  {[500, 1000, 2000, 5000, 10000].filter((v) => v >= total).map((v) => (
                    <button key={v} className="btn btn-secondary !min-h-9 !px-3 !py-1 text-sm" onClick={() => patch({ cashGiven: String(v) })}>{qtyFmt(v)}</button>
                  ))}
                </div>
                {cashGiven !== '' && given >= total && (
                  <div className="flex justify-between rounded-xl bg-amber-50 px-3 py-2 text-lg font-bold text-amber-900">
                    <span>{t.change}</span><span>{money(given - total)}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {count > 0 && (
        <div className="space-y-2 border-t border-slate-200 p-4">
          <div className="flex items-end justify-between">
            <span className="text-slate-600">{t.total}</span>
            <span className="text-3xl font-extrabold text-green-700">{money(total)}</span>
          </div>
          <button className="btn btn-primary w-full !py-4 text-lg" disabled={busy || overDiscount || (method === 'cash' && cashGiven !== '' && given < total) || remaining !== 0} onClick={validate}>
            ✓ {validateLabel}
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
            {held.length > 0 && <Chip active={false} onClick={() => setShowHeld(true)}>⏸ {t.heldCarts} ({held.length})</Chip>}
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
      {picking && <CustomerPicker onClose={() => setPicking(false)} onPick={(c) => { patch({ customerId: c?.id ?? null }); setPicking(false); }} />}
      {qtyFor && <QtyDialog product={qtyFor} current={inCart(qtyFor.id)} onClose={() => setQtyFor(null)}
        onOk={(qty) => { setQtyFor(null); if (inCart(qtyFor.id)) setQty(qtyFor.id, qty); else addProduct(qtyFor, qty); }} />}
      {lineFor && <LineDialog line={lineFor} canPrice={canPrice} onClose={() => setLineFor(null)}
        onOk={(price, lineDiscount) => {
          setCart((c) => c.map((x) => (x.productId === lineFor.productId ? { ...x, price: price === lineFor.p.price ? undefined : price, lineDiscount } : x)));
          setLineFor(null);
        }} />}
      {showHeld && (
        <Modal title={t.heldCarts} onClose={() => setShowHeld(false)}>
          {!held.length && <p className="py-6 text-center text-slate-400">{t.nothing}</p>}
          {held.map((h) => (
            <div key={h.clientId} className="flex items-center justify-between gap-2 border-b border-slate-100 py-3">
              <div className="min-w-0">
                <div className="truncate font-medium">{h.label || `${h.itemCount} ${t.items}`}</div>
                <div className="text-sm text-slate-500">{h.heldAt?.slice(11, 16)}</div>
              </div>
              <div className="flex gap-2">
                <button className="btn btn-primary !min-h-10 !py-1" onClick={() => resume(h)}>{t.resume}</button>
                <button className="btn btn-secondary !min-h-10 !w-10 !p-0" aria-label={t.delete} onClick={() => setHeld((l) => l.filter((x) => x.clientId !== h.clientId))}>×</button>
              </div>
            </div>
          ))}
        </Modal>
      )}
      {done && (
        <Modal title={`✅ ${t.saleSaved}`} onClose={() => setDone(null)}>
          {done.offlineSaved && <p className="mb-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{t.savedOffline}</p>}
          <Receipt sale={done} />
          <div className="mt-4 grid gap-3">
            {done.offlineSaved && settings.printer
              ? <button className="btn btn-secondary" disabled={done.printQueued} onClick={printLater}>🖨 {done.printQueued ? t.printQueued : t.printLater}</button>
              : <button className="btn btn-secondary" onClick={() => printSale(done)}>🖨 {t.print}</button>}
            <ShareButtons sale={done} />
            <InvoiceButton sale={done} />
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

/** Prix et remise d'une ligne du panier. */
function LineDialog({ line, canPrice, onOk, onClose }) {
  const { t, lang } = useApp();
  const [price, setPrice] = useState(String(line.unit));
  const [disc, setDisc] = useState(line.ld ? String(line.ld) : '');
  const p = Number(price);
  const gross = Math.round(line.qty * (Number.isFinite(p) ? p : 0));
  const d = Number(disc) || 0;
  const invalid = !(p >= 0) || price === '' || d > gross;
  return (
    <Modal title={pname(line.p, lang)} onClose={onClose}>
      <div className="grid gap-3">
        <div>
          <label className="label">{t.unitPrice}</label>
          <input className="input" inputMode="numeric" disabled={!canPrice} value={price} onChange={(e) => setPrice(digits(e.target.value))} />
          {!canPrice && <p className="mt-1 text-sm text-slate-500">{t.priceForbidden}</p>}
        </div>
        <div>
          <label className="label">{t.lineDiscount}</label>
          <input className="input" inputMode="numeric" value={disc} placeholder="0" onChange={(e) => setDisc(digits(e.target.value))} />
        </div>
        <div className="text-end text-xl font-bold text-green-700">{money(gross - d)}</div>
        <button className="btn btn-primary" disabled={invalid} onClick={() => onOk(p, d)}>{t.confirm}</button>
      </div>
    </Modal>
  );
}
