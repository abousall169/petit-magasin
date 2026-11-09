// Redonne un PIN à un gérant qui a oublié le sien. S'utilise sur le PC du magasin : reinitialiser-pin-gerant.bat
import { randomInt } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { db } from './db.js';
import { hashPin } from './auth.js';

const managers = db.prepare("SELECT id, name, active FROM employees WHERE role = 'manager' ORDER BY active DESC, name").all();
if (!managers.length) {
  console.error('Aucun gérant trouvé dans la base.');
  process.exit(1);
}

let target = managers[0];
if (managers.length > 1) {
  managers.forEach((m, i) => console.log(`  ${i + 1}. ${m.name}${m.active ? '' : ' (désactivé)'}`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const choice = Number(await rl.question('Numéro du gérant : '));
  rl.close();
  target = managers[choice - 1];
  if (!target) {
    console.error('Choix invalide : rien n\'a été modifié.');
    process.exit(1);
  }
}

const pin = String(randomInt(100000, 1000000));
const { hash, salt } = hashPin(pin);
db.prepare('UPDATE employees SET pin_hash = ?, pin_salt = ?, active = 1 WHERE id = ?').run(hash, salt, target.id);
db.prepare('DELETE FROM sessions WHERE employee_id = ?').run(target.id);
console.log(`\nGérant : ${target.name}\nNouveau PIN : ${pin}\nChangez-le ensuite dans Réglages.`);
