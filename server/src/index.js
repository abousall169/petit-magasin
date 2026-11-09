import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync, copyFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, seedIfEmpty, DATA_DIR } from './db.js';
import routes from './routes.js';
import installPlugin from './install.js';
import { ensureTls, lanIPs } from './tls.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTTP_PORT = Number(process.env.PORT) || 3000;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 3443;
const HTTPS_ON = process.env.NO_HTTPS !== '1';

seedIfEmpty();

// HTTPS : requis par les navigateurs pour la caméra et le mode hors-ligne sur téléphone.
let tls = null;
if (HTTPS_ON) {
  try { tls = ensureTls(); } catch (e) { console.error('HTTPS indisponible :', e.message); }
}

const dist = resolve(__dirname, '../../client/dist');

async function buildApp(opts = {}) {
  const app = Fastify({ logger: { level: 'warn' }, trustProxy: true, ...opts });
  await app.register(routes);
  await app.register(installPlugin, { caPem: tls?.caPem ?? '', httpsPort: HTTPS_PORT });
  if (existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api') ? reply.code(404).send({ error: 'not_found' }) : reply.sendFile('index.html'));
  }
  return app;
}

// Sauvegarde quotidienne (garde 14 jours) : data/backups/magasin-AAAA-MM-JJ.db
function backup() {
  const dir = resolve(DATA_DIR, 'backups');
  const day = new Date().toLocaleDateString('sv-SE');
  const file = resolve(dir, `magasin-${day}.db`);
  try {
    mkdirSync(dir, { recursive: true });
    if (!existsSync(file)) {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      setTimeout(() => {
        copyFileSync(resolve(DATA_DIR, 'magasin.db'), file);
        for (const f of readdirSync(dir)) {
          const p = resolve(dir, f);
          if (Date.now() - statSync(p).mtimeMs > 14 * 86400_000) unlinkSync(p);
        }
      }, 500);
    }
  } catch (e) { console.error('Sauvegarde échouée :', e.message); }
}
backup();
setInterval(backup, 6 * 3600_000);

const http = await buildApp();
await http.listen({ port: HTTP_PORT, host: '0.0.0.0' });
if (tls) {
  const https = await buildApp({ https: { key: tls.key, cert: tls.cert } });
  await https.listen({ port: HTTPS_PORT, host: '0.0.0.0' });
}

console.log('\n✅ Caisse démarrée');
for (const ip of lanIPs()) {
  if (tls) console.log(`   📱 Téléphones/tablettes : https://${ip}:${HTTPS_PORT}   (1re fois : http://${ip}:${HTTP_PORT}/install)`);
  else console.log(`   📱 Téléphones/tablettes : http://${ip}:${HTTP_PORT}`);
}
console.log(`   💻 Sur ce PC : http://localhost:${HTTP_PORT}`);
