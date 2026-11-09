import { useEffect, useRef, useState } from 'react';
import Modal from './Modal.jsx';
import PhotoButton from './PhotoButton.jsx';
import { useApp } from '../ctx.js';
import { pname } from '../i18n.js';
import { money, qtyFmt } from '../format.js';
import { CONFIDENCE, embed, loadIndex, loadVision, preparePhoto, rank } from '../vision.js';

/** Reconnaissance d'un article à partir d'une photo : propose les 3 produits les plus proches, le caissier confirme. */
export default function Recognize({ file: initialFile, onPick, onClose }) {
  const { products, lang, t } = useApp();
  const [file, setFile] = useState(initialFile);
  const [state, setState] = useState('loading'); // loading | analyzing | done | error
  const [progress, setProgress] = useState(null);
  const [preview, setPreview] = useState(null);
  const [results, setResults] = useState([]);
  const [indexSize, setIndexSize] = useState(0);
  const [ms, setMs] = useState(null);
  const run = useRef(0);

  useEffect(() => {
    const id = ++run.current; // ignore les analyses périmées (nouvelle photo prise entre-temps)
    (async () => {
      try {
        setState('loading'); setResults([]);
        const { blob, thumb } = await preparePhoto(file);
        if (id !== run.current) return;
        setPreview(thumb);
        await loadVision((p) => p.status === 'progress' && p.file?.endsWith('.onnx') && setProgress(Math.round(p.progress)));
        setState('analyzing');
        const t0 = performance.now();
        const [vec, index] = await Promise.all([embed(blob), loadIndex()]);
        if (id !== run.current) return;
        const active = new Map(products.filter((p) => p.active).map((p) => [p.id, p]));
        const ranked = rank(vec, index.filter((i) => active.has(i.productId)), 3)
          .map((r) => ({ ...r, product: active.get(r.productId) }));
        setIndexSize(index.length); setResults(ranked); setMs(Math.round(performance.now() - t0)); setState('done');
      } catch (e) {
        console.error(e);
        if (id === run.current) setState('error');
      }
    })();
  }, [file]); // eslint-disable-line react-hooks/exhaustive-deps

  const level = (s) => (s >= CONFIDENCE.high ? ['veryLikely', 'bg-green-100 text-green-800'] : s >= CONFIDENCE.low ? ['likely', 'bg-amber-100 text-amber-800'] : ['unsure', 'bg-slate-100 text-slate-600']);

  return (
    <Modal title={`📸 ${t.photoSearch}`} onClose={onClose}>
      <div className="flex gap-3">
        {preview && <img src={preview} alt="" className="h-24 w-24 shrink-0 rounded-xl object-cover" />}
        <div className="min-w-0 flex-1 text-sm text-slate-600">
          {state === 'loading' && <>{t.loadingModel}{progress != null && progress < 100 ? ` ${progress}%` : ''}</>}
          {state === 'analyzing' && t.analyzing}
          {state === 'error' && <span className="text-red-600">{t.visionError}</span>}
          {state === 'done' && (indexSize === 0 ? t.noRefPhotos : results[0]?.score >= CONFIDENCE.low ? t.whichOne : t.noMatch)}
        </div>
      </div>

      {(state === 'loading' || state === 'analyzing') && (
        <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full w-1/3 animate-pulse rounded-full bg-green-500" /></div>
      )}

      {state === 'done' && indexSize > 0 && (
        <div className="mt-4 space-y-2">
          {results.map((r, i) => {
            const [lv, cls] = level(r.score);
            return (
              <button key={r.productId} onClick={() => onPick(r.product)}
                className={`flex w-full items-center justify-between gap-3 rounded-2xl border p-3 text-start ${i === 0 && r.score >= CONFIDENCE.low ? 'border-green-500 bg-green-50' : 'border-slate-200 bg-white'}`}>
                <div className="min-w-0">
                  <div className="truncate font-semibold">{pname(r.product, lang)}</div>
                  <div className="text-sm text-slate-500">{money(r.product.price)} · {t.inStock}: {qtyFmt(r.product.stock)}</div>
                </div>
                <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${cls}`}>{t[lv]} · {Math.round(r.score * 100)}%</span>
              </button>
            );
          })}
        </div>
      )}
      {state === 'done' && ms != null && <div className="mt-2 text-end text-xs text-slate-300">{ms} ms</div>}

      <PhotoButton onFile={setFile} className="btn btn-secondary mt-4 w-full" disabled={state === 'loading' || state === 'analyzing'}>
        📸 {t.retake}
      </PhotoButton>
    </Modal>
  );
}
