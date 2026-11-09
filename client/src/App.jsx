import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, getToken, setToken, flushQueue, readQueue } from './api.js';
import { dict, I18nContext } from './i18n.js';
import { AppContext } from './ctx.js';
import { printReceiptBitmap } from './printer.js';
import Login from './pages/Login.jsx';
import Sell from './pages/Sell.jsx';
import History from './pages/History.jsx';
import Products from './pages/Products.jsx';
import Report from './pages/Report.jsx';
import Settings from './pages/Settings.jsx';

const cacheGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };

export default function App() {
  const [lang, setLangState] = useState(() => localStorage.getItem('magasin.lang') || 'fr');
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(!!getToken());
  const [products, setProducts] = useState(() => cacheGet('magasin.products', []));
  const [categories, setCategories] = useState(() => cacheGet('magasin.categories', []));
  const [settings, setSettings] = useState(() => cacheGet('magasin.settings', { shop_name: '', currency: 'FCFA' }));
  const [page, setPage] = useState('sell');
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(readQueue().length);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef();

  const t = dict[lang];
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

  const reloadAll = useCallback(async () => {
    await reloadProducts();
    try {
      const [c, s] = await Promise.all([api('/categories'), api('/settings')]);
      setCategories(c); setSettings(s);
      localStorage.setItem('magasin.categories', JSON.stringify(c));
      localStorage.setItem('magasin.settings', JSON.stringify(s));
    } catch { /* garde le cache */ }
  }, [reloadProducts]);

  // Reprise de session
  useEffect(() => {
    if (!getToken()) return;
    api('/me').then((u) => { setUser(u); setLangState(u.lang); }).catch((e) => {
      if (e.status === 401) setToken(null); else setOnline(false);
    }).finally(() => setBooting(false));
  }, []);
  useEffect(() => {
    const h = () => { setToken(null); setUser(null); };
    window.addEventListener('magasin:unauthorized', h);
    return () => window.removeEventListener('magasin:unauthorized', h);
  }, []);

  // Données + temps réel + envoi des ventes en attente
  useEffect(() => {
    if (!user) return;
    reloadAll();
    let timer;
    const syncQueue = async () => {
      const { sent, failed } = await flushQueue();
      setPending(readQueue().length);
      if (sent.length) { notify(`${sent.length} ✓`); reloadProducts(); }
      if (failed.length) notify(`${t.syncFailed} (${failed.length})`, 'err');
    };
    syncQueue();
    const iv = setInterval(syncQueue, 15000);
    window.addEventListener('online', syncQueue);

    const es = new EventSource(`/api/events?token=${getToken()}`);
    es.addEventListener('stock', () => { clearTimeout(timer); timer = setTimeout(reloadProducts, 300); });
    es.onopen = () => setOnline(true);
    es.onerror = () => setOnline(false);
    return () => { es.close(); clearInterval(iv); clearTimeout(timer); window.removeEventListener('online', syncQueue); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const logout = useCallback(async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    setToken(null); setUser(null); setPage('sell');
  }, []);

  const onLogin = (token, u) => { setToken(token); setUser(u); setLangState(u.lang); setPage('sell'); };

  // Imprime le ticket : imprimante thermique si configurée, sinon impression du navigateur.
  const printSale = useCallback(async (sale) => {
    if (!settings.printer) return window.print();
    try {
      await printReceiptBitmap(sale, { lang, t, shop: settings.shop_name, footer: settings.ticket_footer });
      notify(t.printSent);
    } catch (e) {
      notify(`${t.printFailed}${e.data?.detail ? ` : ${e.data.detail}` : e.status === 0 ? ` (${t.offline})` : ''}`, 'err');
    }
  }, [settings, lang, t, notify]);

  const ctx = useMemo(() => ({
    user, products, categories, settings, online, pending, setPending, notify,
    reloadProducts, reloadAll, logout, lang, setLang, t, printSale,
  }), [user, products, categories, settings, online, pending, notify, reloadProducts, reloadAll, logout, lang, setLang, t, printSale]);

  if (booting) return <div className="grid h-full place-items-center text-slate-500">{t.loading}</div>;

  const isManager = user?.role === 'manager';
  const tabs = [
    { id: 'sell', label: t.navSell, icon: '🛒' },
    { id: 'history', label: t.navHistory, icon: '🧾' },
    ...(isManager ? [
      { id: 'products', label: t.navProducts, icon: '📦' },
      { id: 'report', label: t.navReport, icon: '📊' },
    ] : []),
    { id: 'settings', label: t.navSettings, icon: '⚙️' },
  ];

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
                {(!online || pending > 0) && (
                  <span className="rounded-full bg-amber-400 px-2 py-1 text-xs font-semibold text-slate-900">
                    {!online ? t.offline : ''}{pending > 0 ? ` ${pending} ⏳` : ''}
                  </span>
                )}
                <button className="rounded-lg bg-white/20 px-3 py-2 text-sm font-bold" onClick={() => setLang(lang === 'fr' ? 'ar' : 'fr')}>
                  {lang === 'fr' ? 'عربي' : 'FR'}
                </button>
                <button className="rounded-lg bg-white/20 px-3 py-2 text-sm" onClick={logout}>{t.logout}</button>
              </div>
            </header>

            <main className="min-h-0 flex-1 overflow-hidden">
              {page === 'sell' && <Sell />}
              {page === 'history' && <History />}
              {page === 'products' && isManager && <Products />}
              {page === 'report' && isManager && <Report />}
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
        {toast && (
          <div className={`fixed inset-x-4 top-16 z-[100] mx-auto max-w-md rounded-xl px-4 py-3 text-center font-medium text-white shadow-lg ${toast.kind === 'err' ? 'bg-red-600' : 'bg-slate-800'}`}>
            {toast.msg}
          </div>
        )}
      </AppContext.Provider>
    </I18nContext.Provider>
  );
}
