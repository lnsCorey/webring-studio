import React from 'react';

export interface HorizontalTabItem<T extends string = string> {
  id: T;
  label: string;
  badge?: number;
  alert?: boolean;
  icon?: React.ReactNode;
}

export function HorizontalTabs<T extends string>(props: {
  tabs: Array<HorizontalTabItem<T>>;
  activeId: T;
  onChange: (id: T) => void;
  ariaLabel: string;
  className?: string;
}) {
  const { tabs, activeId, onChange, ariaLabel, className = '' } = props;

  const handleKeyDown = (e: React.KeyboardEvent, idx: number) => {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      onChange(tabs[(idx + 1) % tabs.length].id);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      onChange(tabs[(idx - 1 + tabs.length) % tabs.length].id);
    }
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={`flex flex-wrap gap-1.5 p-1.5 rounded-2xl bg-slate-900/90 border border-slate-800 ${className}`}
    >
      {tabs.map((tab, idx) => {
        const active = tab.id === activeId;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(e) => handleKeyDown(e, idx)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition cursor-pointer ${
              active
                ? 'bg-indigo-600 text-white shadow shadow-indigo-600/20'
                : 'text-slate-300 hover:bg-slate-800 hover:text-white'
            }`}
          >
            {tab.icon}
            <span>{tab.label}</span>
            {tab.alert && (
              <span
                className="w-1.5 h-1.5 rounded-full bg-amber-400"
                aria-hidden="true"
              />
            )}
            {tab.badge !== undefined && tab.badge > 0 && (
              <span
                className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono ${
                  active ? 'bg-indigo-800 text-indigo-100' : 'bg-slate-800 text-slate-400'
                }`}
              >
                {tab.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
