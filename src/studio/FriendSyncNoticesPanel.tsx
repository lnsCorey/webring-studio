import React, { useState } from 'react';
import { RefreshCw, ShieldAlert } from 'lucide-react';

/** database.ts FriendSyncNotice. Local only, never exported. */
export interface FriendSyncNoticeView {
  siteUrl: string;
  friendName: string;
  kind: 'rollback_blocked';
  doc: string;
  servedUpdatedAt: string;
  lastVerifiedUpdatedAt: string;
  createdAt: string;
}

const formatDate = (iso: string) => {
  const date = new Date(iso);
  return iso && !Number.isNaN(date.getTime()) ? date.toLocaleString() : 'an unknown date';
};

/**
 * Rollback notices: a friend's site served an older copy of a document than the one Studio had
 * already verified, so Studio kept the newer copy (and deleted nothing). Usually a stale cache or
 * an interrupted upload on their side; it can also be someone replaying old files.
 */
export function FriendSyncNoticesPanel(props: {
  notices: FriendSyncNoticeView[];
  onDismiss: (notice: FriendSyncNoticeView) => Promise<void>;
  onRecheck: (notice: FriendSyncNoticeView) => Promise<void>;
  errorMessage: (err: unknown) => string;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (props.notices.length === 0) return null;

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(props.errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="bg-slate-900 border border-amber-500/30 rounded-2xl p-5 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-bold text-sm flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 text-amber-300" />
          Older copies refused ({props.notices.length})
        </h3>
        <p className="text-[11px] text-slate-500">
          Studio only moves forward: an older copy can't remove or change posts it already verified.
        </p>
      </div>
      <ul className="space-y-2">
        {props.notices.map((n) => {
          const key = `${n.siteUrl}|${n.doc}`;
          return (
            <li key={key} className="bg-slate-950 border border-slate-800 rounded-xl p-3 space-y-2">
              <p className="text-xs text-slate-200">
                <strong>{n.friendName}</strong> served an older copy of <code>{n.doc}</code> (dated{' '}
                {formatDate(n.servedUpdatedAt)}). Studio kept the newer copy from {formatDate(n.lastVerifiedUpdatedAt)} to
                protect their posts.
              </p>
              <p className="text-[11px] text-slate-500">
                This is usually a cache or an unfinished upload on their side. If it keeps happening, let them know.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => run(`recheck:${key}`, () => props.onRecheck(n))}
                  className="px-2.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-xs font-semibold flex items-center gap-1"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${busy === `recheck:${key}` ? 'animate-spin' : ''}`} /> Re-check now
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => run(`dismiss:${key}`, () => props.onDismiss(n))}
                  className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-60 text-xs"
                >
                  Dismiss
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {error && (
        <p className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-xl px-3 py-2">{error}</p>
      )}
    </div>
  );
}
