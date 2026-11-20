import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, FileKey, KeyRound, ShieldAlert } from 'lucide-react';
import { formatFingerprint } from '../shared/fingerprint';

export type SftpAuthMethod = 'password' | 'privateKey' | 'agent';

/** The publish settings these controls read and change. */
export interface SftpSettingsView {
  protocol: 'sftp' | 'ftp';
  host: string;
  password?: string;
  sftpAuthMethod?: SftpAuthMethod;
  sftpUseAgent?: boolean;
  sftpPrivateKeyPath?: string;
  sftpKeyPassphrase?: string;
  ftpAllowInsecure?: boolean;
}

export interface SftpHostKeyView {
  host: string;
  port: number;
  fingerprint: string;
  pinnedAt: string;
}

export interface SftpHostKeyApi {
  pickSftpKey?: () => Promise<{ fileName: string } | null>;
  getSftpHostKey?: () => Promise<{ pinned: SftpHostKeyView | null }>;
  forgetSftpHostKey?: () => Promise<unknown>;
}

/** Older settings don't store the method: the agent, else a key file, else the password. */
export function authMethodOf(settings: SftpSettingsView): SftpAuthMethod {
  if (settings.sftpAuthMethod) return settings.sftpAuthMethod;
  if (settings.sftpUseAgent) return 'agent';
  if (settings.sftpPrivateKeyPath) return 'privateKey';
  return 'password';
}

const fileNameOf = (p?: string) => (p ? p.split(/[\\/]/).pop() || p : '');

export const FTP_INSECURE_WARNING =
  "Your password and site files will be sent in clear text. Only use this if your host doesn't support FTPS.";

/**
 * The SFTP card's sign-in method and pinned server key, and FTP's "Allow unencrypted FTP".
 * The key file path is chosen by the main process's file picker; the window only shows its name.
 */
export function SftpSecurityControls(props: {
  settings: SftpSettingsView;
  onChange: (changes: Partial<SftpSettingsView>) => void;
  api: SftpHostKeyApi | undefined;
  askConfirm: (request: { title: string; message: React.ReactNode; confirmLabel: string }) => Promise<boolean>;
  notify: (message: string) => void;
  /** Bumped after a publish, so the pinned key is read again. */
  refreshKey?: number;
}) {
  const { settings, onChange, api } = props;
  const method = authMethodOf(settings);
  const [pinned, setPinned] = useState<SftpHostKeyView | null>(null);

  useEffect(() => {
    if (settings.protocol !== 'sftp') return;
    void api?.getSftpHostKey?.().then((res) => setPinned(res?.pinned || null), () => setPinned(null));
  }, [api, settings.protocol, settings.host, props.refreshKey]);

  if (settings.protocol === 'ftp') {
    return (
      <div className="space-y-2">
        <label
          className={`flex items-start gap-2 text-xs p-3 rounded-xl border ${
            settings.ftpAllowInsecure ? 'border-amber-500/60 bg-amber-500/10' : 'border-amber-500/30 bg-slate-950'
          }`}
        >
          <input
            type="checkbox"
            checked={Boolean(settings.ftpAllowInsecure)}
            onChange={async (e) => {
              const next = e.target.checked;
              if (
                next &&
                !(await props.askConfirm({ title: 'Allow unencrypted FTP?', message: FTP_INSECURE_WARNING, confirmLabel: 'Allow unencrypted FTP' }))
              ) {
                return;
              }
              onChange({ ftpAllowInsecure: next });
            }}
            className="accent-amber-500 mt-0.5"
          />
          <span>
            <span className="font-semibold text-amber-200">Allow unencrypted FTP</span>
            <span className="block text-slate-400 mt-0.5">{FTP_INSECURE_WARNING}</span>
          </span>
        </label>
        {settings.ftpAllowInsecure && (
          <p className="text-[11px] text-amber-300 flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5" /> Unencrypted FTP is on. Save the settings to keep it.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3 p-3 rounded-xl bg-slate-950 border border-slate-800">
      <div className="flex flex-wrap items-center gap-4 text-xs text-slate-200" role="radiogroup" aria-label="Sign in with">
        <span className="text-slate-400">Sign in with:</span>
        {(
          [
            ['password', 'Password'],
            ['privateKey', 'Private key file'],
            ['agent', 'SSH agent'],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="flex items-center gap-1.5">
            <input
              type="radio"
              name="sftp-auth-method"
              checked={method === value}
              onChange={() => onChange({ sftpAuthMethod: value, sftpUseAgent: value === 'agent' })}
              className="accent-indigo-500"
            />
            {label}
          </label>
        ))}
      </div>

      {method === 'privateKey' && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={async () => {
              const picked = await api?.pickSftpKey?.();
              if (picked) {
                onChange({ sftpAuthMethod: 'privateKey', sftpPrivateKeyPath: picked.fileName });
                props.notify(`Using key file ${picked.fileName}.`);
              }
            }}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium flex items-center gap-1.5"
          >
            <FileKey className="w-3.5 h-3.5" /> Choose key file…
          </button>
          <span className="text-xs font-mono text-slate-300">{fileNameOf(settings.sftpPrivateKeyPath) || 'No key file chosen'}</span>
          <input
            type="password"
            value={settings.sftpKeyPassphrase || ''}
            onChange={(e) => onChange({ sftpKeyPassphrase: e.target.value })}
            placeholder="Passphrase (optional)"
            aria-label="Key passphrase"
            className="flex-1 min-w-[10rem] px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-xs"
          />
        </div>
      )}
      {method === 'agent' && (
        <p className="text-[11px] text-slate-400">Uses keys loaded in your SSH agent (Pageant / OpenSSH agent on Windows).</p>
      )}

      <div className="text-[11px] text-slate-400 flex flex-wrap items-center gap-2 border-t border-slate-800 pt-2">
        <KeyRound className="w-3.5 h-3.5 text-slate-500" />
        {pinned ? (
          <>
            <span>
              Server key: <code className="text-slate-200 whitespace-pre-wrap">{formatFingerprint(pinned.fingerprint)}</code>
              {pinned.pinnedAt ? ` · pinned ${new Date(pinned.pinnedAt).toLocaleDateString()}` : ''}
            </span>
            <button
              type="button"
              onClick={async () => {
                if (
                  !(await props.askConfirm({
                    title: 'Forget the pinned server key?',
                    message: 'The next publish will trust whatever key the server presents. Only do this if your host told you the key changed.',
                    confirmLabel: 'Forget pinned key',
                  }))
                ) {
                  return;
                }
                await api?.forgetSftpHostKey?.();
                setPinned(null);
                props.notify('Forgot the pinned server key.');
              }}
              className="text-rose-300 hover:text-rose-200 font-medium"
            >
              Forget pinned key
            </button>
          </>
        ) : (
          <span>Not yet connected — the server's key will be pinned on first publish.</span>
        )}
      </div>
    </div>
  );
}

/**
 * Shown when an SFTP publish found a different server key than the pinned one. Cancel is the
 * default; trusting needs a second confirmation and pins only the key the server presented.
 */
export function HostKeyMismatchDialog(props: {
  mismatch: { host: string; port: number; expectedFingerprint: string; presentedFingerprint: string };
  onCancel: () => void;
  onTrust: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, [confirming]);
  const { mismatch } = props;
  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
      onKeyDown={(e) => {
        if (e.key === 'Escape') props.onCancel();
      }}
    >
      <div role="alertdialog" aria-modal="true" aria-labelledby="host-key-title" className="bg-slate-900 border border-rose-500/50 rounded-2xl p-6 w-full max-w-xl space-y-4">
        <h2 id="host-key-title" className="font-bold text-lg flex items-center gap-2">
          <ShieldAlert className="w-5 h-5 text-rose-300" /> The server's identity has changed
        </h2>
        <p className="text-xs text-slate-300">
          <code>
            {mismatch.host}:{mismatch.port}
          </code>{' '}
          presented a different key than the one pinned at an earlier publish. Nothing was uploaded.
        </p>
        <div className="space-y-1">
          <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Expected (pinned)</p>
          <pre className="text-xs font-mono bg-slate-950 border border-slate-800 rounded-lg p-3 whitespace-pre">{formatFingerprint(mismatch.expectedFingerprint)}</pre>
        </div>
        <div className="space-y-1">
          <p className="text-[11px] font-semibold text-rose-300 uppercase tracking-wide">Presented now</p>
          <pre className="text-xs font-mono bg-slate-950 border border-rose-500/40 rounded-lg p-3 whitespace-pre">{formatFingerprint(mismatch.presentedFingerprint)}</pre>
        </div>
        <p className="text-xs text-amber-200 bg-amber-500/10 border border-amber-500/30 rounded-xl p-3">
          This can happen if your host rebuilt the server, or if someone is intercepting your connection. Check with your
          hosting provider before continuing.
        </p>
        {confirming && (
          <p className="text-xs text-rose-200">
            Are you sure? Studio will trust this new key from now on and upload your site to this server.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button ref={cancelRef} type="button" onClick={props.onCancel} className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold">
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              if (!confirming) {
                setConfirming(true);
                return;
              }
              setBusy(true);
              try {
                await props.onTrust();
              } finally {
                setBusy(false);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.preventDefault();
            }}
            className="px-3 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white text-xs font-semibold"
          >
            {confirming ? 'Yes, trust it and publish' : 'Trust new key and publish'}
          </button>
        </div>
      </div>
    </div>
  );
}
