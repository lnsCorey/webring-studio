import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Database,
  FolderOpen,
  HardDrive,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { HorizontalTabs } from './HorizontalTabs';

export type BackupScheduleMode = 'single' | 'daily' | 'weekly' | 'monthly';

export interface BackupScheduleConfigView {
  enabled: boolean;
  mode: BackupScheduleMode;
  singleAt: string;
  time: string;
  weekday: number;
  dayOfMonth: number;
  scope: 'active' | 'all';
  lastRunAt?: string;
  lastRunStatus?: 'ok' | 'failed';
  lastRunMessage?: string;
}

export interface DataSettingsViewModel {
  fileSizeLimitMb: number;
  backupDir: string;
  maxBackups: number;
  lastBackupAt?: string;
  lastBackupPath?: string;
  lastBackupByPersona: Record<string, { at: string; path: string }>;
  schedule: BackupScheduleConfigView;
}

export interface ProfileDataSummaryView {
  personaId: string;
  label: string;
  displayName: string;
  siteUrl: string;
  isActive: boolean;
  dbFileName: string;
  dbSizeBytes: number;
  mediaSizeBytes: number;
  posts: number;
  likes: number;
  shares: number;
  comments: number;
  albums: number;
  photos: number;
  friends: number;
  publicFriends: number;
  rings: number;
  hostedRings: number;
  hubs: number;
}

export interface DataDashboardSummaryView {
  totals: {
    personas: number;
    dbSizeBytes: number;
    mediaSizeBytes: number;
    posts: number;
    likes: number;
    shares: number;
    comments: number;
    albums: number;
    photos: number;
    friends: number;
    rings: number;
    hubs: number;
  };
  profiles: ProfileDataSummaryView[];
}

export interface MediaAuditView {
  missingMediaCount: number;
  missingMediaUrls: string[];
  unusedMediaCount: number;
  unusedMediaBytes: number;
}

export interface DatabaseStatusView {
  personaId: string;
  personaLabel: string;
  displayName: string;
  dbPath: string;
  sqliteVersion: string;
  schemaVersion: number;
  fileSizeBytes: number;
  walSizeBytes: number;
  shmSizeBytes: number;
  totalSizeBytes: number;
  pageSize: number;
  pageCount: number;
  freelistCount: number;
  mediaSizeBytes: number;
  mediaFileCount: number;
  fileSizeLimitMb: number;
  limitBytes: number;
  limitPercent: number;
  limitLevel: 'ok' | 'warning' | 'critical';
  lastBackupAt?: string;
  lastBackupPath?: string;
  mediaAudit: MediaAuditView;
}

export interface BackupFileEntryView {
  fileName: string;
  filePath: string;
  sizeBytes: number;
  modifiedAt: string;
  personaSlug: string;
}

export interface BackupRunResultView {
  created: Array<{
    personaId: string;
    personaLabel: string;
    fileName: string;
    filePath: string;
    sizeBytes: number;
  }>;
  pruned: string[];
  ranAt: string;
}

export interface RestoreBackupResultView {
  personaId: string;
  personaLabel: string;
  safetySnapshotPath: string;
  mediaAudit: MediaAuditView;
}

export interface DataSettingsApi {
  getDataDashboard: () => Promise<DataDashboardSummaryView>;
  getDatabaseStatus: () => Promise<DatabaseStatusView>;
  getDataSettings: () => Promise<DataSettingsViewModel>;
  saveDataSettings: (patch: Partial<DataSettingsViewModel> & { schedule?: Partial<BackupScheduleConfigView> }) => Promise<DataSettingsViewModel>;
  chooseBackupFolder: () => Promise<string | null>;
  pickRestoreFile: () => Promise<string | null>;
  listBackups: () => Promise<BackupFileEntryView[]>;
  runBackup: (options?: { scope?: 'active' | 'all'; targetDir?: string }) => Promise<BackupRunResultView>;
  deleteBackup: (filePath: string) => Promise<{ ok: boolean }>;
  restoreBackup: (filePath: string, personaId?: string) => Promise<RestoreBackupResultView>;
  compactDatabase: () => Promise<{ beforeBytes: number; afterBytes: number; freedBytes: number }>;
  checkDatabaseIntegrity: () => Promise<{ ok: boolean; messages: string[] }>;
  cleanUnusedMedia: () => Promise<{ removedFiles: number; mediaAudit: MediaAuditView }>;
  revealDataPath: (targetPath: string) => Promise<{ ok: boolean }>;
  onDataBackupCompleted?: (cb: (result: unknown) => void) => () => void;
}

interface DataSettingsViewProps {
  api: DataSettingsApi;
  activePersonaId: string;
  onDatabaseRestored: () => Promise<void>;
  onLimitStatusChange?: (level: 'ok' | 'warning' | 'critical') => void;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDateTime(iso?: string): string {
  if (!iso) return 'Never';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const DataSettingsView: React.FC<DataSettingsViewProps> = ({
  api,
  activePersonaId,
  onDatabaseRestored,
  onLimitStatusChange,
}) => {
  const [subTab, setSubTab] = useState<'dashboard' | 'database' | 'backup'>('dashboard');
  const [dashboard, setDashboard] = useState<DataDashboardSummaryView | null>(null);
  const [dbStatus, setDbStatus] = useState<DatabaseStatusView | null>(null);
  const [settings, setSettings] = useState<DataSettingsViewModel | null>(null);
  const [backups, setBackups] = useState<BackupFileEntryView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  const [integrityResult, setIntegrityResult] = useState<{ ok: boolean; messages: string[] } | null>(null);
  const [restoreReport, setRestoreReport] = useState<RestoreBackupResultView | null>(null);

  // Editable form state synced from settings
  const [limitMbInput, setLimitMbInput] = useState('100');
  const [maxBackupsInput, setMaxBackupsInput] = useState('5');
  const [backupScope, setBackupScope] = useState<'active' | 'all'>('active');

  const refreshAll = useCallback(async () => {
    setLoading(true);
    try {
      const [dash, status, cfg, list] = await Promise.all([
        api.getDataDashboard(),
        api.getDatabaseStatus(),
        api.getDataSettings(),
        api.listBackups(),
      ]);
      setDashboard(dash);
      setDbStatus(status);
      setSettings(cfg);
      setBackups(list);
      setLimitMbInput(String(cfg.fileSizeLimitMb));
      setMaxBackupsInput(String(cfg.maxBackups));
      onLimitStatusChange?.(status.limitLevel);
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoading(false);
    }
  }, [api, onLimitStatusChange]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll, activePersonaId]);

  useEffect(() => {
    if (!api.onDataBackupCompleted) return;
    return api.onDataBackupCompleted(() => {
      void refreshAll();
    });
  }, [api, refreshAll]);

  const handleSaveLimit = async () => {
    const parsed = Math.max(1, Math.min(100_000, Math.round(Number(limitMbInput) || 100)));
    setBusy('limit');
    setNotice(null);
    try {
      await api.saveDataSettings({ fileSizeLimitMb: parsed });
      await refreshAll();
      setNotice({ kind: 'ok', text: `Database file size limit saved (${parsed} MB).` });
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const handleCompact = async () => {
    setBusy('compact');
    setNotice(null);
    try {
      const res = await api.compactDatabase();
      await refreshAll();
      setNotice({
        kind: 'ok',
        text: `Database compacted (${formatBytes(res.beforeBytes)} → ${formatBytes(res.afterBytes)}, freed ${formatBytes(res.freedBytes)}).`,
      });
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const handleIntegrityCheck = async () => {
    setBusy('integrity');
    setNotice(null);
    try {
      const res = await api.checkDatabaseIntegrity();
      setIntegrityResult(res);
      setNotice({
        kind: res.ok ? 'ok' : 'error',
        text: res.ok ? 'SQLite integrity check passed (ok).' : `Integrity issues found: ${res.messages.join('; ')}`,
      });
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const handleCleanUnusedMedia = async () => {
    setBusy('clean-media');
    setNotice(null);
    try {
      const res = await api.cleanUnusedMedia();
      await refreshAll();
      setNotice({
        kind: 'ok',
        text: `Removed ${res.removedFiles} unused local media file${res.removedFiles === 1 ? '' : 's'}.`,
      });
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const handleChooseBackupFolder = async () => {
    const picked = await api.chooseBackupFolder();
    if (!picked) return;
    setBusy('folder');
    try {
      await api.saveDataSettings({ backupDir: picked });
      await refreshAll();
      setNotice({ kind: 'ok', text: `Backup folder updated to ${picked}` });
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const handleSaveBackupConfig = async (patch: Partial<DataSettingsViewModel> & { schedule?: Partial<BackupScheduleConfigView> }) => {
    setBusy('save-backup');
    setNotice(null);
    try {
      const updated = await api.saveDataSettings(patch);
      setSettings(updated);
      setMaxBackupsInput(String(updated.maxBackups));
      setNotice({ kind: 'ok', text: 'Backup settings & schedule saved.' });
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const handleRunBackup = async () => {
    setBusy('run-backup');
    setNotice(null);
    try {
      const res = await api.runBackup({ scope: backupScope });
      await refreshAll();
      const prunedNote = res.pruned.length ? ` Pruned ${res.pruned.length} oldest backup(s) to enforce retention limit.` : '';
      setNotice({
        kind: 'ok',
        text: `Created ${res.created.length} backup${res.created.length === 1 ? '' : 's'} (${res.created.map((c) => c.fileName).join(', ')}).${prunedNote}`,
      });
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const handleDeleteBackup = async (entry: BackupFileEntryView) => {
    if (!window.confirm(`Delete backup "${entry.fileName}"?`)) return;
    setBusy(`del-${entry.fileName}`);
    try {
      await api.deleteBackup(entry.filePath);
      await refreshAll();
      setNotice({ kind: 'ok', text: `Deleted ${entry.fileName}.` });
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const handleRestoreBackup = async (filePath: string, labelForPrompt: string) => {
    const confirmed = window.confirm(
      `Restore the active persona's database from "${labelForPrompt}"?\n\n` +
        `Studio will verify the backup with PRAGMA integrity_check and save an automatic pre-restore safety snapshot of your current database first.`
    );
    if (!confirmed) return;
    setBusy('restore');
    setNotice(null);
    setRestoreReport(null);
    try {
      const report = await api.restoreBackup(filePath);
      setRestoreReport(report);
      await onDatabaseRestored();
      await refreshAll();
      setNotice({
        kind: 'ok',
        text: `Restored database for "${report.personaLabel}". A safety snapshot of your previous DB was saved.`,
      });
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const handlePickAndRestore = async () => {
    const picked = await api.pickRestoreFile();
    if (!picked) return;
    await handleRestoreBackup(picked, picked);
  };

  const tabs = [
    { id: 'dashboard', label: 'Dashboard' },
    {
      id: 'database',
      label: 'Database',
      alert: Boolean(dbStatus && dbStatus.limitLevel !== 'ok'),
    },
    { id: 'backup', label: 'Backup', badge: backups.length },
  ];

  return (
    <div className="max-w-5xl mx-auto space-y-6 pb-12">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2.5">
            <Database className="w-6 h-6 text-indigo-400" />
            Settings · Data
          </h2>
          <p className="text-sm text-slate-400 mt-1">
            Inspect database usage across profiles, monitor file size limits, and manage manual or scheduled SQLite backups.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refreshAll()}
          disabled={loading}
          className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-semibold text-slate-200 flex items-center gap-1.5 transition disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      <HorizontalTabs
        ariaLabel="Data settings sections"
        tabs={tabs}
        activeId={subTab}
        onChange={(id) => setSubTab(id as 'dashboard' | 'database' | 'backup')}
      />

      {notice && (
        <div
          className={`p-3.5 rounded-xl border text-xs flex items-start gap-2.5 ${
            notice.kind === 'error'
              ? 'bg-rose-500/10 border-rose-500/40 text-rose-200'
              : notice.kind === 'warn'
                ? 'bg-amber-500/10 border-amber-500/40 text-amber-200'
                : 'bg-emerald-500/10 border-emerald-500/40 text-emerald-200'
          }`}
        >
          {notice.kind === 'ok' ? (
            <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-400" />
          ) : (
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
          )}
          <span className="flex-1 break-words">{notice.text}</span>
        </div>
      )}

      {/* TAB 1: DASHBOARD */}
      {subTab === 'dashboard' && dashboard && (
        <div className="space-y-6">
          {/* Totals strip */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800">
              <p className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">Profiles</p>
              <p className="text-2xl font-extrabold text-white mt-1">{dashboard.totals.personas}</p>
              <p className="text-[11px] text-slate-400 mt-0.5">
                DB: {formatBytes(dashboard.totals.dbSizeBytes)}
              </p>
            </div>
            <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800">
              <p className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">Posts / Likes / Shares</p>
              <p className="text-2xl font-extrabold text-indigo-300 mt-1">
                {dashboard.totals.posts} / {dashboard.totals.likes} / {dashboard.totals.shares}
              </p>
              <p className="text-[11px] text-slate-400 mt-0.5">
                {dashboard.totals.comments} comments · {dashboard.totals.photos} photos
              </p>
            </div>
            <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800">
              <p className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">Friends &amp; Rings</p>
              <p className="text-2xl font-extrabold text-emerald-300 mt-1">
                {dashboard.totals.friends} / {dashboard.totals.rings}
              </p>
              <p className="text-[11px] text-slate-400 mt-0.5">
                {dashboard.totals.hubs} Webring Hub{dashboard.totals.hubs === 1 ? '' : 's'}
              </p>
            </div>
            <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800">
              <p className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">Media Library</p>
              <p className="text-2xl font-extrabold text-sky-300 mt-1">
                {formatBytes(dashboard.totals.mediaSizeBytes)}
              </p>
              <p className="text-[11px] text-slate-400 mt-0.5">
                {dashboard.totals.albums} album{dashboard.totals.albums === 1 ? '' : 's'}
              </p>
            </div>
          </div>

          {/* Per-profile breakdown */}
          <div className="rounded-2xl bg-slate-900 border border-slate-800 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
              <div>
                <h3 className="font-bold text-base text-white">Breakdown by Profile</h3>
                <p className="text-xs text-slate-400">
                  Each persona has its own isolated SQLite database and Media Library folder.
                </p>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-950/60 text-slate-400 uppercase text-[10px] tracking-wider border-b border-slate-800">
                  <tr>
                    <th className="px-4 py-3">Profile</th>
                    <th className="px-3 py-3 text-right">Posts</th>
                    <th className="px-3 py-3 text-right">Likes</th>
                    <th className="px-3 py-3 text-right">Shares</th>
                    <th className="px-3 py-3 text-right">Friends</th>
                    <th className="px-3 py-3 text-right">Rings</th>
                    <th className="px-3 py-3 text-right">Hubs</th>
                    <th className="px-4 py-3 text-right">DB Size</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {dashboard.profiles.map((p) => (
                    <tr key={p.personaId} className={p.isActive ? 'bg-indigo-500/5' : 'hover:bg-slate-800/30'}>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-white">{p.displayName}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                            {p.label}
                          </span>
                          {p.isActive && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300 font-semibold">
                              Active
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-slate-400 font-mono truncate max-w-xs">{p.dbFileName}</p>
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-slate-200">{p.posts}</td>
                      <td className="px-3 py-3 text-right font-mono text-slate-200">{p.likes}</td>
                      <td className="px-3 py-3 text-right font-mono text-slate-200">{p.shares}</td>
                      <td className="px-3 py-3 text-right font-mono text-slate-200">
                        {p.friends}
                        <span className="text-slate-500 text-[10px] ml-1">({p.publicFriends} pub)</span>
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-slate-200">
                        {p.rings}
                        {p.hostedRings > 0 && (
                          <span className="text-slate-500 text-[10px] ml-1">({p.hostedRings} hosted)</span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-slate-200">{p.hubs}</td>
                      <td className="px-4 py-3 text-right font-mono text-slate-200">{formatBytes(p.dbSizeBytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: DATABASE */}
      {subTab === 'database' && dbStatus && (
        <div className="space-y-6">
          {dbStatus.limitLevel !== 'ok' && (
            <div
              className={`p-4 rounded-2xl border flex items-start gap-3 ${
                dbStatus.limitLevel === 'critical'
                  ? 'bg-rose-500/15 border-rose-500/40 text-rose-100'
                  : 'bg-amber-500/15 border-amber-500/40 text-amber-100'
              }`}
            >
              <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5 text-amber-400" />
              <div className="text-xs space-y-1">
                <p className="font-bold text-sm">
                  {dbStatus.limitLevel === 'critical'
                    ? 'Database file size has reached or exceeded your limit'
                    : 'Database file size is approaching your configured limit'}
                </p>
                <p className="opacity-90">
                  Current size is <strong>{formatBytes(dbStatus.totalSizeBytes)}</strong> ({dbStatus.limitPercent}% of your{' '}
                  {dbStatus.fileSizeLimitMb} MB limit). Run <strong>Compact (VACUUM)</strong> below or increase the limit.
                </p>
              </div>
            </div>
          )}

          {/* Core details grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800">
              <p className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">SQLite / Schema Version</p>
              <p className="text-xl font-extrabold text-white mt-1">v{dbStatus.sqliteVersion}</p>
              <p className="text-[11px] text-slate-400 mt-0.5">Studio Schema v{dbStatus.schemaVersion}</p>
            </div>
            <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800">
              <p className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">Database File Size</p>
              <p className="text-xl font-extrabold text-indigo-300 mt-1">{formatBytes(dbStatus.totalSizeBytes)}</p>
              <p className="text-[11px] text-slate-400 mt-0.5">
                Main {formatBytes(dbStatus.fileSizeBytes)} · WAL {formatBytes(dbStatus.walSizeBytes)}
              </p>
            </div>
            <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800">
              <p className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">Last Backup</p>
              <p className="text-sm font-bold text-white mt-1.5">{formatDateTime(dbStatus.lastBackupAt)}</p>
              <p className="text-[11px] text-slate-400 mt-0.5 truncate" title={dbStatus.lastBackupPath || ''}>
                {dbStatus.lastBackupPath ? dbStatus.lastBackupPath : 'No backup recorded yet'}
              </p>
            </div>
            <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800">
              <p className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">File Size Limit</p>
              <p className="text-xl font-extrabold text-white mt-1">{dbStatus.fileSizeLimitMb} MB</p>
              <p className="text-[11px] text-slate-400 mt-0.5">{dbStatus.limitPercent}% used</p>
            </div>
          </div>

          {/* Size Limit Progress & Editor */}
          <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-bold text-base text-white flex items-center gap-2">
                  <HardDrive className="w-4 h-4 text-indigo-400" />
                  File Size Limit &amp; Warning Threshold
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Studio warns you at 80% usage and alerts you at 95%. Active profile: <strong>{dbStatus.displayName}</strong>.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={100000}
                  value={limitMbInput}
                  onChange={(e) => setLimitMbInput(e.target.value)}
                  className="w-24 px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-xs text-white font-mono"
                />
                <span className="text-xs text-slate-400">MB</span>
                <button
                  type="button"
                  onClick={handleSaveLimit}
                  disabled={busy === 'limit'}
                  className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold flex items-center gap-1.5 transition disabled:opacity-50"
                >
                  <Save className="w-3.5 h-3.5" />
                  Save Limit
                </button>
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="h-2.5 w-full rounded-full bg-slate-800 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${
                    dbStatus.limitLevel === 'critical'
                      ? 'bg-rose-500'
                      : dbStatus.limitLevel === 'warning'
                        ? 'bg-amber-400'
                        : 'bg-emerald-500'
                  }`}
                  style={{ width: `${Math.min(100, Math.max(2, dbStatus.limitPercent))}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <span>
                  {formatBytes(dbStatus.totalSizeBytes)} of {dbStatus.fileSizeLimitMb} MB ({dbStatus.limitPercent}%)
                </span>
                <button
                  type="button"
                  onClick={() => void api.revealDataPath(dbStatus.dbPath)}
                  className="text-indigo-300 hover:text-indigo-200 inline-flex items-center gap-1"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  Reveal DB File
                </button>
              </div>
            </div>
          </div>

          {/* Maintenance & Media Reference Health */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-3">
              <h3 className="font-bold text-sm text-white flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-indigo-400" />
                Database Maintenance
              </h3>
              <p className="text-xs text-slate-400">
                {dbStatus.pageCount} pages ({formatBytes(dbStatus.pageSize)} each) · {dbStatus.freelistCount} reclaimable free page
                {dbStatus.freelistCount === 1 ? '' : 's'}.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={handleCompact}
                  disabled={busy !== null}
                  className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-semibold text-white transition disabled:opacity-50"
                >
                  {busy === 'compact' ? 'Compacting…' : 'Compact Database (VACUUM)'}
                </button>
                <button
                  type="button"
                  onClick={handleIntegrityCheck}
                  disabled={busy !== null}
                  className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-semibold text-white flex items-center gap-1.5 transition disabled:opacity-50"
                >
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                  {busy === 'integrity' ? 'Checking…' : 'Check Integrity'}
                </button>
              </div>
              {integrityResult && (
                <p className={`text-xs font-mono ${integrityResult.ok ? 'text-emerald-300' : 'text-rose-300'}`}>
                  Result: {integrityResult.messages.join('; ')}
                </p>
              )}
            </div>

            <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-3">
              <h3 className="font-bold text-sm text-white">Local Media Reference Check</h3>
              <p className="text-xs text-slate-400">
                Media Library uses <strong>{formatBytes(dbStatus.mediaSizeBytes)}</strong> across {dbStatus.mediaFileCount} file
                {dbStatus.mediaFileCount === 1 ? '' : 's'} (stored outside SQLite).
              </p>
              <div className="text-xs space-y-1">
                <p className={dbStatus.mediaAudit.missingMediaCount > 0 ? 'text-amber-300' : 'text-emerald-300'}>
                  Missing local media references: <strong>{dbStatus.mediaAudit.missingMediaCount}</strong>
                </p>
                <p className={dbStatus.mediaAudit.unusedMediaCount > 0 ? 'text-amber-300' : 'text-slate-300'}>
                  Unused/orphaned local media files: <strong>{dbStatus.mediaAudit.unusedMediaCount}</strong> (
                  {formatBytes(dbStatus.mediaAudit.unusedMediaBytes)})
                </p>
              </div>
              {dbStatus.mediaAudit.unusedMediaCount > 0 && (
                <button
                  type="button"
                  onClick={handleCleanUnusedMedia}
                  disabled={busy !== null}
                  className="px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-200 text-xs font-semibold transition disabled:opacity-50"
                >
                  {busy === 'clean-media' ? 'Cleaning…' : 'Clean Up Unused Local Media'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: BACKUP */}
      {subTab === 'backup' && settings && (
        <div className="space-y-6">
          {/* Manual Backup & Destination */}
          <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h3 className="font-bold text-base text-white">Manual Database Backup</h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Creates a dated, WAL-safe copy using SQLite <code className="text-slate-300">VACUUM INTO</code>.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label="Manual backup scope"
                  value={backupScope}
                  onChange={(e) => setBackupScope(e.target.value as 'active' | 'all')}
                  className="px-2.5 py-2 rounded-lg bg-slate-950 border border-slate-700 text-xs text-white"
                >
                  <option value="active">Active Persona Only</option>
                  <option value="all">All Personas</option>
                </select>
                <button
                  type="button"
                  onClick={handleRunBackup}
                  disabled={busy !== null}
                  className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center gap-1.5 shadow transition disabled:opacity-50"
                >
                  <Database className="w-3.5 h-3.5" />
                  {busy === 'run-backup' ? 'Backing Up…' : 'Back Up Now'}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2 border-t border-slate-800">
              <div className="md:col-span-2 space-y-1">
                <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  Backup Destination Folder
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    readOnly
                    value={settings.backupDir}
                    className="flex-1 px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-xs font-mono text-slate-200 truncate"
                  />
                  <button
                    type="button"
                    onClick={handleChooseBackupFolder}
                    className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-semibold text-white shrink-0"
                  >
                    Browse…
                  </button>
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  Backup Retention Limit (per persona)
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={maxBackupsInput}
                    onChange={(e) => setMaxBackupsInput(e.target.value)}
                    className="w-20 px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-xs font-mono text-white"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      void handleSaveBackupConfig({
                        maxBackups: Math.max(1, Math.min(100, Math.floor(Number(maxBackupsInput) || 5))),
                      })
                    }
                    disabled={busy !== null}
                    className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition disabled:opacity-50"
                  >
                    Save
                  </button>
                </div>
                <p className="text-[10px] text-slate-500">Oldest backup is replaced once limit is reached.</p>
              </div>
            </div>
          </div>

          {/* Backup Scheduler */}
          <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-bold text-base text-white flex items-center gap-2">
                  <CalendarClock className="w-4 h-4 text-indigo-400" />
                  Backup Scheduler
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Run a one-time or recurring backup automatically while Studio is open (or running in the tray).
                </p>
              </div>
              <label className="inline-flex items-center gap-2 cursor-pointer text-xs font-semibold text-slate-200">
                <input
                  type="checkbox"
                  checked={settings.schedule.enabled}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      schedule: { ...settings.schedule, enabled: e.target.checked },
                    })
                  }
                  className="rounded border-slate-600 bg-slate-950 text-indigo-500"
                />
                Enable Scheduled Backups
              </label>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="space-y-1">
                <label className="text-[11px] font-semibold text-slate-400">Frequency</label>
                <select
                  value={settings.schedule.mode}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      schedule: { ...settings.schedule, mode: e.target.value as BackupScheduleMode },
                    })
                  }
                  className="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-xs text-white"
                >
                  <option value="single">Single (One-Time)</option>
                  <option value="daily">Repeated · Daily</option>
                  <option value="weekly">Repeated · Weekly</option>
                  <option value="monthly">Repeated · Monthly</option>
                </select>
              </div>

              {settings.schedule.mode === 'single' ? (
                <div className="space-y-1 sm:col-span-2">
                  <label className="text-[11px] font-semibold text-slate-400">Date &amp; Time</label>
                  <input
                    type="datetime-local"
                    value={settings.schedule.singleAt}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        schedule: { ...settings.schedule, singleAt: e.target.value },
                      })
                    }
                    className="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-xs text-white"
                  />
                </div>
              ) : (
                <>
                  {settings.schedule.mode === 'weekly' && (
                    <div className="space-y-1">
                      <label className="text-[11px] font-semibold text-slate-400">Day of Week</label>
                      <select
                        value={settings.schedule.weekday}
                        onChange={(e) =>
                          setSettings({
                            ...settings,
                            schedule: { ...settings.schedule, weekday: Number(e.target.value) },
                          })
                        }
                        className="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-xs text-white"
                      >
                        {WEEKDAYS.map((day, idx) => (
                          <option key={day} value={idx}>
                            {day}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  {settings.schedule.mode === 'monthly' && (
                    <div className="space-y-1">
                      <label className="text-[11px] font-semibold text-slate-400">Day of Month (1–28)</label>
                      <input
                        type="number"
                        min={1}
                        max={28}
                        value={settings.schedule.dayOfMonth}
                        onChange={(e) =>
                          setSettings({
                            ...settings,
                            schedule: { ...settings.schedule, dayOfMonth: Number(e.target.value) || 1 },
                          })
                        }
                        className="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-xs text-white"
                      />
                    </div>
                  )}
                  <div className="space-y-1">
                    <label className="text-[11px] font-semibold text-slate-400">Time</label>
                    <input
                      type="time"
                      value={settings.schedule.time}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          schedule: { ...settings.schedule, time: e.target.value },
                        })
                      }
                      className="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-xs text-white"
                    />
                  </div>
                </>
              )}

              <div className="space-y-1">
                <label className="text-[11px] font-semibold text-slate-400">Personas to Back Up</label>
                <select
                  value={settings.schedule.scope}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      schedule: { ...settings.schedule, scope: e.target.value as 'active' | 'all' },
                    })
                  }
                  className="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-xs text-white"
                >
                  <option value="active">Active Persona</option>
                  <option value="all">All Personas</option>
                </select>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-800">
              <div className="text-[11px] text-slate-400">
                {settings.schedule.lastRunAt ? (
                  <span>
                    Last scheduled run: <strong className="text-slate-200">{formatDateTime(settings.schedule.lastRunAt)}</strong> —{' '}
                    <span className={settings.schedule.lastRunStatus === 'failed' ? 'text-rose-300' : 'text-emerald-300'}>
                      {settings.schedule.lastRunMessage || settings.schedule.lastRunStatus}
                    </span>
                  </span>
                ) : (
                  <span>No scheduled backup has run yet.</span>
                )}
              </div>
              <button
                type="button"
                onClick={() => void handleSaveBackupConfig({ schedule: settings.schedule })}
                disabled={busy !== null}
                className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold flex items-center gap-1.5 transition disabled:opacity-50"
              >
                <Save className="w-3.5 h-3.5" />
                Save Schedule
              </button>
            </div>
          </div>

          {/* Post-Restore Report */}
          {restoreReport && (
            <div className="p-4 rounded-2xl bg-indigo-500/10 border border-indigo-500/30 space-y-2 text-xs">
              <p className="font-bold text-indigo-200">Restore Complete · Media &amp; Publish Checklist</p>
              <p className="text-slate-300">
                Safety snapshot of previous database saved at:{' '}
                <code className="text-indigo-200 break-all">{restoreReport.safetySnapshotPath}</code>
              </p>
              <ul className="list-disc list-inside text-slate-300 space-y-1">
                <li>
                  Missing local media references:{' '}
                  <strong className={restoreReport.mediaAudit.missingMediaCount > 0 ? 'text-amber-300' : 'text-emerald-300'}>
                    {restoreReport.mediaAudit.missingMediaCount}
                  </strong>
                  {restoreReport.mediaAudit.missingMediaCount > 0 &&
                    ' (photos deleted after the backup are no longer in local media-store/)'}
                </li>
                <li>
                  Unused local media files:{' '}
                  <strong className={restoreReport.mediaAudit.unusedMediaCount > 0 ? 'text-amber-300' : 'text-emerald-300'}>
                    {restoreReport.mediaAudit.unusedMediaCount}
                  </strong>{' '}
                  ({formatBytes(restoreReport.mediaAudit.unusedMediaBytes)})
                </li>
                <li>
                  <strong>Republish your site</strong> when ready — Studio automatically removes any albums created after the backup from GitHub Pages / SFTP.
                </li>
              </ul>
              {restoreReport.mediaAudit.unusedMediaCount > 0 && (
                <button
                  type="button"
                  onClick={handleCleanUnusedMedia}
                  disabled={busy !== null}
                  className="px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-200 text-xs font-semibold transition"
                >
                  Clean Up Unused Local Media
                </button>
              )}
            </div>
          )}

          {/* Existing Backups & Restore */}
          <div className="rounded-2xl bg-slate-900 border border-slate-800 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-bold text-base text-white">Saved Backups ({backups.length})</h3>
                <p className="text-xs text-slate-400">
                  Backups contain your SQLite database (posts, metadata, friends, rings, settings). Media files stay in <code className="text-slate-300">media-store/</code>.
                </p>
              </div>
              <button
                type="button"
                onClick={handlePickAndRestore}
                disabled={busy !== null}
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-semibold text-slate-200 flex items-center gap-1.5 transition"
              >
                <RotateCcw className="w-3.5 h-3.5 text-amber-400" />
                Restore from File…
              </button>
            </div>
            {backups.length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-400">
                No dated backup files found in <span className="font-mono text-slate-300">{settings.backupDir}</span> yet.
              </div>
            ) : (
              <div className="divide-y divide-slate-800/70">
                {backups.map((entry) => (
                  <div
                    key={entry.filePath}
                    className="px-5 py-3 flex flex-wrap items-center justify-between gap-3 hover:bg-slate-800/30"
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-mono font-semibold text-white truncate">{entry.fileName}</p>
                      <p className="text-[11px] text-slate-400">
                        {formatDateTime(entry.modifiedAt)} · {formatBytes(entry.sizeBytes)} · profile:{' '}
                        <span className="text-slate-300">{entry.personaSlug}</span>
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => void api.revealDataPath(entry.filePath)}
                        className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-[11px] text-slate-200 inline-flex items-center gap-1"
                        title="Reveal in folder"
                      >
                        <FolderOpen className="w-3 h-3" />
                        Reveal
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleRestoreBackup(entry.filePath, entry.fileName)}
                        disabled={busy !== null}
                        className="px-2.5 py-1 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 text-[11px] font-semibold text-amber-200 inline-flex items-center gap-1 disabled:opacity-50"
                        title="Restore active persona from this backup"
                      >
                        <RotateCcw className="w-3 h-3" />
                        Restore
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDeleteBackup(entry)}
                        disabled={busy !== null}
                        className="p-1.5 rounded-lg bg-slate-800 hover:bg-rose-600/30 text-slate-400 hover:text-rose-200 transition disabled:opacity-50"
                        title="Delete backup"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
