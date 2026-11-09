import { useEffect } from 'react';
import { createPortal } from 'react-dom';

/** Affiche children uniquement à l'impression, au format A4, puis prévient quand c'est terminé. */
export default function PrintA4({ children, onDone }) {
  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = '@page { size: A4; margin: 12mm }';
    document.head.appendChild(style);
    document.body.classList.add('print-a4');
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      style.remove();
      document.body.classList.remove('print-a4');
      window.removeEventListener('afterprint', finish);
      onDone?.();
    };
    window.addEventListener('afterprint', finish);
    const timer = setTimeout(() => window.print(), 80);
    return () => { clearTimeout(timer); window.removeEventListener('afterprint', finish); style.remove(); document.body.classList.remove('print-a4'); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return createPortal(<div id="a4-print">{children}</div>, document.body);
}
