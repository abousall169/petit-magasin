import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../ctx.js';
import { errText } from '../i18n.js';
import { printReceiptBitmap, sampleSale } from '../printer.js';
import Modal from '../components/Modal.jsx';

export default function Settings() {
  const { user, settings, t, lang, setLang, notify, reloadAll } = useApp();
  const isManager = user.role === 'manager';
  return (
    <div className="mx-auto h-full max-w-3xl space-y-3 overflow-y-auto p-3 pb-6">
      <h1 className="text-lg font-bold">{t.settings}</h1>
      <section className="card p-4">
        <h2 className="mb-2 font-bold">{t.language}</h2>
        <div className="grid grid-cols-2 gap-2">
          <button className={`btn ${lang === 'fr' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setLang('fr')}>Français</button>
          <button className={`btn ${lang === 'ar' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setLang('ar')}>العربية</button>
        </div>
      </section>
      <MyPin t={t} notify={notify} />
      {isManager && <Shop settings={settings} t={t} notify={notify} reloadAll={reloadAll} />}
      {isManager && <PrinterSection settings={settings} user={user} lang={lang} t={t} notify={notify} reloadAll={reloadAll} />}
      {isManager && <Team t={t} notify={notify} />}
    </div>
  );
}

function PrinterSection({ settings, user, lang, t, notify, reloadAll }) {
  const [printers, setPrinters] = useState([]);
  const cur = settings.printer ?? '';
  const [mode, setMode] = useState(cur.startsWith('tcp:') ? 'tcp' : cur); // '' | 'usb:<nom>' | 'tcp'
  const [ip, setIp] = useState(cur.startsWith('tcp:') ? cur.slice(4) : '');
  const [auto, setAuto] = useState(!!settings.auto_print);
  const [cut, setCut] = useState(settings.printer_cut !== false);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api('/printers').then((r) => setPrinters(r.printers ?? [])).catch(() => {}); }, []);

  const value = mode === 'tcp' ? (ip.trim() ? `tcp:${ip.trim()}` : '') : mode;
  const save = async () => {
    await api('/settings', { method: 'PUT', body: { printer: value, auto_print: auto && !!value, printer_cut: cut } });
    await reloadAll();
  };
  const onSave = async () => {
    try { await save(); notify(t.saved); } catch (e) { notify(errText(t, e.code), 'err'); }
  };
  const onTest = async () => {
    setBusy(true);
    try {
      await save();
      await printReceiptBitmap(sampleSale(user), { lang, t, shop: settings.shop_name, footer: settings.ticket_footer });
      notify(t.printSent);
    } catch (e) {
      notify(`${t.printFailed}${e.data?.detail ? ` : ${e.data.detail}` : ''}`, 'err');
    } finally { setBusy(false); }
  };

  return (
    <section className="card space-y-3 p-4">
      <h2 className="font-bold">🖨 {t.printer} (80 mm)</h2>
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
      <label className="flex items-center gap-3"><input type="checkbox" className="h-5 w-5" checked={auto} onChange={(e) => setAuto(e.target.checked)} />{t.autoPrint}</label>
      <label className="flex items-center gap-3"><input type="checkbox" className="h-5 w-5" checked={cut} onChange={(e) => setCut(e.target.checked)} />{t.cutPaper}</label>
      <div className="grid grid-cols-2 gap-2">
        <button className="btn btn-secondary" disabled={busy || !value} onClick={onTest}>{t.testPrint}</button>
        <button className="btn btn-primary" onClick={onSave}>{t.save}</button>
      </div>
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
  const [f, setF] = useState({ shop_name: settings.shop_name ?? '', ticket_footer: settings.ticket_footer ?? '', allow_negative_stock: !!settings.allow_negative_stock });
  const save = async () => {
    try { await api('/settings', { method: 'PUT', body: f }); await reloadAll(); notify(t.saved); } catch (e) { notify(errText(t, e.code), 'err'); }
  };
  return (
    <section className="card space-y-3 p-4">
      <h2 className="font-bold">{t.shop}</h2>
      <div><label className="label">{t.shopName}</label><input className="input" value={f.shop_name} onChange={(e) => setF({ ...f, shop_name: e.target.value })} /></div>
      <div><label className="label">{t.ticketFooter}</label><input className="input" value={f.ticket_footer} onChange={(e) => setF({ ...f, ticket_footer: e.target.value })} /></div>
      <label className="flex items-center gap-3"><input type="checkbox" className="h-5 w-5" checked={f.allow_negative_stock} onChange={(e) => setF({ ...f, allow_negative_stock: e.target.checked })} />{t.allowNeg}</label>
      <button className="btn btn-primary w-full" onClick={save}>{t.save}</button>
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
