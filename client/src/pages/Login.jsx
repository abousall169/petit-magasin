import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useI18n, errText } from '../i18n.js';

export default function Login({ onLogin }) {
  const { t, lang, setLang } = useI18n();
  const [employees, setEmployees] = useState(null);
  const [emp, setEmp] = useState(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { api('/employees/public').then(setEmployees).catch(() => setEmployees([])); }, []);

  const submit = async (p) => {
    setBusy(true); setError('');
    try {
      const r = await api('/login', { method: 'POST', body: { employeeId: emp.id, pin: p } });
      onLogin(r.token, r.user);
    } catch (e) {
      setError(e.status === 0 ? t.offline : errText(t, e.code)); setPin('');
    } finally { setBusy(false); }
  };

  const press = (d) => {
    if (busy) return;
    setError('');
    if (d === '⌫') return setPin((p) => p.slice(0, -1));
    const next = (pin + d).slice(0, 6);
    setPin(next);
  };

  return (
    <div className="mx-auto flex h-full max-w-md flex-col justify-center gap-4 p-5">
      <div className="flex items-center justify-between">
        <div className="text-2xl font-bold text-green-700">🛒 {t.appName}</div>
        <button className="btn btn-secondary !min-h-10 !py-1" onClick={() => setLang(lang === 'fr' ? 'ar' : 'fr')}>
          {lang === 'fr' ? 'عربي' : 'Français'}
        </button>
      </div>

      {!emp ? (
        <div className="card p-5">
          <h1 className="mb-4 text-xl font-bold">{t.whoAreYou}</h1>
          {employees === null ? <p className="text-slate-500">{t.loading}</p> : employees.length === 0 ? <p>{t.noEmployees}</p> : (
            <div className="grid gap-3">
              {employees.map((e) => (
                <button key={e.id} className="btn btn-secondary !justify-start !py-4 text-lg" onClick={() => setEmp(e)}>
                  👤 {e.name}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="card p-5">
          <button className="mb-2 text-sm text-slate-500" onClick={() => { setEmp(null); setPin(''); setError(''); }}>
            {lang === 'ar' ? '→' : '←'} {t.back}
          </button>
          <h1 className="text-xl font-bold">{emp.name}</h1>
          <p className="mb-4 text-slate-500">{t.enterPin}</p>
          <div className="mb-3 flex justify-center gap-3" dir="ltr">
            {Array.from({ length: Math.max(4, pin.length) }).map((_, i) => (
              <span key={i} className={`h-4 w-4 rounded-full ${i < pin.length ? 'bg-green-600' : 'bg-slate-300'}`} />
            ))}
          </div>
          <div className="mb-3 min-h-6 text-center font-medium text-red-600">{error}</div>
          <div className="grid grid-cols-3 gap-3" dir="ltr">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '✓'].map((k) => (
              <button key={k}
                className={`btn !text-2xl ${k === '✓' ? 'btn-primary' : 'btn-secondary'}`}
                disabled={busy || (k === '✓' && pin.length < 4)}
                onClick={() => (k === '✓' ? submit(pin) : press(k))}>
                {k}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
