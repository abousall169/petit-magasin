// Sauvegardes : copie quotidienne, copie vers un autre dossier (clé USB, dossier synchronisé), téléchargement, restauration.
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { db, DATA_DIR, getSetting, setSetting } from './db.js';
import { migrate } from './migrations.js';
import { fail, broadcast, localDate, localStamp, text } from './util.js';

const DIR = resolve(DATA_DIR, 'backups');
const SAFE_NAME = /^magasin-[\w.-]+\.db$/;
const DAILY_NAME = /^magasin-\d{4}-\d{2}-\d{2}\.db$/;
const KEEP_DAYS = 14;
const quote = (s) => `'${s.replace(/'/g, "''")}'`;
const stamp = () => localStamp().replace(/[: ]/g, '-');

/** Photo cohérente de la base, même pendant que la caisse travaille. */
function snapshot(name) {
  mkdirSync(DIR, { recursive: true });
  const tmp = resolve(DIR, `${name}.tmp`);
  rmSync(tmp, { force: true });
  db.exec(`VACUUM INTO ${quote(tmp)}`);
  renameSync(tmp, resolve(DIR, name));
  return name;
}

function copyOutside(name) {
  const target = getSetting('backup_dir', '');
  if (!target) return;
  try {
    if (!existsSync(target)) throw new Error('dossier introuvable');
    copyFileSync(resolve(DIR, name), resolve(target, name));
    setSetting('backup_last_copy', JSON.stringify({ at: localStamp(), ok: true, file: name }));
  } catch (e) {
    setSetting('backup_last_copy', JSON.stringify({ at: localStamp(), ok: false, error: e.message }));
  }
}

function purgeOld() {
  for (const f of readdirSync(DIR)) {
    if (!DAILY_NAME.test(f)) continue;
    const p = resolve(DIR, f);
    if (Date.now() - statSync(p).mtimeMs > KEEP_DAYS * 86400_000) rmSync(p, { force: true });
  }
}

export function dailyBackup() {
  try {
    const name = snapshot(`magasin-${localDate()}.db`);
    copyOutside(name);
    purgeOld();
  } catch (e) { console.error('Sauvegarde échouée :', e.message); }
}

function listFiles() {
  mkdirSync(DIR, { recursive: true });
  return readdirSync(DIR).filter((f) => SAFE_NAME.test(f))
    .map((name) => { const s = statSync(resolve(DIR, name)); return { name, size: s.size, date: localStamp(s.mtime) }; })
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** Remplace le contenu de la base par celui d'un fichier de sauvegarde, sans redémarrer le serveur. */
function restoreFrom(source) {
  const tmp = resolve(DIR, `restauration-${Date.now()}.tmp`);
  copyFileSync(source, tmp);
  try {
    const check = new DatabaseSync(tmp);
    try {
      if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('corrompu');
      for (const t of ['employees', 'products', 'sales']) check.prepare(`SELECT COUNT(*) FROM ${t}`).get();
      migrate(check);
    } catch { throw fail(400, 'invalid_backup'); } finally { check.close(); }

    const safety = snapshot(`magasin-avant-restauration-${stamp()}.db`);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'sessions'")
      .all().map((x) => x.name);
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`ATTACH DATABASE ${quote(tmp)} AS restored`);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('DELETE FROM main.sessions');
      for (const t of tables) db.exec(`DELETE FROM main."${t}"`);
      for (const t of tables) {
        const cols = db.prepare(`PRAGMA restored.table_info("${t}")`).all().map((c) => `"${c.name}"`).join(', ');
        if (cols) db.exec(`INSERT INTO main."${t}" (${cols}) SELECT ${cols} FROM restored."${t}"`);
      }
      if (db.prepare('PRAGMA main.foreign_key_check').all().length) throw fail(400, 'invalid_backup');
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; } finally {
      db.exec('DETACH DATABASE restored');
      db.exec('PRAGMA foreign_keys = ON');
    }
    return safety;
  } finally {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${tmp}${suffix}`, { force: true });
  }
}

export function backupRoutes(mgr) {
  mgr.get('/api/backups', async () => {
    let lastCopy = null;
    try { lastCopy = JSON.parse(getSetting('backup_last_copy', 'null')); } catch { /* jamais copié */ }
    return { files: listFiles(), dir: getSetting('backup_dir', ''), lastCopy };
  });

  mgr.post('/api/backups', async () => {
    const name = snapshot(`magasin-${localDate()}.db`);
    copyOutside(name);
    return { name };
  });

  mgr.put('/api/backups/dir', async (req) => {
    const dir = text(req.body?.dir, 300);
    if (dir && !existsSync(dir)) throw fail(400, 'backup_dir_missing');
    setSetting('backup_dir', dir);
    if (dir) copyOutside(snapshot(`magasin-${localDate()}.db`));
    return { ok: true };
  });

  mgr.get('/api/backups/:name', async (req, reply) => {
    const { name } = req.params;
    const file = resolve(DIR, name);
    if (!SAFE_NAME.test(name) || !existsSync(file)) throw fail(404, 'not_found');
    return reply.type('application/octet-stream').header('Content-Disposition', `attachment; filename="${name}"`).send(createReadStream(file));
  });

  mgr.post('/api/backups/:name/restore', async (req) => {
    const { name } = req.params;
    const file = resolve(DIR, name);
    if (!SAFE_NAME.test(name) || !existsSync(file)) throw fail(404, 'not_found');
    const safety = restoreFrom(file);
    broadcast('stock', {});
    return { ok: true, safety };
  });

  // Restauration depuis un fichier choisi sur l'appareil
  mgr.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 512 * 1024 * 1024 }, (req, body, done) => done(null, body));
  mgr.post('/api/backups-upload/restore', { bodyLimit: 512 * 1024 * 1024 }, async (req) => {
    if (!Buffer.isBuffer(req.body) || req.body.length < 100) throw fail(400, 'invalid_backup');
    mkdirSync(DIR, { recursive: true });
    const file = resolve(DIR, `envoi-${Date.now()}.tmp`);
    writeFileSync(file, req.body);
    try {
      const safety = restoreFrom(file);
      broadcast('stock', {});
      return { ok: true, safety };
    } finally { rmSync(file, { force: true }); }
  });
}
