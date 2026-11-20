import React from 'react';
import { Bot, Eye, ShieldCheck } from 'lucide-react';

/** database.ts HeldAgentChange. */
export interface HeldAgentChangeView {
  tool: string;
  summary: string;
  at: string;
}

const relative = (iso: string) => {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const min = Math.round(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString();
};

/**
 * Changes an agent made that aren't published yet. Nothing publishes them (auto-publish,
 * scheduled publish, an agent's publish) until the user releases them here; a manual publish asks
 * first. Keep holding just closes the panel.
 */
export function HeldChangesPanel(props: {
  changes: HeldAgentChangeView[];
  onPreview: () => void;
  onRelease: () => Promise<void>;
  onKeepHolding: () => void;
}) {
  if (props.changes.length === 0) return null;
  return (
    <div id="held-changes-panel" className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/40 space-y-3">
      <div>
        <h4 className="font-bold text-sm text-amber-200 flex items-center gap-2">
          <Bot className="w-4 h-4" /> Agent changes waiting for your review ({props.changes.length})
        </h4>
        <p className="text-[11px] text-amber-200/70 mt-0.5">
          Nothing publishes these until you release them: not auto-publish, not a scheduled publish, not an agent.
        </p>
      </div>
      <ul className="space-y-1 max-h-48 overflow-y-auto">
        {[...props.changes].reverse().map((change, i) => (
          <li key={`${change.at}-${i}`} className="text-xs text-slate-200">
            {change.summary} <span className="text-slate-500">— {relative(change.at)}</span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={props.onPreview}
          className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold flex items-center gap-1.5"
        >
          <Eye className="w-3.5 h-3.5" /> Preview site
        </button>
        <button
          type="button"
          onClick={() => void props.onRelease()}
          className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold flex items-center gap-1.5"
        >
          <ShieldCheck className="w-3.5 h-3.5" /> Release for publishing
        </button>
        <button
          type="button"
          onClick={props.onKeepHolding}
          className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold"
        >
          Keep holding
        </button>
      </div>
    </div>
  );
}
