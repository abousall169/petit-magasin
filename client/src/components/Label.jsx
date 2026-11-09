import { createPortal } from 'react-dom';
import { bars, encode, humanReadable } from '../barcode.js';
import { money } from '../format.js';

/** Formats de feuille A4 d'étiquettes (zone utile 200 × 287 mm : marge de 5 mm pour les imprimantes de bureau). */
export const LAYOUTS = [
  { id: '3x8', cols: 3, rows: 8, name: '3 × 8 (≈ 67 × 36 mm)' },
  { id: '4x10', cols: 4, rows: 10, name: '4 × 10 (≈ 50 × 29 mm)' },
  { id: '5x13', cols: 5, rows: 13, name: '5 × 13 (≈ 40 × 22 mm)' },
];

export function BarcodeSvg({ code, className, style }) {
  const enc = encode(code);
  if (!enc) return null;
  const Q = 9, BH = 26, W = enc.bits.length + 2 * Q, H = BH + 11; // marges calmes obligatoires de 9 modules
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={className} style={style} role="img" aria-label={enc.text} shapeRendering="crispEdges">
      <rect width={W} height={H} fill="#fff" />
      {bars(enc.bits).map((b) => <rect key={b.x} x={Q + b.x} y={0} width={b.w} height={BH} fill="#000" />)}
      {humanReadable(enc).map((t, i) => (
        <text key={i} x={Q + t.x} y={BH + 9} fontSize="9" textAnchor={t.anchor} fontFamily="Consolas, 'Courier New', monospace" fill="#000">{t.s}</text>
      ))}
    </svg>
  );
}

/** Une étiquette : nom (FR + AR), prix, code-barres. Dimensions en mm. */
export function Label({ product, lang, showPrice = true, showAr = true, w, h, cutLines = false }) {
  const small = h < 25;
  const nameSize = h >= 33 ? '10.5pt' : h >= 26 ? '9pt' : '7pt';
  const priceSize = h >= 33 ? '14pt' : h >= 26 ? '11pt' : '9pt';
  const clamp = { display: '-webkit-box', WebkitBoxOrient: 'vertical', overflow: 'hidden', WebkitLineClamp: small ? 1 : 2, lineHeight: 1.15 };
  return (
    <div style={{ width: w ? `${w}mm` : '100%', height: h ? `${h}mm` : '100%', boxSizing: 'border-box', padding: '1.2mm 1.5mm', overflow: 'hidden',
      display: 'flex', flexDirection: 'column', justifyContent: 'space-between', textAlign: 'center', background: '#fff', color: '#000',
      outline: cutLines ? '0.2mm dashed #aaa' : 'none', outlineOffset: '-0.1mm' }}>
      <div>
        <div style={{ ...clamp, fontWeight: 700, fontSize: nameSize }}>{(lang === 'ar' && product.name_ar) || product.name_fr}</div>
        {showAr && !small && product.name_ar && lang !== 'ar' && <div dir="rtl" style={{ ...clamp, WebkitLineClamp: 1, fontSize: nameSize }}>{product.name_ar}</div>}
        {showAr && !small && lang === 'ar' && <div style={{ ...clamp, WebkitLineClamp: 1, fontSize: nameSize }}>{product.name_fr}</div>}
      </div>
      {showPrice && <div style={{ fontWeight: 800, fontSize: priceSize, lineHeight: 1.1 }}>{money(product.price)}</div>}
      <BarcodeSvg code={product.barcode} style={{ width: '100%', height: small ? '9mm' : 'auto', maxHeight: h ? `${h * 0.42}mm` : undefined }} />
    </div>
  );
}

/** Feuilles A4 invisibles à l'écran, imprimées par window.print() (voir index.css). */
export function LabelSheets({ items, layout, lang, showPrice, showAr, cutLines }) {
  const per = layout.cols * layout.rows;
  const pages = [];
  for (let i = 0; i < items.length; i += per) pages.push(items.slice(i, i + per));
  const w = 200 / layout.cols, h = 287 / layout.rows;
  return createPortal(
    <div id="labels-print">
      {pages.map((page, pi) => (
        <div key={pi} style={{ width: '210mm', height: '297mm', padding: '5mm', boxSizing: 'border-box', display: 'grid',
          gridTemplateColumns: `repeat(${layout.cols}, ${w}mm)`, gridAutoRows: `${h}mm`, pageBreakAfter: pi < pages.length - 1 ? 'always' : 'auto' }}>
          {page.map((p, i) => <Label key={i} product={p} lang={lang} showPrice={showPrice} showAr={showAr} w={w} h={h} cutLines={cutLines} />)}
        </div>
      ))}
    </div>, document.body);
}

/** Impression : force le format A4 sans marge pour cette impression seulement. */
export function printSheets() {
  const st = document.createElement('style');
  st.textContent = '@page { size: A4; margin: 0 }';
  document.head.appendChild(st);
  const done = () => { st.remove(); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
}
