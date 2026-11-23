import * as fs from 'fs';
import * as path from 'path';
import { StudioDatabase } from '../db/database';
import { cleanUpLibrary, MediaLibrary } from './mediaLibrary';
import { PersonaManager } from './personaManager';

export type BackupScheduleMode = 'single' | 'daily' | 'weekly' | 'monthly';

export interface BackupScheduleConfig {
  enabled: boolean;
  mode: BackupScheduleMode;
  /** Local datetime string 'YYYY-MM-DDTHH:mm' for single (one-time) backups */
  singleAt: string;
  /** Local 'HH:mm' time for daily / weekly / monthly backups */
  time: string;
  /** 0 (Sunday) .. 6 (Saturday) for weekly backups */
  weekday: number;
  /** 1 .. 28 for monthly backups */
  dayOfMonth: number;
  /** Whether to back up only the active persona or all personas */
  scope: 'active' | 'all';
  lastRunAt?: string;
  lastRunStatus?: 'ok' | 'failed';
  lastRunMessage?: string;
}

export interface DataSettings {
  fileSizeLimitMb: number;
  backupDir: string;
  maxBackups: number;
  lastBackupAt?: string;
  lastBackupPath?: string;
  lastBackupByPersona: Record<string, { at: string; path: string }>;
  schedule: BackupScheduleConfig;
}

export interface ProfileDataSummary {
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

export interface DataDashboardSummary {
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
  profiles: ProfileDataSummary[];
}

export interface MediaAuditResult {
  missingMediaCount: number;
  missingMediaUrls: string[];
  unusedMediaCount: number;
  unusedMediaBytes: number;
}

export interface DatabaseStatusReport {
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
  mediaAudit: MediaAuditResult;
}

export interface BackupFileEntry {
  fileName: string;
  filePath: string;
  sizeBytes: number;
  modifiedAt: string;
  personaSlug: string;
}

export interface BackupRunResult {
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

export interface RestoreBackupResult {
  personaId: string;
  personaLabel: string;
  safetySnapshotPath: string;
  mediaAudit: MediaAuditResult;
}

export function defaultDataSettings(userDataDir: string): DataSettings {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const defaultSingleAt = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}T09:00`;
  return {
    fileSizeLimitMb: 100,
    backupDir: path.join(userDataDir, 'backups'),
    maxBackups: 5,
    lastBackupByPersona: {},
    schedule: {
      enabled: false,
      mode: 'daily',
      singleAt: defaultSingleAt,
      time: '03:00',
      weekday: 0,
      dayOfMonth: 1,
      scope: 'active',
    },
  };
}

export function personaBackupSlug(personaId: string, label: string): string {
  const base = (personaId === 'default' ? 'primary' : personaId || label || 'persona')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'persona';
}

export function formatBackupFileName(personaSlug: string, date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('-') + '_' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('-');
  return `webring-studio-${personaSlug}-${stamp}.sqlite`;
}

export function computeSizeLimitStatus(
  totalBytes: number,
  limitMb: number
): { limitBytes: number; percent: number; level: 'ok' | 'warning' | 'critical' } {
  const safeLimitMb = Math.max(1, Number.isFinite(limitMb) ? limitMb : 100);
  const limitBytes = safeLimitMb * 1024 * 1024;
  const percent = Math.min(999, Math.round((totalBytes / limitBytes) * 1000) / 10);
  const level: 'ok' | 'warning' | 'critical' =
    percent >= 95 ? 'critical' : percent >= 80 ? 'warning' : 'ok';
  return { limitBytes, percent, level };
}

function parseTimeHm(time: string): { hours: number; minutes: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec((time || '').trim());
  const hours = m ? Math.min(23, Math.max(0, Number(m[1]))) : 3;
  const minutes = m ? Math.min(59, Math.max(0, Number(m[2]))) : 0;
  return { hours, minutes };
}

/**
 * Computes the next scheduled backup moment strictly after `anchor` (for recurring schedules)
 * or at `singleAt` (for one-time schedules). Returns null if disabled or invalid.
 */
export function nextBackupRunAt(schedule: BackupScheduleConfig, anchor = new Date()): Date | null {
  if (!schedule.enabled) return null;
  if (schedule.mode === 'single') {
    const parsed = new Date(schedule.singleAt);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const { hours, minutes } = parseTimeHm(schedule.time);
  const candidate = new Date(anchor);
  candidate.setSeconds(0, 0);

  if (schedule.mode === 'daily') {
    candidate.setHours(hours, minutes, 0, 0);
    if (candidate <= anchor) candidate.setDate(candidate.getDate() + 1);
    return candidate;
  }

  if (schedule.mode === 'weekly') {
    const targetDay = ((Math.round(schedule.weekday) % 7) + 7) % 7;
    const diff = (targetDay - candidate.getDay() + 7) % 7;
    candidate.setDate(candidate.getDate() + diff);
    candidate.setHours(hours, minutes, 0, 0);
    if (candidate <= anchor) candidate.setDate(candidate.getDate() + 7);
    return candidate;
  }

  // monthly (1..28)
  const targetDom = Math.min(28, Math.max(1, Math.round(schedule.dayOfMonth || 1)));
  candidate.setDate(targetDom);
  candidate.setHours(hours, minutes, 0, 0);
  if (candidate <= anchor) {
    candidate.setMonth(candidate.getMonth() + 1);
    candidate.setDate(targetDom);
    candidate.setHours(hours, minutes, 0, 0);
  }
  return candidate;
}

/**
 * Deletes the oldest matching backup files for `personaSlug` in `backupDir` whenever the
 * total exceeds `maxBackups`. Returns the deleted filenames.
 */
export function pruneOldBackups(backupDir: string, personaSlug: string, maxBackups: number): string[] {
  const limit = Math.max(1, Math.floor(maxBackups));
  if (!fs.existsSync(backupDir)) return [];
  const prefix = `webring-studio-${personaSlug}-`;
  const matching = fs
    .readdirSync(backupDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.sqlite'))
    .map((name) => {
      const full = path.join(backupDir, name);
      const stat = fs.statSync(full);
      return { name, full, mtimeMs: stat.mtimeMs };
    })
    // Sort oldest first by filename timestamp (lexicographic YYYY-MM-DD_HH-mm-ss), tie-break by mtime
    .sort((a, b) => a.name.localeCompare(b.name) || a.mtimeMs - b.mtimeMs);

  const pruned: string[] = [];
  while (matching.length > limit) {
    const oldest = matching.shift()!;
    try {
      fs.rmSync(oldest.full, { force: true });
      pruned.push(oldest.name);
    } catch {
      // ignore locked files
    }
  }
  return pruned;
}

/** Audits local Media Library files against what the persona's SQLite DB references. */
export function auditPersonaMedia(db: StudioDatabase, library: MediaLibrary): MediaAuditResult {
  const { urls, originals } = db.getLocalMediaReferences();
  for (const url of db.getSavedMediaReferences()) urls.add(url);

  const missingMediaUrls: string[] = [];
  const keepFiles = new Set<string>();
  for (const url of urls) {
    const resolved = library.resolveLocalUrl(url);
    if (!resolved || !fs.existsSync(resolved)) {
      missingMediaUrls.push(url);
    } else {
      keepFiles.add(path.resolve(resolved));
    }
  }
  for (const orig of originals) keepFiles.add(path.resolve(orig));

  let unusedMediaCount = 0;
  let unusedMediaBytes = 0;
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.resolve(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (!keepFiles.has(full)) {
        unusedMediaCount++;
        try {
          unusedMediaBytes += fs.statSync(full).size;
        } catch {
          // ignore
        }
      }
    }
  };
  for (const sub of ['albums', 'originals', 'profile', 'saved']) {
    walk(path.join(library.rootDir, sub));
  }

  return {
    missingMediaCount: missingMediaUrls.length,
    missingMediaUrls,
    unusedMediaCount,
    unusedMediaBytes,
  };
}

export class DataManagementService {
  private settingsPath: string;
  private timer: NodeJS.Timeout | null = null;
  private runningBackup = false;

  constructor(
    private personaManager: PersonaManager,
    private onBackupCompleted?: (result: BackupRunResult) => void
  ) {
    this.settingsPath = path.join(personaManager.getUserDataDir(), 'data-settings.json');
  }

  public loadSettings(): DataSettings {
    const defaults = defaultDataSettings(this.personaManager.getUserDataDir());
    if (!fs.existsSync(this.settingsPath)) return defaults;
    try {
      const raw = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8')) as Partial<DataSettings>;
      return {
        ...defaults,
        ...raw,
        fileSizeLimitMb: Math.max(1, Math.min(100_000, Number(raw.fileSizeLimitMb) || defaults.fileSizeLimitMb)),
        maxBackups: Math.max(1, Math.min(100, Math.floor(Number(raw.maxBackups) || defaults.maxBackups))),
        backupDir: typeof raw.backupDir === 'string' && raw.backupDir.trim() ? raw.backupDir.trim() : defaults.backupDir,
        lastBackupByPersona:
          raw.lastBackupByPersona && typeof raw.lastBackupByPersona === 'object' ? raw.lastBackupByPersona : {},
        schedule: {
          ...defaults.schedule,
          ...(raw.schedule && typeof raw.schedule === 'object' ? raw.schedule : {}),
        },
      };
    } catch {
      return defaults;
    }
  }

  public saveSettings(patch: Partial<DataSettings> & { schedule?: Partial<BackupScheduleConfig> }): DataSettings {
    const current = this.loadSettings();
    const next: DataSettings = {
      ...current,
      ...patch,
      fileSizeLimitMb: Math.max(
        1,
        Math.min(100_000, Number(patch.fileSizeLimitMb ?? current.fileSizeLimitMb) || current.fileSizeLimitMb)
      ),
      maxBackups: Math.max(
        1,
        Math.min(100, Math.floor(Number(patch.maxBackups ?? current.maxBackups) || current.maxBackups))
      ),
      backupDir:
        typeof patch.backupDir === 'string' && patch.backupDir.trim()
          ? patch.backupDir.trim()
          : current.backupDir,
      lastBackupByPersona: patch.lastBackupByPersona ?? current.lastBackupByPersona,
      schedule: {
        ...current.schedule,
        ...(patch.schedule || {}),
      },
    };
    fs.mkdirSync(path.dirname(this.settingsPath), { recursive: true });
    fs.writeFileSync(this.settingsPath, JSON.stringify(next, null, 2), 'utf8');
    return next;
  }

  public async getDashboardSummary(): Promise<DataDashboardSummary> {
    const activeCtx = this.personaManager.getActiveContext();
    const activeId = activeCtx.persona.id;
    const records = this.personaManager.listPersonaRecords();
    const profiles: ProfileDataSummary[] = [];

    const summarize = (
      rec: { id: string; label: string; dbFileName: string; mediaDirName: string },
      db: StudioDatabase,
      mediaLibrary: MediaLibrary
    ): ProfileDataSummary => {
      const profile = db.getProfile();
      const items = db.getItems();
      const albums = db.getAlbums();
      const friends = db.getFriends();
      const joinedRings = db.getWebrings();
      const hostedRings = db.getHostedRings();
      const hubs = db.getWebringHubs();
      const diag = db.getDatabaseDiagnostics();
      const mediaUsage = mediaLibrary.storageUsage();

      let posts = 0;
      let likes = 0;
      let shares = 0;
      let comments = 0;
      for (const item of items) {
        if (item.type === 'post') posts++;
        else if (item.type === 'like') likes++;
        else if (item.type === 'share') shares++;
        else if (item.type === 'comment') comments++;
      }
      const photos = albums.reduce((sum, a) => sum + a.photos.length, 0);
      const publicFriends = friends.filter((f) => f.visibility === 'public').length;
      const uniqueRingKeys = new Set<string>([
        ...joinedRings.map((r) => (r.hubUrl || r.id).toLowerCase()),
        ...hostedRings.map((r) => (r.hubUrl || r.id).toLowerCase()),
      ]);

      return {
        personaId: rec.id,
        label: rec.label,
        displayName: profile.displayName,
        siteUrl: profile.siteUrl,
        isActive: rec.id === activeId,
        dbFileName: rec.dbFileName,
        dbSizeBytes: diag.totalSizeBytes,
        mediaSizeBytes: mediaUsage.bytes,
        posts,
        likes,
        shares,
        comments,
        albums: albums.length,
        photos,
        friends: friends.length,
        publicFriends,
        rings: uniqueRingKeys.size,
        hostedRings: hostedRings.length,
        hubs: hubs.length,
      };
    };

    for (const rec of records) {
      if (rec.id === activeId) {
        profiles.push(summarize(rec, activeCtx.db, activeCtx.mediaLibrary));
      } else {
        await this.personaManager.withPersonaContext(rec.id, async (ctx) => {
          profiles.push(summarize(rec, ctx.db, ctx.mediaLibrary));
        });
      }
    }

    const totals = profiles.reduce(
      (acc, p) => ({
        personas: acc.personas + 1,
        dbSizeBytes: acc.dbSizeBytes + p.dbSizeBytes,
        mediaSizeBytes: acc.mediaSizeBytes + p.mediaSizeBytes,
        posts: acc.posts + p.posts,
        likes: acc.likes + p.likes,
        shares: acc.shares + p.shares,
        comments: acc.comments + p.comments,
        albums: acc.albums + p.albums,
        photos: acc.photos + p.photos,
        friends: acc.friends + p.friends,
        rings: acc.rings + p.rings,
        hubs: acc.hubs + p.hubs,
      }),
      {
        personas: 0,
        dbSizeBytes: 0,
        mediaSizeBytes: 0,
        posts: 0,
        likes: 0,
        shares: 0,
        comments: 0,
        albums: 0,
        photos: 0,
        friends: 0,
        rings: 0,
        hubs: 0,
      }
    );

    return { totals, profiles };
  }

  public getDatabaseStatus(): DatabaseStatusReport {
    const ctx = this.personaManager.getActiveContext();
    const settings = this.loadSettings();
    const diag = ctx.db.getDatabaseDiagnostics();
    const mediaUsage = ctx.mediaLibrary.storageUsage();
    const limit = computeSizeLimitStatus(diag.totalSizeBytes, settings.fileSizeLimitMb);
    const lastForPersona = settings.lastBackupByPersona[ctx.persona.id];
    const mediaAudit = auditPersonaMedia(ctx.db, ctx.mediaLibrary);

    return {
      personaId: ctx.persona.id,
      personaLabel: ctx.persona.label,
      displayName: ctx.persona.displayName,
      dbPath: ctx.db.dbPath,
      ...diag,
      mediaSizeBytes: mediaUsage.bytes,
      mediaFileCount: mediaUsage.files,
      fileSizeLimitMb: settings.fileSizeLimitMb,
      limitBytes: limit.limitBytes,
      limitPercent: limit.percent,
      limitLevel: limit.level,
      lastBackupAt: lastForPersona?.at ?? settings.lastBackupAt,
      lastBackupPath: lastForPersona?.path ?? settings.lastBackupPath,
      mediaAudit,
    };
  }

  public listBackups(): BackupFileEntry[] {
    const settings = this.loadSettings();
    if (!settings.backupDir || !fs.existsSync(settings.backupDir)) return [];
    const entries: BackupFileEntry[] = [];
    for (const name of fs.readdirSync(settings.backupDir)) {
      if (!name.endsWith('.sqlite')) continue;
      const full = path.join(settings.backupDir, name);
      try {
        const stat = fs.statSync(full);
        if (!stat.isFile()) continue;
        const m = /^webring-studio-(.+?)-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.sqlite$/.exec(name);
        entries.push({
          fileName: name,
          filePath: full,
          sizeBytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          personaSlug: m ? m[1] : 'custom',
        });
      } catch {
        // ignore unreadable entries
      }
    }
    return entries.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }

  public async runBackup(options: { scope?: 'active' | 'all'; targetDir?: string; now?: Date } = {}): Promise<BackupRunResult> {
    if (this.runningBackup) {
      throw new Error('A database backup is already in progress.');
    }
    this.runningBackup = true;
    try {
      const settings = this.loadSettings();
      const targetDir = (options.targetDir || settings.backupDir || '').trim();
      if (!targetDir) {
        throw new Error('Choose a backup destination folder first.');
      }
      fs.mkdirSync(targetDir, { recursive: true });

      const now = options.now ?? new Date();
      const scope = options.scope ?? 'active';
      const activeId = this.personaManager.getActivePersonaId();
      const targets =
        scope === 'all'
          ? this.personaManager.listPersonaRecords()
          : this.personaManager.listPersonaRecords().filter((p) => p.id === activeId);

      const created: BackupRunResult['created'] = [];
      const pruned: string[] = [];
      const lastBackupByPersona = { ...settings.lastBackupByPersona };

      for (const rec of targets) {
        const slug = personaBackupSlug(rec.id, rec.label);
        const fileName = formatBackupFileName(slug, now);
        const filePath = path.join(targetDir, fileName);

        if (rec.id === activeId) {
          this.personaManager.getActiveContext().db.vacuumInto(filePath);
        } else {
          await this.personaManager.withPersonaContext(rec.id, async (ctx) => {
            ctx.db.vacuumInto(filePath);
          });
        }

        const sizeBytes = fs.statSync(filePath).size;
        created.push({
          personaId: rec.id,
          personaLabel: rec.label,
          fileName,
          filePath,
          sizeBytes,
        });
        lastBackupByPersona[rec.id] = { at: now.toISOString(), path: filePath };
        pruned.push(...pruneOldBackups(targetDir, slug, settings.maxBackups));
      }

      const lastCreated = created[created.length - 1];
      this.saveSettings({
        backupDir: targetDir,
        lastBackupAt: now.toISOString(),
        lastBackupPath: lastCreated?.filePath ?? settings.lastBackupPath,
        lastBackupByPersona,
      });

      const result: BackupRunResult = { created, pruned, ranAt: now.toISOString() };
      this.onBackupCompleted?.(result);
      return result;
    } finally {
      this.runningBackup = false;
    }
  }

  public deleteBackup(filePath: string): void {
    const settings = this.loadSettings();
    const resolvedDir = path.resolve(settings.backupDir) + path.sep;
    const resolvedFile = path.resolve(filePath);
    if (!resolvedFile.startsWith(resolvedDir) || !resolvedFile.endsWith('.sqlite')) {
      throw new Error('Refusing to delete a file outside the configured backup folder.');
    }
    if (fs.existsSync(resolvedFile)) {
      fs.rmSync(resolvedFile, { force: true });
    }
  }

  public restoreBackup(backupFilePath: string, personaId?: string): RestoreBackupResult {
    const targetPersonaId = personaId || this.personaManager.getActivePersonaId();
    const restored = this.personaManager.restorePersonaDatabase(targetPersonaId, backupFilePath);
    const active = this.personaManager.getActiveContext();
    const mediaAudit = auditPersonaMedia(active.db, active.mediaLibrary);
    return {
      ...restored,
      mediaAudit,
    };
  }

  public compactActiveDatabase(): { beforeBytes: number; afterBytes: number; freedBytes: number } {
    return this.personaManager.getActiveContext().db.compact();
  }

  public checkActiveDatabaseIntegrity(): { ok: boolean; messages: string[] } {
    return this.personaManager.getActiveContext().db.checkIntegrity();
  }

  public cleanUnusedMedia(): { removedFiles: number; mediaAudit: MediaAuditResult } {
    const ctx = this.personaManager.getActiveContext();
    const removedFiles = cleanUpLibrary(ctx.db, ctx.mediaLibrary);
    const mediaAudit = auditPersonaMedia(ctx.db, ctx.mediaLibrary);
    return { removedFiles, mediaAudit };
  }

  /** Evaluates whether a scheduled backup is due at `now` and executes it if so. */
  public async tick(now = new Date()): Promise<boolean> {
    const settings = this.loadSettings();
    const sched = settings.schedule;
    if (!sched.enabled || this.runningBackup) return false;

    const anchor = sched.lastRunAt ? new Date(sched.lastRunAt) : new Date(now.getTime() - 60_000);
    let due = false;
    if (sched.mode === 'single') {
      const target = new Date(sched.singleAt);
      if (!Number.isNaN(target.getTime()) && now >= target) due = true;
    } else {
      const next = nextBackupRunAt(sched, anchor);
      if (next && now >= next) due = true;
    }
    if (!due) return false;

    try {
      const result = await this.runBackup({ scope: sched.scope, now });
      this.saveSettings({
        schedule: {
          ...sched,
          enabled: sched.mode === 'single' ? false : sched.enabled,
          lastRunAt: now.toISOString(),
          lastRunStatus: 'ok',
          lastRunMessage: `Backed up ${result.created.length} database${result.created.length === 1 ? '' : 's'}${
            result.pruned.length ? ` (pruned ${result.pruned.length} old)` : ''
          }.`,
        },
      });
      return true;
    } catch (err) {
      this.saveSettings({
        schedule: {
          ...sched,
          lastRunAt: now.toISOString(),
          lastRunStatus: 'failed',
          lastRunMessage: err instanceof Error ? err.message : String(err),
        },
      });
      return false;
    }
  }

  public startScheduler(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, 30_000);
  }

  public stopScheduler(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
