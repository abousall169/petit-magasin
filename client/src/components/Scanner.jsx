import { useEffect, useRef, useState } from 'react';
import Modal from './Modal.jsx';
import { useI18n } from '../i18n.js';

/**
 * Scan de code-barres avec la caméra. Nécessite HTTPS (ou localhost).
 * - Chrome/Edge Android : BarcodeDetector natif (rapide).
 * - Autres (iPhone, Firefox, ordinateurs) : décodeur ZXing en JavaScript, chargé à la demande.
 */
export default function Scanner({ onDetect, onClose }) {
  const { t } = useI18n();
  const videoRef = useRef();
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) { setError(t.scanNeedsHttps); return; }
    let stopped = false; let cleanup = () => {};
    const found = (code) => { if (stopped) return; stopped = true; navigator.vibrate?.(60); onDetect(code); };
    const video = { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } };

    (async () => {
      try {
        if ('BarcodeDetector' in window) {
          const detector = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'] });
          const stream = await navigator.mediaDevices.getUserMedia({ video });
          cleanup = () => stream.getTracks().forEach((tr) => tr.stop());
          const v = videoRef.current; v.srcObject = stream; await v.play();
          let timer;
          const tick = async () => {
            if (stopped) return;
            try { const codes = await detector.detect(v); if (codes[0]?.rawValue) return found(codes[0].rawValue); } catch { /* image pas prête */ }
            timer = setTimeout(tick, 150);
          };
          cleanup = ((c) => () => { clearTimeout(timer); c(); })(cleanup);
          tick();
        } else {
          const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([import('@zxing/browser'), import('@zxing/library')]);
          const hints = new Map([
            [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.QR_CODE]],
            [DecodeHintType.TRY_HARDER, true],
          ]);
          const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 100 });
          const controls = await reader.decodeFromConstraints({ video }, videoRef.current, (result) => { if (result) found(result.getText()); });
          cleanup = () => controls.stop();
          if (stopped) cleanup();
        }
      } catch (e) { console.error(e); if (!stopped) setError(t.scanUnsupported); }
    })();
    return () => { stopped = true; cleanup(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Modal title={t.scan} onClose={onClose}>
      {error ? <p className="rounded-xl bg-amber-50 p-4 text-amber-900">{error}</p> : (
        <>
          <video ref={videoRef} className="aspect-square w-full rounded-2xl bg-black object-cover" muted playsInline />
          <p className="mt-3 text-center text-sm text-slate-500">{t.scanning}</p>
        </>
      )}
    </Modal>
  );
}
