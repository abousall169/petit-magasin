import forge from 'node-forge';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { hostname, networkInterfaces } from 'node:os';
import { DATA_DIR } from './db.js';

const DAY = 86400_000;
const CERT_DIR = resolve(DATA_DIR, 'certs');
const f = (n) => resolve(CERT_DIR, n);

export function lanIPs() {
  return Object.values(networkInterfaces()).flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);
}

// Clé RSA générée par node:crypto (rapide), convertie pour node-forge.
function newKey() {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const priv = forge.pki.privateKeyFromPem(privateKey);
  return { pem: privateKey, priv, pub: forge.pki.setRsaPublicKey(priv.n, priv.e) };
}

const serial = () => '01' + randomBytes(15).toString('hex');

function makeCA() {
  const k = newKey();
  const cert = forge.pki.createCertificate();
  cert.publicKey = k.pub; cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - DAY);
  cert.validity.notAfter = new Date(Date.now() + 3650 * DAY);
  const subject = [{ name: 'commonName', value: 'Caisse Magasin - Autorite locale' }, { name: 'organizationName', value: 'Caisse Magasin' }];
  cert.setSubject(subject); cert.setIssuer(subject);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(k.priv, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: k.pem };
}

function makeLeaf(ca, names, ips) {
  const k = newKey();
  const caCert = forge.pki.certificateFromPem(ca.certPem);
  const caKey = forge.pki.privateKeyFromPem(ca.keyPem);
  const cert = forge.pki.createCertificate();
  cert.publicKey = k.pub; cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - DAY);
  cert.validity.notAfter = new Date(Date.now() + 800 * DAY); // < 825 jours : limite d'iOS
  cert.setSubject([{ name: 'commonName', value: 'Caisse Magasin' }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [
      ...names.map((value) => ({ type: 2, value })),
      ...ips.map((ip) => ({ type: 7, ip })),
    ] },
    { name: 'subjectKeyIdentifier' },
    { name: 'authorityKeyIdentifier', keyIdentifier: caCert.generateSubjectKeyIdentifier().getBytes() },
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: k.pem, notAfter: cert.validity.notAfter.getTime() };
}

/**
 * Prépare le HTTPS : crée l'autorité locale une seule fois, puis (ré)émet le certificat du serveur
 * quand l'adresse IP du PC change ou qu'il expire bientôt. Les téléphones ne font confiance qu'à
 * l'autorité : ils n'ont donc rien à refaire quand le certificat est renouvelé.
 */
export function ensureTls() {
  mkdirSync(CERT_DIR, { recursive: true });
  // Ancienne autorité avec un accent (« é » interdit en PrintableString → ERR_SSL_SERVER_CERT_BAD_FORMAT) : on la refait.
  const caBad = existsSync(f('ca.pem'))
    && forge.pki.certificateFromPem(readFileSync(f('ca.pem'), 'utf8')).subject.attributes.some((a) => /[^\x00-\x7f]/.test(a.value));
  if (caBad) {
    for (const n of ['ca.pem', 'ca-key.pem', 'server.pem', 'server-key.pem', 'server.json']) rmSync(f(n), { force: true });
    console.log('🔐 Ancienne autorité invalide supprimée : les appareils doivent réinstaller le certificat (/install).');
  }
  if (!existsSync(f('ca.pem')) || !existsSync(f('ca-key.pem'))) {
    const ca = makeCA();
    writeFileSync(f('ca.pem'), ca.certPem);
    writeFileSync(f('ca-key.pem'), ca.keyPem, { mode: 0o600 });
    console.log('🔐 Autorité de certification locale créée.');
  }
  const ca = { certPem: readFileSync(f('ca.pem'), 'utf8'), keyPem: readFileSync(f('ca-key.pem'), 'utf8') };

  const host = hostname().toLowerCase();
  const extra = (process.env.TLS_NAMES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const isIp = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
  const names = [...new Set(['localhost', host, `${host}.local`, ...extra.filter((s) => !isIp(s))])];
  const ips = [...new Set(['127.0.0.1', ...lanIPs(), ...extra.filter(isIp)])];
  const want = JSON.stringify({ names: [...names].sort(), ips: [...ips].sort() });

  let meta = null;
  try { meta = JSON.parse(readFileSync(f('server.json'), 'utf8')); } catch { /* première fois */ }
  if (!meta || meta.want !== want || meta.notAfter - Date.now() < 30 * DAY || !existsSync(f('server.pem'))) {
    const leaf = makeLeaf(ca, names, ips);
    writeFileSync(f('server.pem'), leaf.certPem);
    writeFileSync(f('server-key.pem'), leaf.keyPem, { mode: 0o600 });
    writeFileSync(f('server.json'), JSON.stringify({ want, notAfter: leaf.notAfter }));
    console.log(`🔐 Certificat HTTPS émis pour : ${[...names, ...ips].join(', ')}`);
  }
  return { key: readFileSync(f('server-key.pem')), cert: readFileSync(f('server.pem')), caPem: ca.certPem };
}
