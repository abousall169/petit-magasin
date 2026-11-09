import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedIfEmpty } from './db.js';
import routes from './routes.js';
import installPlugin from './install.js';
import { ensureTls, lanIPs } from './tls.js';
import { dailyBackup } from './backup.js';

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

const dist = process.env.CLIENT_DIST || resolve(__dirname, '../../client/dist');

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

// Sauvegarde refaite toutes les 6 heures (garde 14 jours) : data/backups/magasin-AAAA-MM-JJ.db
dailyBackup();
setInterval(dailyBackup, 6 * 3600_000);

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
