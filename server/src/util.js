// Petits outils partagés par les routes du serveur.
import { db } from './db.js';

export const fail = (status, error, extra = {}) =>
  Object.assign(new Error(error), { status, extra });

export const round3 = (n) => Math.round(Number(n) * 1000) / 1000;
export const toInt = (v) => Math.round(Number(v) || 0);
export const text = (v, max = 500) => String(v ?? '').trim().slice(0, max);
export const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? ''));

// Toutes les dates passent par SQLite : sous Windows, l'heure locale de Node peut différer de celle du PC
// (fuseau du Maroc, par exemple), ce qui décalerait les comparaisons avec les dates enregistrées en base.
export const localStamp = (d = null) =>
  db.prepare("SELECT datetime(COALESCE(?, 'now'), 'localtime') AS v").get(d ? new Date(d).toISOString() : null).v;
export const localDate = () => db.prepare("SELECT date('now', 'localtime') AS v").get().v;

// ---- Temps réel (Server-Sent Events) : le stock se met à jour sur tous les appareils ----
const sseClients = new Set();

export function addSseClient(res) {
  sseClients.add(res);
  return () => sseClients.delete(res);
}

export function broadcast(event, data = {}) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(msg);
}
