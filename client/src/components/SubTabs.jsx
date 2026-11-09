/** Onglets secondaires en haut d'une page. tabs = [[id, libellé], …] */
export default function SubTabs({ tabs, value, onChange }) {
  return (
    <div className="flex gap-2 overflow-x-auto border-b border-slate-200 bg-white px-3 py-2">
      {tabs.map(([id, label]) => (
        <button key={id} onClick={() => onChange(id)}
          className={`whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium ${value === id ? 'bg-green-600 text-white' : 'bg-slate-100 text-slate-700'}`}>
          {label}
        </button>
      ))}
    </div>
  );
}
