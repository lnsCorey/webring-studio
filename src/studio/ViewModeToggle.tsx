import React from 'react';
import { LayoutGrid, List } from 'lucide-react';

export type StudioViewMode = 'cards' | 'list';

export function loadViewMode(storageKey: string, fallback: StudioViewMode): StudioViewMode {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === 'cards' || saved === 'list') return saved;
  } catch {
    // Ignore storage errors
  }
  return fallback;
}

export function saveViewMode(storageKey: string, mode: StudioViewMode): void {
  try {
    localStorage.setItem(storageKey, mode);
  } catch {
    // Ignore storage errors
  }
}

export function ViewModeToggle(props: {
  mode: StudioViewMode;
  onChange: (mode: StudioViewMode) => void;
  ariaLabel?: string;
}) {
  const { mode, onChange, ariaLabel = 'Display mode' } = props;
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex items-center p-0.5 rounded-xl bg-slate-950 border border-slate-800"
    >
      <button
        type="button"
        onClick={() => onChange('cards')}
        aria-pressed={mode === 'cards'}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition ${
          mode === 'cards'
            ? 'bg-indigo-600 text-white shadow'
            : 'text-slate-400 hover:text-white'
        }`}
        title="Card view"
      >
        <LayoutGrid className="w-3.5 h-3.5" />
        <span>Cards</span>
      </button>
      <button
        type="button"
        onClick={() => onChange('list')}
        aria-pressed={mode === 'list'}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition ${
          mode === 'list'
            ? 'bg-indigo-600 text-white shadow'
            : 'text-slate-400 hover:text-white'
        }`}
        title="List view"
      >
        <List className="w-3.5 h-3.5" />
        <span>List</span>
      </button>
    </div>
  );
}
