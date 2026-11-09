// Client HTTP + file d'attente hors-ligne des ventes.
const TOKEN_KEY = 'magasin.token';
const QUEUE_KEY = 'magasin.salesQueue';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

export class ApiError extends Error {
  constructor(status, code, data) { super(code); this.status = status; this.code = code; this.data = data; }
}

export async function api(path, { method = 'GET', body } = {}) {
  const token = getToken();
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'network'); // serveur injoignable
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== '/login') window.dispatchEvent(new Event('magasin:unauthorized'));
    throw new ApiError(res.status, data.error ?? 'error', data);
  }
  return data;
}

// ---- File d'attente : une vente faite sans réseau est gardée sur l'appareil puis renvoyée ----
export const readQueue = () => { try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) ?? []; } catch { return []; } };
const writeQueue = (q) => localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
export const enqueueSale = (entry) => writeQueue([...readQueue(), entry]);

let flushing = false;
/** Renvoie les ventes en attente. Retourne { sent, failed } ; les refus serveur (4xx) sont sortis de la file. */
export async function flushQueue() {
  if (flushing) return { sent: [], failed: [] };
  flushing = true;
  const sent = []; const failed = [];
  try {
    let queue = readQueue();
    while (queue.length) {
      const entry = queue[0];
      try {
        const sale = await api('/sales', { method: 'POST', body: entry.payload });
        sent.push(sale);
      } catch (e) {
        if (e.status === 0 || e.status >= 500 || e.status === 401) break; // on réessaiera plus tard
        failed.push({ entry, error: e.code, data: e.data });
      }
      queue = queue.slice(1);
      writeQueue(queue);
    }
  } finally { flushing = false; }
  return { sent, failed };
}
