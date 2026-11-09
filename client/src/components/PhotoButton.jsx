/** Bouton qui ouvre l'appareil photo (ou la galerie) du téléphone. Fonctionne même sans HTTPS. */
export default function PhotoButton({ onFile, children, className = 'btn btn-secondary', camera = true, multiple = false, disabled = false, title }) {
  return (
    <label className={`${className} cursor-pointer ${disabled ? 'pointer-events-none opacity-40' : ''}`} title={title}>
      <input type="file" accept="image/*" hidden multiple={multiple} {...(camera ? { capture: 'environment' } : {})}
        onChange={(e) => { const files = [...e.target.files]; e.target.value = ''; if (files.length) onFile(multiple ? files : files[0]); }} />
      {children}
    </label>
  );
}
