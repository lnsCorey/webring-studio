import React, { useEffect, useRef, useState } from 'react';
import { Bot, ChevronDown, ChevronRight, Clock, ShieldAlert } from 'lucide-react';

/** mcpServer.ts McpPendingApproval. */
export interface McpApprovalView {
  id: string;
  toolName: string;
  tier: string;
  args: Record<string, unknown>;
  personaId: string;
  personaName: string;
  summary: string;
  client?: string;
  requestedAt: string;
  expiresAt: string;
  decidedAt?: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
}

const PERSONA_COLOURS = [
  'bg-indigo-500/20 text-indigo-200 border-indigo-400/40',
  'bg-emerald-500/20 text-emerald-200 border-emerald-400/40',
  'bg-sky-500/20 text-sky-200 border-sky-400/40',
  'bg-fuchsia-500/20 text-fuchsia-200 border-fuchsia-400/40',
  'bg-teal-500/20 text-teal-200 border-teal-400/40',
  'bg-orange-500/20 text-orange-200 border-orange-400/40',
];

/** The same colour for a persona everywhere, so a request for another persona stands out. */
export function PersonaChip(props: { personaId: string; name: string }) {
  let hash = 0;
  for (const ch of props.personaId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span className={`text-[11px] px-2 py-0.5 rounded-full border font-semibold ${PERSONA_COLOURS[hash % PERSONA_COLOURS.length]}`}>
      {props.name}
    </span>
  );
}

export function TierBadge(props: { tier: string }) {
  const outward = props.tier === 'outward';
  return (
    <span
      className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${
        outward ? 'bg-rose-500/20 text-rose-300' : 'bg-amber-500/20 text-amber-300'
      }`}
      title={outward ? 'Changes your public site, deletes, or contacts other sites' : 'Changes data in Studio only'}
    >
      {outward ? 'Outward' : 'Local write'}
    </span>
  );
}

const timeLeft = (expiresAt: string, now: number) => {
  const ms = Date.parse(expiresAt) - now;
  if (ms <= 0) return 'expired';
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `expires in ${min}:${String(sec).padStart(2, '0')}`;
};

/** Argument values that look like local file paths: shown in full, with the file name in bold. */
function localPaths(args: Record<string, unknown>): string[] {
  return Object.entries(args)
    .filter(([key, value]) => key !== 'personaId' && typeof value === 'string')
    .map(([, value]) => String(value))
    .filter((value) => /^([a-zA-Z]:[\\/]|\\\\|\/(?!\/))/.test(value));
}

function PathLine(props: { value: string }) {
  const cut = Math.max(props.value.lastIndexOf('/'), props.value.lastIndexOf('\\')) + 1;
  return (
    <span className="font-mono break-all">
      {props.value.slice(0, cut)}
      <strong className="text-white">{props.value.slice(cut)}</strong>
    </span>
  );
}

/**
 * An agent's request, one at a time ("1 of 3"), for the user to approve or deny. Deny has the
 * focus, Enter never approves (click Approve, or Tab to it and press Space), and Escape closes the
 * modal leaving the request waiting (it's in the MCP tab's review panel).
 */
export function McpApprovalModal(props: {
  pending: McpApprovalView[];
  /** Show this request first (Review in the panel); otherwise the oldest. */
  focusId?: string | null;
  onResolve: (item: McpApprovalView, approved: boolean) => Promise<void>;
  onDenyAll: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [now, setNow] = useState(Date.now());
  const denyRef = useRef<HTMLButtonElement>(null);
  const ordered = [...props.pending].sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  const index = Math.max(0, props.focusId ? ordered.findIndex((a) => a.id === props.focusId) : 0);
  const item = ordered[index];

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    setShowDetails(false);
    denyRef.current?.focus();
  }, [item?.id]);

  if (!item) return null;

  const decide = async (approved: boolean) => {
    setBusy(true);
    try {
      await props.onResolve(item, approved);
    } finally {
      setBusy(false);
    }
  };
  const paths = localPaths(item.args);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          props.onClose();
        }
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="mcp-approval-title"
        className="bg-slate-900 border border-rose-500/40 rounded-2xl p-6 w-full max-w-xl max-h-[90vh] overflow-y-auto space-y-4"
      >
        <div className="flex items-center justify-between gap-3 text-[11px] text-slate-400">
          <span className="flex items-center gap-1.5">
            <Bot className="w-4 h-4 text-indigo-300" /> Agent request{ordered.length > 1 ? ` · ${index + 1} of ${ordered.length}` : ''}
          </span>
          <span className="flex items-center gap-1">
            <Clock className="w-3.5 h-3.5" /> {timeLeft(item.expiresAt, now)}
          </span>
        </div>

        <h2 id="mcp-approval-title" className="text-base text-slate-100">
          An agent wants to <strong>{item.summary.charAt(0).toLowerCase() + item.summary.slice(1)}</strong>
        </h2>

        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
          <span className="text-slate-500">Persona</span>
          <PersonaChip personaId={item.personaId} name={item.personaName} />
          <TierBadge tier={item.tier} />
          {item.client && <span className="text-slate-400">from {item.client}</span>}
          <span className="text-slate-500">· asked {new Date(item.requestedAt).toLocaleTimeString()}</span>
        </div>

        {paths.length > 0 && (
          <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-300 space-y-1">
            <p className="text-slate-500">Files on this computer it uses:</p>
            {paths.map((value) => (
              <p key={value}>
                <PathLine value={value} />
              </p>
            ))}
          </div>
        )}

        <div>
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            className="text-xs text-slate-400 hover:text-slate-200 flex items-center gap-1"
            aria-expanded={showDetails}
          >
            {showDetails ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />} Show technical
            details
          </button>
          {showDetails && (
            <pre className="mt-2 text-[11px] text-slate-300 bg-slate-950 border border-slate-800 rounded-lg p-3 overflow-x-auto max-h-56">
              {item.toolName}
              {'\n'}
              {JSON.stringify(item.args, null, 2)}
            </pre>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await props.onDenyAll();
              } finally {
                setBusy(false);
              }
            }}
            className="text-xs text-slate-400 hover:text-rose-300 disabled:opacity-50"
          >
            Deny all pending{ordered.length > 1 ? ` (${ordered.length})` : ''}
          </button>
          <div className="flex gap-2">
            <button
              ref={denyRef}
              type="button"
              disabled={busy}
              onClick={() => void decide(false)}
              className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold disabled:opacity-50"
            >
              Deny
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void decide(true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.preventDefault();
              }}
              className="px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold disabled:opacity-50 flex items-center gap-1.5"
            >
              <ShieldAlert className="w-3.5 h-3.5" /> Approve
            </button>
          </div>
        </div>
        <p className="text-[11px] text-slate-500">Escape closes this and leaves the request waiting in the AI Agent (MCP) tab.</p>
      </div>
    </div>
  );
}

/** The MCP tab's list: requests waiting (with Review, Approve, Deny) and recent decisions. */
export function McpApprovalPanel(props: {
  pending: McpApprovalView[];
  history: McpApprovalView[];
  onReview: (item: McpApprovalView) => void;
  onResolve: (item: McpApprovalView, approved: boolean) => Promise<void>;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);
  const statusClass: Record<McpApprovalView['status'], string> = {
    pending: 'text-amber-300',
    approved: 'text-emerald-300',
    denied: 'text-rose-300',
    expired: 'text-slate-400',
  };
  return (
    <div className="border-t border-slate-800 pt-3 space-y-3">
      <div className="space-y-2">
        <div className="text-xs font-bold text-amber-300">Pending requests ({props.pending.length})</div>
        {props.pending.length === 0 ? (
          <p className="text-[11px] text-slate-500">Nothing is waiting. Outward requests from agents appear here and in a pop-up.</p>
        ) : (
          props.pending.map((item) => (
            <div key={item.id} className="p-3 rounded-xl bg-slate-950 border border-amber-500/30 flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-xs text-slate-100">{item.summary}</p>
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                  <PersonaChip personaId={item.personaId} name={item.personaName} />
                  <TierBadge tier={item.tier} />
                  {item.client && <span>from {item.client}</span>}
                  <span>{timeLeft(item.expiresAt, now)}</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => props.onReview(item)}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold"
                >
                  Review
                </button>
                <button
                  type="button"
                  onClick={() => void props.onResolve(item, true)}
                  className="px-3 py-1.5 rounded-lg bg-rose-600/80 hover:bg-rose-500 text-white text-xs font-semibold"
                >
                  Approve
                </button>
                <button
                  type="button"
                  onClick={() => void props.onResolve(item, false)}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold"
                >
                  Deny
                </button>
              </div>
            </div>
          ))
        )}
      </div>
      {props.history.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-xs font-bold text-slate-400">Recent decisions</div>
          {props.history.slice(0, 20).map((item) => (
            <div key={item.id} className="text-[11px] text-slate-400 flex flex-wrap items-center gap-2">
              <span className={`font-semibold uppercase ${statusClass[item.status]}`}>{item.status}</span>
              <span className="text-slate-300">{item.summary}</span>
              <PersonaChip personaId={item.personaId} name={item.personaName} />
              <span>{new Date(item.decidedAt || item.requestedAt).toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
