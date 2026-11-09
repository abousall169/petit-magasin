import { useCallback, useEffect, useRef, useState } from 'react';
import { api, download } from '../api.js';
import { useApp } from '../ctx.js';
import { errText, LANGS } from '../i18n.js';
import { printReceiptBitmap, sampleSale } from '../printer.js';
import Modal from '../components/Modal.jsx';

const LANG_NAMES = { fr: 'Français', ar: 'العربية', en: 'English' };

export default function Settings() {
  const { user, settings, t, lang, setLang, notify, reloadAll } = useApp();
  const isManager = user.role === 'manager';
  return (
    <div className="mx-auto h-full max-w-3xl space-y-3 overflow-y-auto p-3 pb-6">
      <h1 className="text-lg font-bold">{t.settings}</h1>
      <section className="card p-4">
        <h2 className="mb-2 font-bold">{t.language}</h2>
        <div className="grid grid-cols-3 gap-2">
          {LANGS.map((l) => <button key={l} className={`btn ${lang === l ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setLang(l)}>{LANG_NAMES[l]}</button>)}
        </div>
      </section>
      <MyPin t={t} notify={notify} />
      {isManager && <Shop settings={settings} t={t} notify={notify} reloadAll={reloadAll} />}
      {isManager && <Tax settings={settings} t={t} notify={notify} reloadAll={reloadAll} />}
      {isManager && <SellerRules settings={settings} t={t} notify={notify} reloadAll={reloadAll} />}
      {isManager && <PrinterSection settings={settings} user={user} lang={lang} t={t} notify={notify} reloadAll={reloadAll} />}
      {isManager && <Team t={t} notify={notify} />}
      {isManager && <Backups t={t} notify={notify} />}
    </div>
  );
}

function useSaveSettings({ t, notify, reloadAll }) {
  return async (body) => {
    try { await api('/settings', { method: 'PUT', body }); await reloadAll(); notify(t.saved); }
    catch (e) { notify(errText(t, e.code), 'err'); }
  };
}

function PrinterSection({ settings, user, lang, t, notify, reloadAll }) {
  const [printers, setPrinters] = useState([]);
  const cur = settings.printer ?? '';
  const [mode, setMode] = useState(cur.startsWith('tcp:') ? 'tcp' : cur); // '' | 'usb:<nom>' | 'tcp'
  const [ip, setIp] = useState(cur.startsWith('tcp:') ? cur.slice(4) : '');
  const [auto, setAuto] = useState(!!settings.auto_print);
  const [cut, setCut] = useState(settings.printer_cut !== false);
  const [paper, setPaper] = useState(settings.paper_width ?? 80);
  const [drawer, setDrawer] = useState(!!settings.cash_drawer);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api('/printers').then((r) => setPrinters(r.printers ?? [])).catch(() => {}); }, []);

  const value = mode === 'tcp' ? (ip.trim() ? `tcp:${ip.trim()}` : '') : mode;
  const save = async () => {
    await api('/settings', { method: 'PUT', body: { printer: value, auto_print: auto && !!value, printer_cut: cut, paper_width: paper, cash_drawer: drawer && !!value } });
    await reloadAll();
  };
  const onSave = async () => {
    try { await save(); notify(t.saved); } catch (e) { notify(errText(t, e.code), 'err'); }
  };
  const onTest = async () => {
    setBusy(true);
    try {
      await save();
      await printReceiptBitmap(sampleSale(user), { lang, t, shop: settings.shop_name, footer: settings.ticket_footer, paper, address: settings.shop_address, phone: settings.shop_phone, taxId: settings.shop_tax_id });
      notify(t.printSent);
    } catch (e) {
      notify(`${t.printFailed}${e.data?.detail ? ` : ${e.data.detail}` : ''}`, 'err');
    } finally { setBusy(false); }
  };
  const openDrawer = async () => {
    try { await save(); await api('/drawer', { method: 'POST' }); }
    catch (e) { notify(`${t.printFailed}${e.data?.detail ? ` : ${e.data.detail}` : ''}`, 'err'); }
  };

  return (
    <section className="card space-y-3 p-4">
      <h2 className="font-bold">🖨 {t.printer}</h2>
      <select className="input" value={mode} onChange={(e) => setMode(e.target.value)}>
        <option value="">{t.printerNone}</option>
        {printers.map((p) => <option key={p.name} value={`usb:${p.name}`}>{p.name}</option>)}
        <option value="tcp">{t.printerNetwork}</option>
        {mode.startsWith('usb:') && !printers.some((p) => `usb:${p.name}` === mode) && <option value={mode}>{mode.slice(4)}</option>}
      </select>
      {!printers.length && <p className="text-sm text-amber-700">{t.noPrinterFound}</p>}
      {mode === 'tcp' && (
        <div><label className="label">{t.printerIp}</label>
          <input className="input" dir="ltr" inputMode="decimal" value={ip} onChange={(e) => setIp(e.target.value)} placeholder="192.168.1.50:9100" /></div>
      )}
      <div><label className="label">{t.paperWidth}</label>
        <div className="grid grid-cols-2 gap-2">
          {[80, 58].map((w) => <button key={w} className={`btn !min-h-10 !py-1 ${paper === w ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setPaper(w)}>{w} mm</button>)}
        </div></div>
      <label className="flex items-center gap-3"><input type="checkbox" className="h-5 w-5" checked={auto} onChange={(e) => setAuto(e.target.checked)} />{t.autoPrint}</label>
      <label className="flex items-center gap-3"><input type="checkbox" className="h-5 w-5" checked={cut} onChange={(e) => setCut(e.target.checked)} />{t.cutPaper}</label>
      <label className="flex items-center gap-3"><input type="checkbox" className="h-5 w-5" checked={drawer} onChange={(e) => setDrawer(e.target.checked)} />{t.cashDrawerAuto}</label>
      <div className="grid grid-cols-2 gap-2">
        <button className="btn btn-secondary" disabled={busy || !value} onClick={onTest}>{t.testPrint}</button>
        <button className="btn btn-primary" onClick={onSave}>{t.save}</button>
      </div>
      {drawer && <button className="btn btn-secondary w-full" disabled={!value} onClick={openDrawer}>💰 {t.openDrawer}</button>}
    </section>
  );
}

function MyPin({ t, notify }) {
  const [oldPin, setOld] = useState(''); const [newPin, setNew] = useState('');
  const save = async () => {
    try { await api('/me/pin', { method: 'POST', body: { oldPin, newPin } }); setOld(''); setNew(''); notify(t.pinChanged); }
    catch (e) { notify(errText(t, e.code), 'err'); }
  };
  return (
    <section className="card space-y-2 p-4">
      <h2 className="font-bold">{t.changeMyPin}</h2>
      <input className="input" type="password" inputMode="numeric" maxLength={6} placeholder={t.oldPin} value={oldPin} onChange={(e) => setOld(e.target.value.replace(/\D/g, ''))} />
      <input className="input" type="password" inputMode="numeric" maxLength={6} placeholder={t.newPin} value={newPin} onChange={(e) => setNew(e.target.value.replace(/\D/g, ''))} />
      <button className="btn btn-primary w-full" disabled={oldPin.length < 4 || newPin.length < 4} onClick={save}>{t.save}</button>
    </section>
  );
}

function Shop({ settings, t, notify, reloadAll }) {
  const [f, setF] = useState({
    shop_name: settings.shop_name ?? '', shop_address: settings.shop_address ?? '', shop_phone: settings.shop_phone ?? '', shop_tax_id: settings.shop_tax_id ?? '',
    ticket_footer: settings.ticket_footer ?? '', allow_negative_stock: !!settings.allow_negative_stock, currency: settings.currency ?? 'FCFA', phone_prefix: settings.phone_prefix ?? '221',
  });
  const save = useSaveSettings({ t, notify, reloadAll });
  const text = (k, label, extra = {}) => <div><label className="label">{label}</label><input className="input" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} {...extra} /></div>;
  return (
    <section className="card space-y-3 p-4">
      <h2 className="font-bold">{t.shop}</h2>
      {text('shop_name', t.shopName)}
      {text('shop_address', t.address)}
      {text('shop_phone', t.phone, { dir: 'ltr', inputMode: 'tel' })}
      {text('shop_tax_id', t.shopTaxId)}
      {text('ticket_footer', t.ticketFooter)}
      <div className="grid grid-cols-2 gap-3">
        {text('currency', t.currency)}
        {text('phone_prefix', t.phonePrefix, { dir: 'ltr', inputMode: 'numeric' })}
      </div>
      <p className="text-sm text-slate-500">{t.currencyHint}</p>
      <label className="flex items-center gap-3"><input type="checkbox" className="h-5 w-5" checked={f.allow_negative_stock} onChange={(e) => setF({ ...f, allow_negative_stock: e.target.checked })} />{t.allowNeg}</label>
      <button className="btn btn-primary w-full" onClick={() => save(f)}>{t.save}</button>
    </section>
  );
}

function Tax({ settings, t, notify, reloadAll }) {
  const [enabled, setEnabled] = useState(!!settings.tax_enabled);
  const [rate, setRate] = useState(String(settings.tax_rate ?? 18));
  const save = useSaveSettings({ t, notify, reloadAll });
  return (
    <section className="card space-y-3 p-4">
      <h2 className="font-bold">{t.taxSection}</h2>
      <label className="flex items-center gap-3"><input type="checkbox" className="h-5 w-5" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />{t.taxEnabled}</label>
      {enabled && <div><label className="label">{t.taxRate} (%)</label><input className="input" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value.replace(/[^\d.]/g, ''))} /></div>}
      <p className="text-sm text-slate-500">{t.taxHint}</p>
      <button className="btn btn-primary w-full" onClick={() => save({ tax_enabled: enabled, tax_rate: Number(rate) || 0 })}>{t.save}</button>
    </section>
  );
}

function SellerRules({ settings, t, notify, reloadAll }) {
  const [max, setMax] = useState(String(settings.seller_max_discount ?? 100));
  const [price, setPrice] = useState(!!settings.seller_can_change_price);
  const [credit, setCredit] = useState(settings.seller_can_credit !== false);
  const save = useSaveSettings({ t, notify, reloadAll });
  return (
    <section className="card space-y-3 p-4">
      <h2 className="font-bold">{t.sellerRules}</h2>
      <div><label className="label">{t.sellerMaxDiscount} (%)</label><input className="input" inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value.replace(/\D/g, ''))} /></div>
      <label className="flex items-center gap-3"><input type="checkbox" className="h-5 w-5" checked={price} onChange={(e) => setPrice(e.target.checked)} />{t.sellerCanChangePrice}</label>
      <label className="flex items-center gap-3"><input type="checkbox" className="h-5 w-5" checked={credit} onChange={(e) => setCredit(e.target.checked)} />{t.sellerCanCredit}</label>
      <button className="btn btn-primary w-full" disabled={Number(max) > 100} onClick={() => save({ seller_max_discount: Number(max) || 0, seller_can_change_price: price, seller_can_credit: credit })}>{t.save}</button>
    </section>
  );
}

function Team({ t, notify }) {
  const [list, setList] = useState([]);
  const [edit, setEdit] = useState(null);
  const load = () => api('/employees').then(setList).catch(() => {});
  useEffect(() => { load(); }, []);

  const save = async () => {
    try {
      if (edit.id) await api(`/employees/${edit.id}`, { method: 'PUT', body: { name: edit.name, role: edit.role, active: !!edit.active, pin: edit.pin } });
      else await api('/employees', { method: 'POST', body: { name: edit.name, role: edit.role, pin: edit.pin } });
      setEdit(null); load(); notify(t.saved);
    } catch (e) { notify(errText(t, e.code), 'err'); }
  };

  return (
    <section className="card p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-bold">{t.team}</h2>
        <button className="btn btn-primary !min-h-10 !py-1" onClick={() => setEdit({ name: '', role: 'seller', pin: '', active: 1 })}>＋ {t.add}</button>
      </div>
      {list.map((e) => (
        <button key={e.id} onClick={() => setEdit({ ...e, pin: '' })} className={`flex w-full items-center justify-between border-b border-slate-100 py-3 text-start last:border-0 ${e.active ? '' : 'opacity-40'}`}>
          <span className="font-medium">👤 {e.name}</span>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs">{e.role === 'manager' ? t.manager : t.sellerRole}</span>
        </button>
      ))}
      {edit && (
        <Modal title={edit.id ? t.edit : t.newEmployee} onClose={() => setEdit(null)}>
          <div className="grid gap-3">
            <div><label className="label">{t.name}</label><input className="input" autoFocus value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
            <div><label className="label">{t.role}</label>
              <select className="input" value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value })}>
                <option value="seller">{t.sellerRole}</option><option value="manager">{t.manager}</option>
              </select></div>
            <div><label className="label">{edit.id ? t.resetPin : t.pin}</label>
              <input className="input" inputMode="numeric" maxLength={6} value={edit.pin} onChange={(e) => setEdit({ ...edit, pin: e.target.value.replace(/\D/g, '') })} /></div>
            {edit.id && <label className="flex items-center gap-3"><input type="checkbox" className="h-5 w-5" checked={!!edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} />{t.active}</label>}
            <button className="btn btn-primary" disabled={!edit.name.trim() || (!edit.id && edit.pin.length < 4)} onClick={save}>{t.save}</button>
          </div>
        </Modal>
      )}
    </section>
  );
}

function Backups({ t, notify }) {
  const [data, setData] = useState(null);
  const [dir, setDir] = useState('');
  const [busy, setBusy] = useState(false);
  const file = useRef(null);
  const load = useCallback(() => {
    api('/backups').then((d) => { setData(d); setDir(d.dir); }).catch(() => {});
  }, []);
  useEffect(load, [load]);

  const guard = async (fn) => {
    setBusy(true);
    try { await fn(); } catch (e) { notify(errText(t, e.code), 'err'); } finally { setBusy(false); }
  };
  const restored = () => { window.alert(t.restoreDone); window.location.reload(); };
  const restoreName = (name) => {
    if (window.confirm(`${t.restoreConfirm}\n\n${name}`)) guard(async () => { await api(`/backups/${name}/restore`, { method: 'POST' }); restored(); });
  };
  const restoreFile = (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f && window.confirm(`${t.restoreConfirm}\n\n${f.name}`)) guard(async () => { await api('/backups-upload/restore', { method: 'POST', body: f, binary: true }); restored(); });
  };
  const size = (n) => `${(n / 1048576).toFixed(1)} Mo`;
  const last = data?.lastCopy;

  return (
    <section className="card space-y-3 p-4">
      <h2 className="font-bold">💾 {t.backups}</h2>
      <p className="text-sm text-slate-500">{t.backupHint}</p>
      <button className="btn btn-primary w-full" disabled={busy} onClick={() => guard(async () => { await api('/backups', { method: 'POST' }); load(); notify(t.saved); })}>{t.backupNow}</button>
      <div>
        <label className="label">{t.backupDir}</label>
        <div className="flex gap-2">
          <input className="input" dir="ltr" placeholder="E:\sauvegardes" value={dir} onChange={(e) => setDir(e.target.value)} />
          <button className="btn btn-secondary" disabled={busy} onClick={() => guard(async () => { await api('/backups/dir', { method: 'PUT', body: { dir } }); load(); notify(t.saved); })}>{t.save}</button>
        </div>
        {last && <p className={`mt-1 text-sm ${last.ok ? 'text-green-700' : 'text-red-600'}`}>{last.ok ? `✓ ${t.lastCopy} : ${last.at}` : `✗ ${last.at} : ${last.error}`}</p>}
      </div>
      <div className="max-h-64 overflow-y-auto">
        {data?.files.map((f) => (
          <div key={f.name} className="flex items-center justify-between gap-2 border-b border-slate-100 py-2 text-sm">
            <span className="min-w-0"><span className="block truncate font-medium" dir="ltr">{f.name}</span><span className="text-slate-500">{f.date} · {size(f.size)}</span></span>
            <span className="flex shrink-0 gap-1">
              <button className="btn btn-secondary !min-h-9 !px-3 !py-1" aria-label={t.downloadBackup} title={t.downloadBackup} onClick={() => guard(() => download(`/backups/${f.name}`, f.name))}>⬇</button>
              <button className="btn btn-secondary !min-h-9 !px-3 !py-1" disabled={busy} onClick={() => restoreName(f.name)}>{t.restore}</button>
            </span>
          </div>
        ))}
      </div>
      <input ref={file} type="file" accept=".db" className="hidden" onChange={restoreFile} />
      <button className="btn btn-secondary w-full" disabled={busy} onClick={() => file.current?.click()}>⬆ {t.restoreFromFile}</button>
    </section>
  );
}
