// Prépare la reconnaissance par photo : le modèle et le moteur WebAssembly sont servis par le PC du magasin
// (aucun accès internet nécessaire ensuite). Idempotent : ne retélécharge pas ce qui existe déjà.
import { existsSync, mkdirSync, copyFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pub = resolve(root, 'public');

// 1) Moteur ONNX Runtime (WebAssembly), copié depuis node_modules
// npm « hisse » les dépendances à la racine du dépôt (workspaces) : on cherche aux deux endroits.
const ortDist = [resolve(root, 'node_modules/onnxruntime-web/dist'), resolve(root, '../node_modules/onnxruntime-web/dist')]
  .find((p) => existsSync(p));
if (!ortDist) { console.error('onnxruntime-web introuvable : lancez « npm install ».'); process.exit(1); }
mkdirSync(resolve(pub, 'ort'), { recursive: true });
// Plusieurs variantes : le moteur choisit celle que le navigateur supporte (asyncify, jspi ou standard).
const variants = ['asyncify', 'jspi', ''].flatMap((v) => ['mjs', 'wasm'].map((e) => `ort-wasm-simd-threaded${v ? '.' + v : ''}.${e}`));
for (const f of variants) {
  const dst = resolve(pub, 'ort', f);
  if (!existsSync(dst)) { copyFileSync(resolve(ortDist, f), dst); console.log('copié :', f); }
}

// 2) Modèle DINOv2-small quantifié (~24 Mo)
const MODEL = 'Xenova/dinov2-small';
const files = ['config.json', 'preprocessor_config.json', 'onnx/model_quantized.onnx'];
for (const f of files) {
  const dst = resolve(pub, 'models', MODEL, f);
  if (existsSync(dst) && statSync(dst).size > 0) continue;
  mkdirSync(dirname(dst), { recursive: true });
  console.log('téléchargement :', f);
  const res = await fetch(`https://huggingface.co/${MODEL}/resolve/main/${f}`);
  if (!res.ok) { console.error(`Échec (${res.status}) pour ${f} — la reconnaissance par photo sera indisponible.`); process.exit(0); }
  writeFileSync(dst, Buffer.from(await res.arrayBuffer()));
}
