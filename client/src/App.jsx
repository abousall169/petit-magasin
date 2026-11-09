import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, getToken, setToken, flushQueue, readQueue, readRejected, retryRejected, dropRejected } from './api.js';
import { dict, errText, I18nContext, LANGS } from './i18n.js';
import { AppContext } from './ctx.js';
import { printReceiptBitmap } from './printer.js';
import { money, setCurrency } from './format.js';
import Login from './pages/Login.jsx';
import Sell from './pages/Sell.jsx';
import History from './pages/History.jsx';
import Customers from './pages/Customers.jsx';
import Stock from './pages/Stock.jsx';
import Manage from './pages/Manage.jsx';
import Settings from './pages/Settings.jsx';
import Modal from './components/Modal.jsx';

const cacheGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const USER_KEY = 'magasin.user';
const LANG_BUTTON = { fr: 'FR', ar: 'عربي', en: 'EN' };

export default function App() {
  const [lang, setLangState] = useState(() => localStorage.getItem('magasin.lang') || 'fr');
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(!!getToken());
  const [products, setProducts] = useState(() => cacheGet('magasin.products', []));
  const [categories, setCategories] = useState(() => cacheGet('magasin.categories', []));
  const [customers, setCustomers] = useState(() => cacheGet('magasin.customers', []));
  const [settings, setSettings] = useState(() => cacheGet('magasin.settings', { shop_name: '', currency: 'FCFA' }));
  const [page, setPage] = useState('sell');
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(readQueue().length);
  const [rejected, setRejected] = useState(readRejected());
  const [showRejected, setShowRejected] = useState(false);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef();

  const t = dict[lang] ?? dict.fr;
  setCurrency(settings.currency);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    localStorage.setItem('magasin.lang', lang);
  }, [lang]);

  const setLang = useCallback((l) => {
    setLangState(l);
    if (getToken()) api('/me/lang', { method: 'PUT', body: { lang: l } }).catch(() => {});
  }, []);

  const notify = useCallback((msg, kind = 'ok') => {
    setToast({ msg, kind });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }, []);

  const reloadProducts = useCallback(async () => {
    try {
      const p = await api(`/products${user?.role === 'manager' ? '?all=1' : ''}`);
      setProducts(p); localStorage.setItem('magasin.products', JSON.stringify(p));
      setOnline(true);
    } catch (e) { if (e.status === 0) setOnline(false); }
  }, [user?.role]);

  const reloadCustomers = useCallback(async () => {
    try {
      const c = await api('/customers');
      setCustomers(c); localStorage.setItem('magasin.customers', JSON.stringify(c));
    } catch { /* garde le cache */ }
  }, []);

  const reloadAll = useCallback(async () => {
    await reloadProducts();
    await reloadCustomers();
    try {
      const [c, s] = await Promise.all([api('/categories'), api('/settings')]);
      setCategories(c); setSettings(s);
      localStorage.setItem('magasin.categories', JSON.stringify(c));
      localStorage.setItem('magasin.settings', JSON.stringify(s));
    } catch { /* garde le cache */ }
  }, [reloadProducts, reloadCustomers]);

  // Reprise de session : sans réseau, l'application s'ouvre avec le dernier compte connecté.
  useEffect(() => {
    if (!getToken()) return;
    api('/me').then((u) => {
      setUser(u); setLangState(u.lang);
      localStorage.setItem(USER_KEY, JSON.stringify(u));
    }).catch((e) => {
      if (e.status === 401) { setToken(null); localStorage.removeItem(USER_KEY); return; }
      const cached = cacheGet(USER_KEY, null);
      if (cached) setUser(cached);
      setOnline(false);
    }).finally(() => setBooting(false));
  }, []);
  useEffect(() => {
    const h = () => { setToken(null); setUser(null); localStorage.removeItem(USER_KEY); };
    window.addEventListener('magasin:unauthorized', h);
    return () => window.removeEventListener('magasin:unauthorized', h);
  }, []);

  const printOptions = useMemo(() => ({
    lang, t, shop: settings.shop_name, footer: settings.ticket_footer, paper: settings.paper_width,
    address: settings.shop_address, phone: settings.shop_phone, taxId: settings.shop_tax_id,
  }), [lang, t, settings]);

  // Imprime le ticket : imprimante thermique si configurée, sinon impression du navigateur.
  const printSale = useCallback(async (sale) => {
    if (!settings.printer) return window.print();
    try {
      await printReceiptBitmap(sale, printOptions);
      notify(t.printSent);
    } catch (e) {
      notify(`${t.printFailed}${e.data?.detail ? ` : ${e.data.detail}` : e.status === 0 ? ` (${t.offline})` : ''}`, 'err');
    }
  }, [settings.printer, printOptions, t, notify]);
  const printRef = useRef(printSale);
  printRef.current = printSale;

  const syncQueue = useCallback(async () => {
    const { sent, rejected: refused } = await flushQueue();
    setPending(readQueue().length);
    setRejected(readRejected());
    if (sent.length) {
      notify(`${sent.length} ✓`);
      reloadProducts();
      reloadCustomers();
      for (const { sale, entry } of sent) if (entry.print) printRef.current(sale);
    }
    if (refused) { notify(`${t.syncFailed} (${refused})`, 'err'); setShowRejected(true); }
  }, [notify, reloadProducts, reloadCustomers, t]);

  // Données + temps réel + envoi des ventes en attente
  const wasOffline = useRef(false);
  useEffect(() => {
    if (!user) return;
    reloadAll();
    let timer;
    let customersTimer;
    syncQueue();
    const iv = setInterval(syncQueue, 15000);
    window.addEventListener('online', syncQueue);

    const es = new EventSource(`/api/events?token=${getToken()}`);
    es.addEventListener('stock', () => { clearTimeout(timer); timer = setTimeout(reloadProducts, 300); });
    es.addEventListener('customers', () => { clearTimeout(customersTimer); customersTimer = setTimeout(reloadCustomers, 300); });
    es.addEventListener('settings', () => reloadAll());
    es.onopen = () => {
      setOnline(true);
      if (wasOffline.current) { wasOffline.current = false; reloadAll(); syncQueue(); }
    };
    es.onerror = () => { wasOffline.current = true; setOnline(false); };
    return () => { es.close(); clearInterval(iv); clearTimeout(timer); clearTimeout(customersTimer); window.removeEventListener('online', syncQueue); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const logout = useCallback(async () => {
    await flushQueue(); // les ventes en attente partent avant la fermeture de la session
    setPending(readQueue().length);
    await api('/logout', { method: 'POST' }).catch(() => {});
    setToken(null); setUser(null); setPage('sell');
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem('magasin.draft');
  }, []);

  const onLogin = (token, u) => {
    setToken(token); setUser(u); setLangState(u.lang); setPage('sell');
    localStorage.setItem(USER_KEY, JSON.stringify(u));
  };

  const ctx = useMemo(() => ({
    user, products, categories, customers, settings, online, pending, setPending, notify,
    reloadProducts, reloadCustomers, reloadAll, logout, lang, setLang, t, printSale,
  }), [user, products, categories, customers, settings, online, pending, notify, reloadProducts, reloadCustomers, reloadAll, logout, lang, setLang, t, printSale]);

  if (booting) return <div className="grid h-full place-items-center text-slate-500">{t.loading}</div>;

  const isManager = user?.role === 'manager';
  const tabs = [
    { id: 'sell', label: t.navSell, icon: '🛒' },
    { id: 'history', label: t.navHistory, icon: '🧾' },
    { id: 'customers', label: t.navCustomers, icon: '👥' },
    ...(isManager ? [
      { id: 'stock', label: t.navStock, icon: '📦' },
      { id: 'manage', label: t.navManage, icon: '📊' },
    ] : []),
    { id: 'settings', label: t.navSettings, icon: '⚙️' },
  ];
  const nextLang = LANGS[(LANGS.indexOf(lang) + 1) % LANGS.length];

  return (
    <I18nContext.Provider value={{ lang, t, setLang }}>
      <AppContext.Provider value={ctx}>
        {!user ? (
          <Login onLogin={onLogin} />
        ) : (
          <div className="flex h-full flex-col">
            <header className="flex items-center justify-between gap-2 bg-green-700 px-4 py-2 text-white" style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }}>
              <div className="min-w-0">
                <div className="truncate font-bold">{settings.shop_name || t.appName}</div>
                <div className="truncate text-xs opacity-90">{user.name} · {isManager ? t.manager : t.sellerRole}</div>
              </div>
              <div className="flex items-center gap-2">
                {rejected.length > 0 && (
                  <button className="rounded-full bg-red-500 px-2 py-1 text-xs font-semibold" onClick={() => setShowRejected(true)}>⚠ {rejected.length}</button>
                )}
                {(!online || pending > 0) && (
                  <span className="rounded-full bg-amber-400 px-2 py-1 text-xs font-semibold text-slate-900">
                    {!online ? t.offline : ''}{pending > 0 ? ` ${pending} ⏳` : ''}
                  </span>
                )}
                <button className="rounded-lg bg-white/20 px-3 py-2 text-sm font-bold" onClick={() => setLang(nextLang)}>{LANG_BUTTON[nextLang]}</button>
                <button className="rounded-lg bg-white/20 px-3 py-2 text-sm" onClick={logout}>{t.logout}</button>
              </div>
            </header>

            <main className="min-h-0 flex-1 overflow-hidden">
              {page === 'sell' && <Sell />}
              {page === 'history' && <History />}
              {page === 'customers' && <Customers />}
              {page === 'stock' && isManager && <Stock />}
              {page === 'manage' && isManager && <Manage />}
              {page === 'settings' && <Settings />}
            </main>

            <nav className="grid border-t border-slate-200 bg-white" style={{ gridTemplateColumns: `repeat(${tabs.length}, 1fr)`, paddingBottom: 'env(safe-area-inset-bottom)' }}>
              {tabs.map((x) => (
                <button key={x.id} onClick={() => setPage(x.id)}
                  className={`flex flex-col items-center gap-0.5 py-2 text-xs font-medium ${page === x.id ? 'text-green-700' : 'text-slate-500'}`}>
                  <span className="text-xl">{x.icon}</span>{x.label}
                </button>
              ))}
            </nav>
          </div>
        )}
        {showRejected && (
          <Modal title={`⚠ ${t.rejectedSales}`} onClose={() => setShowRejected(false)}>
            <p className="mb-3 text-sm text-slate-600">{t.rejectedHint}</p>
            {rejected.map((r) => {
              const amount = (r.payload.payments ?? []).reduce((a, p) => a + p.amount, 0);
              return (
                <div key={r.payload.clientId} className="flex items-center justify-between gap-2 border-b border-slate-100 py-2 text-sm">
                  <span className="min-w-0">
                    <span className="block font-medium">{new Date(r.at).toLocaleString('sv-SE').slice(0, 16)}{amount ? ` · ${money(amount)}` : ''}</span>
                    <span className="block text-red-600">{errText(t, r.error)}</span>
                  </span>
                  <button className="btn btn-secondary !min-h-9 !w-9 shrink-0 !p-0" aria-label={t.delete}
                    onClick={() => { if (window.confirm(`${t.delete} ?`)) { dropRejected(r.payload.clientId); setRejected(readRejected()); } }}>×</button>
                </div>
              );
            })}
            {rejected.length > 0 && <button className="btn btn-primary mt-3 w-full" onClick={() => { retryRejected(); setRejected(readRejected()); setPending(readQueue().length); setShowRejected(false); syncQueue(); }}>{t.retry}</button>}
            {!rejected.length && <p className="py-6 text-center text-slate-400">{t.nothing}</p>}
          </Modal>
        )}
        {toast && (
          <div className={`fixed inset-x-4 top-16 z-[100] mx-auto max-w-md rounded-xl px-4 py-3 text-center font-medium text-white shadow-lg ${toast.kind === 'err' ? 'bg-red-600' : 'bg-slate-800'}`}>
            {toast.msg}
          </div>
        )}
      </AppContext.Provider>
    </I18nContext.Provider>
  );
}
