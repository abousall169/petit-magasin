import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { db } from './db.js';

export function hashPin(pin, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(String(pin), salt, 32).toString('hex');
  return { hash, salt };
}

export function verifyPin(pin, hash, salt) {
  const a = Buffer.from(hashPin(pin, salt).hash, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

// Anti force-brute : 5 essais ratés => blocage 1 minute par employé.
const attempts = new Map();
export function checkRateLimit(employeeId) {
  const a = attempts.get(employeeId);
  if (a && a.count >= 5 && Date.now() - a.last < 60_000) return false;
  return true;
}
export function recordAttempt(employeeId, ok) {
  if (ok) return attempts.delete(employeeId);
  const a = attempts.get(employeeId) ?? { count: 0, last: 0 };
  if (Date.now() - a.last >= 60_000) a.count = 0;
  attempts.set(employeeId, { count: a.count + 1, last: Date.now() });
}

export function createSession(employeeId) {
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token, employee_id) VALUES(?,?)').run(token, employeeId);
  return token;
}

/** Hook Fastify : exige un token Bearer valide, place l'employé dans req.user. */
export async function requireAuth(req, reply) {
  const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  const user = token && db.prepare(
    `SELECT e.id, e.name, e.role, e.lang FROM sessions s
     JOIN employees e ON e.id = s.employee_id
     WHERE s.token = ? AND e.active = 1`).get(token);
  if (!user) return reply.code(401).send({ error: 'unauthorized' });
  req.user = user;
}

export async function requireManager(req, reply) {
  if (req.user?.role !== 'manager') return reply.code(403).send({ error: 'forbidden' });
}
