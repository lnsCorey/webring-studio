import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, KeyRound, Loader2, RefreshCw, ShieldAlert, X } from 'lucide-react';
import { fingerprintEnds, formatFingerprint } from '../shared/fingerprint';

/** The parts of a friend the dialog needs (schema.ts FriendConnection). */
export interface KeyChangeFriend {
  id: string;
  displayName: string;
  siteUrl: string;
  pinnedFingerprint?: string;
  candidateFingerprint?: string;
  candidateFirstSeenAt?: string;
  candidateConflict?: boolean;
}

const formatDate = (iso?: string) => {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
};

/**
 * Review a friend's changed signing key before trusting it. Shows the pinned key and the new one
 * side by side, so the user can compare the new fingerprint with the friend over another channel.
 * Trust sends the fingerprint shown here; the engine refuses it if the candidate has changed since.
 * Enter never trusts, Escape closes, and focus stays in the dialog.
 */
export function KeyChangeDialog(props: {
  friend: KeyChangeFriend;
  /** Optional hub witness check (WebringHubPanels KeyWitnessCheck). */
  witness?: React.ReactNode;
  onTrust: (friend: KeyChangeFriend, expectedFingerprint: string) => Promise<void>;
  onRecheck: (friend: KeyChangeFriend) => Promise<void>;
  onClose: () => void;
}) {
  const { friend } = props;
  const [busy, setBusy] = useState<'trust' | 'recheck' | null>(null);
  const [error, setError] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const candidate = friend.candidateFingerprint;
  const ends = candidate ? fingerprintEnds(candidate) : null;

  useEffect(() => {
    keepRef.current?.focus();
  }, []);

  const run = async (kind: 'trust' | 'recheck', fn: () => Promise<void>) => {
    setBusy(kind);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError((err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      setBusy(null);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      props.onClose();
      return;
    }
    // Enter must never trust a key: only an explicit click (or Space on the focused button) does
    if (e.key === 'Enter' && (e.target as HTMLElement).dataset.trust === 'true') {
      e.preventDefault();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (!focusable || focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onKeyDown={onKeyDown}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="key-change-title"
        className="bg-slate-900 border border-rose-500/40 rounded-2xl p-6 w-full max-w-xl max-h-[90vh] overflow-y-auto space-y-4"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="key-change-title" className="font-bold text-lg flex items-center gap-2">
              <KeyRound className="w-5 h-5 text-rose-300" /> {friend.displayName}'s signing key changed
            </h2>
            <p className="text-xs text-indigo-400 font-mono mt-0.5">{friend.siteUrl}</p>
          </div>
          <button type="button" onClick={props.onClose} className="text-slate-500 hover:text-slate-200 p-1" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-slate-300">
          Their site now signs with a different key, and didn't publish a rotation certificate signed by the old one.
          Until you decide, Studio keeps verifying them with the key you pinned, so nothing they publish now is trusted.
        </p>

        <div className="space-y-1">
          <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Pinned key (trusted now)</p>
          <pre className="text-xs font-mono bg-slate-950 border border-slate-800 rounded-lg p-3 text-slate-300 whitespace-pre">
            {friend.pinnedFingerprint ? formatFingerprint(friend.pinnedFingerprint) : 'No key pinned'}
          </pre>
        </div>

        {candidate ? (
          <div className="space-y-1">
            <p className="text-[11px] font-semibold text-amber-300 uppercase tracking-wide">
              New key{friend.candidateFirstSeenAt ? ` · first seen ${formatDate(friend.candidateFirstSeenAt)}` : ''}
            </p>
            <pre className="text-xs font-mono bg-slate-950 border border-amber-500/40 rounded-lg p-3 text-amber-100 whitespace-pre">
              {formatFingerprint(candidate)}
            </pre>
          </div>
        ) : (
          <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-300">
            Studio needs to re-check this site before you can review the new key.
          </div>
        )}

        {candidate && friend.candidateConflict && (
          <div className="p-3 rounded-xl bg-rose-500/15 border border-rose-500/50 text-xs text-rose-100 flex gap-2">
            <ShieldAlert className="w-4 h-4 text-rose-300 shrink-0 mt-0.5" />
            <p>
              This site has served more than one new key. This can mean someone is impersonating your friend. Don't trust
              it unless your friend confirms the exact fingerprint above.
            </p>
          </div>
        )}

        {props.witness}

        {ends && (
          <div className="p-3 rounded-xl bg-indigo-500/10 border border-indigo-500/30 text-xs text-indigo-100 space-y-1">
            <p>
              Ask {friend.displayName} to read you the first and last 8 characters of their fingerprint (shown in their
              Studio under Profile &amp; Identity) through another channel, such as a call or a message app you already
              use with them.
            </p>
            <p className="font-mono text-indigo-200">
              It should start <strong>{ends.first}</strong> and end <strong>{ends.last}</strong>.
            </p>
          </div>
        )}

        {error && (
          <p className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-xl px-3 py-2 flex gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => run('recheck', () => props.onRecheck(friend))}
            className={`px-3 py-2 rounded-lg text-xs font-semibold flex items-center gap-1.5 disabled:opacity-60 ${
              candidate ? 'bg-slate-800 hover:bg-slate-700 text-slate-200' : 'bg-indigo-600 hover:bg-indigo-500 text-white'
            }`}
          >
            {busy === 'recheck' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Re-check now
          </button>
          <button
            ref={keepRef}
            type="button"
            disabled={busy !== null}
            onClick={props.onClose}
            className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200"
          >
            Keep old key
          </button>
          <button
            type="button"
            data-trust="true"
            disabled={busy !== null || !candidate}
            onClick={() => candidate && run('trust', () => props.onTrust(friend, candidate))}
            className="px-3 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 disabled:opacity-40 text-white text-xs font-semibold flex items-center gap-1.5"
            title={candidate ? 'Pin the new key shown above' : 'Re-check their site first'}
          >
            {busy === 'trust' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Trust this key
          </button>
        </div>
      </div>
    </div>
  );
}
