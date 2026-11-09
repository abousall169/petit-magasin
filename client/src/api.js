// Client HTTP + file d'attente hors-ligne des ventes.
const TOKEN_KEY = 'magasin.token';
const QUEUE_KEY = 'magasin.salesQueue';
const REJECTED_KEY = 'magasin.salesRejected';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

export class ApiError extends Error {
  constructor(status, code, data) { super(code); this.status = status; this.code = code; this.data = data; }
}

/** token : envoie la requête au nom d'une autre session (vente hors-ligne faite par un autre employé). */
export async function api(path, { method = 'GET', body, token, binary = false } = {}) {
  const auth = token ?? getToken();
  const type = binary ? 'application/octet-stream' : 'application/json';
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: { ...(body ? { 'Content-Type': type } : {}), ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      body: binary ? body : body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'network'); // serveur injoignable
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Une réponse tardive d'une session déjà fermée ne doit pas déconnecter l'employé suivant.
    if (res.status === 401 && path !== '/login' && !token && auth && auth === getToken()) {
      window.dispatchEvent(new Event('magasin:unauthorized'));
    }
    throw new ApiError(res.status, data.error ?? 'error', data);
  }
  return data;
}

/** Télécharge un fichier protégé (export CSV, sauvegarde). */
export async function download(path, filename) {
  let res;
  try {
    res = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${getToken()}` } });
  } catch {
    throw new ApiError(0, 'network');
  }
  if (!res.ok) throw new ApiError(res.status, 'error');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// ---- File d'attente : une vente faite sans réseau est gardée sur l'appareil puis renvoyée ----
const readList = (key) => { try { return JSON.parse(localStorage.getItem(key)) ?? []; } catch { return []; } };
const writeList = (key, list) => localStorage.setItem(key, JSON.stringify(list));

export const readQueue = () => readList(QUEUE_KEY);
const writeQueue = (q) => writeList(QUEUE_KEY, q);
export const enqueueSale = (entry) => writeQueue([...readQueue(), entry]);
export const requestQueuedPrint = (clientId) =>
  writeQueue(readQueue().map((e) => (e.payload.clientId === clientId ? { ...e, print: true } : e)));

// Une vente refusée au renvoi n'est jamais perdue : elle reste ici jusqu'à décision du gérant.
export const readRejected = () => readList(REJECTED_KEY);
export function retryRejected() {
  writeQueue([...readQueue(), ...readRejected().map(({ error, ...entry }) => entry)]);
  writeList(REJECTED_KEY, []);
}
export const dropRejected = (clientId) =>
  writeList(REJECTED_KEY, readRejected().filter((e) => e.payload.clientId !== clientId));

async function sendQueued(entry) {
  const body = { ...entry.payload, offline: true, soldAt: new Date(entry.at).toISOString() };
  try {
    return await api('/sales', { method: 'POST', body, token: entry.token });
  } catch (e) {
    // La session de l'employé a été fermée entre-temps : la vente passe au nom de la personne connectée.
    if (e.status === 401 && entry.token && entry.token !== getToken()) return api('/sales', { method: 'POST', body });
    throw e;
  }
}

let flushing = false;
/** Renvoie les ventes en attente. Retourne { sent: [{ sale, entry }], rejected: n }. */
export async function flushQueue() {
  if (flushing) return { sent: [], rejected: 0 };
  flushing = true;
  const sent = [];
  let rejected = 0;
  try {
    let queue = readQueue();
    while (queue.length) {
      const entry = queue[0];
      try {
        sent.push({ sale: await sendQueued(entry), entry });
      } catch (e) {
        if (e.status === 0 || e.status >= 500 || e.status === 401) break; // on réessaiera plus tard
        writeList(REJECTED_KEY, [...readRejected(), { ...entry, error: e.code }]);
        rejected += 1;
      }
      queue = queue.slice(1);
      writeQueue(queue);
    }
  } finally { flushing = false; }
  return { sent, rejected };
}
