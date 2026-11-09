// Reconnaissance de produit par photo, 100 % locale : DINOv2-small (quantifié) tourne dans le navigateur
// et transforme une photo en « empreinte » de 768 nombres. Deux photos du même produit ont des empreintes proches.
import { api } from './api.js';

const MODEL_ID = 'Xenova/dinov2-small';
export const MODEL_TAG = 'dinov2-small-q8'; // doit correspondre à VISION_MODEL côté serveur
export const DIM = 768;

// Seuils de confiance (similarité cosinus entre l'empreinte de la photo et celle d'une photo de référence).
export const CONFIDENCE = { high: 0.78, low: 0.6 };

let loading = null;
/** Charge le modèle une seule fois (~24 Mo servis par le PC du magasin, puis en cache). */
export function loadVision(onProgress) {
  loading ??= (async () => {
    const tf = await import('@huggingface/transformers');
    const { env, AutoModel, AutoProcessor } = tf;
    env.allowRemoteModels = false; // rien ne sort du réseau local
    env.allowLocalModels = true;
    env.localModelPath = '/models/';
    env.backends.onnx.wasm.wasmPaths = '/ort/';
    const processor = await AutoProcessor.from_pretrained(MODEL_ID);
    const model = await AutoModel.from_pretrained(MODEL_ID, { dtype: 'q8', device: 'wasm', progress_callback: onProgress });
    return { tf, processor, model };
  })().catch((e) => { loading = null; throw e; });
  return loading;
}

/** Réduit la photo (les photos de téléphone font 12 Mpx) et fabrique une miniature carrée. */
export async function preparePhoto(file) {
  const bmp = await createImageBitmap(file); // respecte l'orientation EXIF
  const scale = Math.min(1, 448 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);

  const side = Math.min(bmp.width, bmp.height);
  const t = document.createElement('canvas'); t.width = t.height = 120;
  t.getContext('2d').drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, 120, 120);
  bmp.close?.();

  const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92));
  return { blob, thumb: t.toDataURL('image/jpeg', 0.7) };
}

const l2 = (v) => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; return v.map((x) => x / s); };

/** Photo -> empreinte normalisée (Float32Array de 768) = [jeton CLS | moyenne des patchs], chacun normalisé / √2. */
export async function embed(blob) {
  const { tf, processor, model } = await loadVision();
  const img = await tf.RawImage.fromBlob(blob);
  const out = await model(await processor(img));
  const h = out.last_hidden_state;
  const [, n, d] = h.dims;
  const data = h.data;
  const cls = Float32Array.from(data.subarray(0, d));
  const mean = new Float32Array(d);
  for (let i = 1; i < n; i++) for (let j = 0; j < d; j++) mean[j] += data[i * d + j] / (n - 1);
  const a = l2(cls); const b = l2(mean);
  const v = new Float32Array(2 * d);
  v.set(a, 0); v.set(b, d);
  for (let i = 0; i < v.length; i++) v[i] /= Math.SQRT2;
  return v;
}

export const toB64 = (f32) => {
  const u8 = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
};
export const fromB64 = (b64) => {
  const s = atob(b64); const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return new Float32Array(u8.buffer);
};

/** Photo -> { embedding (base64), thumb } prêts à être envoyés au serveur. */
export async function analyzePhoto(file) {
  const { blob, thumb } = await preparePhoto(file);
  return { embedding: toB64(await embed(blob)), thumb };
}

/** Empreintes de référence du magasin (revalidées par ETag : quasi gratuit quand rien n'a changé). */
export async function loadIndex() {
  const r = await api('/embeddings');
  return r.items.filter(() => r.model === MODEL_TAG).map((x) => ({ id: x.id, productId: x.productId, v: fromB64(x.v) }));
}

/** Meilleurs produits : pour chaque produit, la similarité de sa photo de référence la plus proche. */
export function rank(query, index, limit = 3) {
  const best = new Map();
  for (const it of index) {
    let dot = 0; const v = it.v;
    for (let i = 0; i < v.length; i++) dot += v[i] * query[i];
    if (dot > (best.get(it.productId) ?? -1)) best.set(it.productId, dot);
  }
  return [...best].map(([productId, score]) => ({ productId, score })).sort((a, b) => b.score - a.score).slice(0, limit);
}
