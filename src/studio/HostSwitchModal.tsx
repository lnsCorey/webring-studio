import React, { useState } from 'react';
import { AlertTriangle, Globe, Server, Trash2, UploadCloud, X } from 'lucide-react';

export interface HostSwitchModalProps {
  previousMethod: 'github' | 'remote';
  previousLabel: string;
  previousSiteUrl: string;
  nextMethod: 'github' | 'remote';
  nextLabel: string;
  nextSiteUrl: string;
  busy: boolean;
  errorMessage?: string | null;
  onDeleteAndPublish: () => void;
  onKeepAndPublish: () => void;
  onCancel: () => void;
}

function methodLabel(method: 'github' | 'remote'): string {
  return method === 'github' ? 'GitHub Pages' : 'Web Host (SFTP / FTP)';
}

function normalizeUrl(u: string): string {
  return u.trim().replace(/\/+$/, '').toLowerCase();
}

export const HostSwitchModal: React.FC<HostSwitchModalProps> = ({
  previousMethod,
  previousLabel,
  previousSiteUrl,
  nextMethod,
  nextLabel,
  nextSiteUrl,
  busy,
  errorMessage,
  onDeleteAndPublish,
  onKeepAndPublish,
  onCancel,
}) => {
  const [confirmKeep, setConfirmKeep] = useState(false);

  const sameDomain =
    Boolean(previousSiteUrl.trim()) &&
    Boolean(nextSiteUrl.trim()) &&
    normalizeUrl(previousSiteUrl) === normalizeUrl(nextSiteUrl);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="host-switch-modal-title"
        className="w-full max-w-xl rounded-2xl bg-slate-900 border border-slate-700 p-6 shadow-2xl space-y-4"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />
            <h3 id="host-switch-modal-title" className="font-bold text-base text-white">
              Switch Deployment Host to {methodLabel(nextMethod)}?
            </h3>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="p-1 rounded-lg text-slate-400 hover:bg-slate-800 disabled:opacity-50"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1">
            <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold flex items-center gap-1.5">
              {previousMethod === 'github' ? (
                <Globe className="w-3.5 h-3.5 text-slate-400" />
              ) : (
                <Server className="w-3.5 h-3.5 text-slate-400" />
              )}
              Previously Published
            </div>
            <div className="font-semibold text-slate-200">{methodLabel(previousMethod)}</div>
            <div className="font-mono text-[11px] text-slate-400 break-all">{previousLabel}</div>
          </div>
          <div className="p-3 rounded-xl bg-slate-950 border border-indigo-500/40 space-y-1">
            <div className="text-[10px] uppercase tracking-wider text-indigo-300 font-semibold flex items-center gap-1.5">
              {nextMethod === 'github' ? (
                <Globe className="w-3.5 h-3.5 text-indigo-300" />
              ) : (
                <Server className="w-3.5 h-3.5 text-indigo-300" />
              )}
              New Destination
            </div>
            <div className="font-semibold text-white">{methodLabel(nextMethod)}</div>
            <div className="font-mono text-[11px] text-indigo-200 break-all">{nextLabel}</div>
          </div>
        </div>

        <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-300 space-y-2">
          <p className="font-semibold text-white">Why removing the old site matters (DID &amp; duplicate sites)</p>
          {sameDomain ? (
            <p className="text-slate-400">
              Your persona’s Site URL (<code className="text-slate-200">{nextSiteUrl}</code>) hasn’t changed,
              so DNS controls which host is live. Removing the old host’s copy is optional, but recommended so
              no stale copy of your signed <code className="text-slate-200">did.json</code> remains behind.
            </p>
          ) : (
            <p className="text-slate-400">
              Each persona has a single <code className="text-slate-200">siteUrl</code> and cryptographic{' '}
              <code className="text-slate-200">did:web</code> identity. Leaving an older copy online on a
              different host creates a duplicate site whose <code className="text-slate-200">did.json</code>{' '}
              and canonical post links no longer match, which can cause verification failures with friends and
              Webring Hubs.
            </p>
          )}
          <p className="text-[11px] text-slate-400">
            {previousMethod === 'github'
              ? 'Deleting the old GitHub Pages site disables GitHub Pages on that repository while preserving your repo and commit history.'
              : 'Deleting the old Web Host site removes only Webring Studio-managed files recorded in your publish ledger — unrelated files on your host are never touched.'}
          </p>
        </div>

        {errorMessage && (
          <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-200">
            {errorMessage}
          </div>
        )}

        {confirmKeep && (
          <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/40 text-xs text-amber-200 space-y-2.5">
            <p className="font-semibold flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              Warning: Keeping the old site live can cause DID conflicts
            </p>
            <p className="text-amber-100/90">
              Your old {methodLabel(previousMethod)} site will remain online alongside the new{' '}
              {methodLabel(nextMethod)} site. Friends or Webring Hubs crawling the old address may see
              mismatched <code className="text-amber-100">did:web</code> signatures or stale posts.
            </p>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                disabled={busy}
                onClick={onKeepAndPublish}
                className="px-3.5 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-semibold text-xs disabled:opacity-50"
              >
                {busy ? 'Publishing…' : 'Yes, keep old site & publish anyway'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmKeep(false)}
                className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs disabled:opacity-50"
              >
                Go back
              </button>
            </div>
          </div>
        )}

        {!confirmKeep && (
          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-800">
            <button
              type="button"
              disabled={busy}
              onClick={onDeleteAndPublish}
              className="px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs inline-flex items-center gap-2 shadow disabled:opacity-50"
            >
              <Trash2 className="w-4 h-4" />
              {busy ? 'Cleaning up & publishing…' : 'Delete old site & publish to new host'}
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmKeep(true)}
                className="px-3.5 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-xs inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                <UploadCloud className="w-3.5 h-3.5" />
                Keep old site
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={onCancel}
                className="px-3 py-2.5 rounded-xl bg-slate-950 hover:bg-slate-800 border border-slate-800 text-slate-400 text-xs disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
