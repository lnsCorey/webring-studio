import React, { useEffect, useRef } from 'react';
import { AlertTriangle, Info, ShieldAlert, X } from 'lucide-react';

/** studio:get-security-status. Phase 7 adds held agent changes. */
export interface SecurityStatusView {
  keyVaultAvailable: boolean;
  proxyUnavailable: boolean;
  agentChangesHeld: boolean;
}

export interface SecurityBannerProps {
  severity: 'error' | 'warning' | 'info';
  title: string;
  message: string;
  actions?: Array<{ label: string; onClick: () => void }>;
  /** Errors stay until fixed; warnings and info can be hidden. */
  dismissible?: boolean;
  onDismiss?: () => void;
}

const STYLES: Record<SecurityBannerProps['severity'], { box: string; icon: React.ReactNode; button: string }> = {
  error: {
    box: 'bg-rose-500/15 border-rose-500/50 text-rose-100',
    icon: <ShieldAlert className="w-4 h-4 text-rose-300 shrink-0 mt-0.5" />,
    button: 'bg-rose-500/25 hover:bg-rose-500/40 border-rose-400/50',
  },
  warning: {
    box: 'bg-amber-500/15 border-amber-500/50 text-amber-100',
    icon: <AlertTriangle className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />,
    button: 'bg-amber-500/25 hover:bg-amber-500/40 border-amber-400/50',
  },
  info: {
    box: 'bg-indigo-500/15 border-indigo-500/40 text-indigo-100',
    icon: <Info className="w-4 h-4 text-indigo-300 shrink-0 mt-0.5" />,
    button: 'bg-indigo-500/25 hover:bg-indigo-500/40 border-indigo-400/50',
  },
};

/**
 * A full-width notice above the main content for safeguards that block, hold or warn: what
 * happened, in plain words, and what to do about it. Several stack. Reused by phase 7 for agent
 * changes held for review.
 */
export function SecurityBanner(props: SecurityBannerProps) {
  const style = STYLES[props.severity];
  const dismissible = props.dismissible ?? props.severity !== 'error';
  return (
    <div
      role={props.severity === 'error' ? 'alert' : 'status'}
      className={`w-full border-b px-6 py-2.5 text-xs flex flex-wrap items-start gap-3 ${style.box}`}
    >
      {style.icon}
      <div className="flex-1 min-w-[16rem]">
        <span className="font-semibold">{props.title}</span> <span className="opacity-90">{props.message}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {(props.actions || []).map((action) => (
          <button
            key={action.label}
            type="button"
            onClick={action.onClick}
            className={`px-2.5 py-1 rounded-lg border font-medium ${style.button}`}
          >
            {action.label}
          </button>
        ))}
        {dismissible && props.onDismiss && (
          <button type="button" onClick={props.onDismiss} className="p-1 opacity-70 hover:opacity-100" aria-label="Hide this notice">
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Asks before a password or token is stored without encryption (the OS keychain isn't available).
 * Cancel is focused and Enter doesn't confirm; only clicking "Store unencrypted" does.
 */
export function PlaintextConsentDialog(props: { secretLabel: string; onAnswer: (allow: boolean) => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
      onKeyDown={(e) => {
        if (e.key === 'Escape') props.onAnswer(false);
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="plaintext-consent-title"
        className="bg-slate-900 border border-amber-500/40 rounded-2xl p-6 w-full max-w-md space-y-4"
      >
        <h2 id="plaintext-consent-title" className="font-bold text-base flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-amber-300" /> Store this {props.secretLabel} without encryption?
        </h2>
        <p className="text-sm text-slate-300">
          This device's secure storage isn't available. Anyone with access to your user account's files could read
          it.
        </p>
        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={() => props.onAnswer(false)}
            className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => props.onAnswer(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.preventDefault();
            }}
            className="px-3 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold"
          >
            Store unencrypted
          </button>
        </div>
      </div>
    </div>
  );
}
