import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { PersonaManager } from '../electron/services/personaManager';
import {
  computeSizeLimitStatus,
  DataManagementService,
  formatBackupFileName,
  nextBackupRunAt,
  pruneOldBackups,
} from '../electron/services/dataManagement';

describe('Settings -> Data management & backups', () => {
  const dirs: string[] = [];
  const mkTemp = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webring-data-'));
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    while (dirs.length) {
      try {
        fs.rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        // Windows may hold a brief handle on a temp SQLite file during teardown
      }
    }
  });

  it('computes file size limit warning thresholds accurately', () => {
    expect(computeSizeLimitStatus(50 * 1024 * 1024, 100).level).toBe('ok');
    expect(computeSizeLimitStatus(80 * 1024 * 1024, 100).level).toBe('warning');
    expect(computeSizeLimitStatus(95 * 1024 * 1024, 100).level).toBe('critical');
    expect(computeSizeLimitStatus(120 * 1024 * 1024, 100).level).toBe('critical');
  });

  it('calculates next scheduled run for single, daily, weekly, and monthly modes', () => {
    const anchor = new Date(2026, 10, 23, 10, 0, 0); // Mon Nov 23 2026 10:00 local

    const single = nextBackupRunAt(
      {
        enabled: true,
        mode: 'single',
        singleAt: '2026-11-24T14:30',
        time: '03:00',
        weekday: 0,
        dayOfMonth: 1,
        scope: 'active',
      },
      anchor
    );
    expect(single?.getFullYear()).toBe(2026);
    expect(single?.getHours()).toBe(14);
    expect(single?.getMinutes()).toBe(30);

    const daily = nextBackupRunAt(
      {
        enabled: true,
        mode: 'daily',
        singleAt: '',
        time: '09:00',
        weekday: 0,
        dayOfMonth: 1,
        scope: 'active',
      },
      anchor
    );
    expect(daily?.getDate()).toBe(24);
    expect(daily?.getHours()).toBe(9);

    const weekly = nextBackupRunAt(
      {
        enabled: true,
        mode: 'weekly',
        singleAt: '',
        time: '08:00',
        weekday: 3, // Wednesday
        dayOfMonth: 1,
        scope: 'active',
      },
      anchor
    );
    expect(weekly?.getDay()).toBe(3);
    expect(weekly?.getDate()).toBe(25);

    const monthly = nextBackupRunAt(
      {
        enabled: true,
        mode: 'monthly',
        singleAt: '',
        time: '04:00',
        weekday: 0,
        dayOfMonth: 15,
        scope: 'active',
      },
      anchor
    );
    expect(monthly?.getMonth()).toBe(11); // December
    expect(monthly?.getDate()).toBe(15);
  });

  it('aggregates per-profile dashboard counts, creates WAL-safe backups, prunes oldest beyond limit, and safely restores', async () => {
    const root = mkTemp();
    const backupDir = path.join(root, 'my-backups');
    const pm = new PersonaManager(root);
    const service = new DataManagementService(pm);

    try {
      // Populate primary persona
      const ctx1 = pm.getActiveContext();
      ctx1.db.updateProfile({ displayName: 'Alice', siteUrl: 'https://alice.example' });
      ctx1.db.createItem({ type: 'post', title: 'Hello World', commentary: 'First post' });
      ctx1.db.createItem({ type: 'like', title: 'Liked Post', targetUrl: 'https://bob.example/p/1' });
      ctx1.db.createItem({ type: 'share', title: 'Shared Post', targetUrl: 'https://bob.example/p/2' });
      ctx1.db.addOrUpdateFriend({ siteUrl: 'https://bob.example', displayName: 'Bob', visibility: 'public' });
      ctx1.db.createHostedRing({ name: 'Indie Ring' });

      // Add a second persona
      pm.createPersona({
        label: 'Work',
        displayName: 'Alice Work',
        siteUrl: 'https://work.alice.example',
      });
      const ctx2 = pm.getActiveContext();
      ctx2.db.createItem({ type: 'post', title: 'Work update', commentary: 'Shipping' });

      // Switch back to primary
      pm.switchPersona('default');

      // 1. Dashboard summary
      const dash = await service.getDashboardSummary();
      expect(dash.totals.personas).toBe(2);
      expect(dash.totals.posts).toBe(2);
      expect(dash.totals.likes).toBe(1);
      expect(dash.totals.shares).toBe(1);
      expect(dash.totals.friends).toBe(1);
      expect(dash.totals.rings).toBe(1);
      const primaryRow = dash.profiles.find((p) => p.personaId === 'default')!;
      expect(primaryRow.posts).toBe(1);
      expect(primaryRow.likes).toBe(1);
      expect(primaryRow.shares).toBe(1);
      expect(primaryRow.friends).toBe(1);
      expect(primaryRow.hostedRings).toBe(1);

      // 2. Database status, integrity & compact
      service.saveSettings({ backupDir, maxBackups: 2, fileSizeLimitMb: 50 });
      const status = service.getDatabaseStatus();
      expect(status.sqliteVersion).toMatch(/^\d+\.\d+/);
      expect(status.schemaVersion).toBeGreaterThanOrEqual(5);
      expect(status.totalSizeBytes).toBeGreaterThan(0);
      expect(status.fileSizeLimitMb).toBe(50);
      expect(service.checkActiveDatabaseIntegrity().ok).toBe(true);
      const compactRes = service.compactActiveDatabase();
      expect(compactRes.afterBytes).toBeGreaterThan(0);

      // 3. Run 3 dated backups with retention limit = 2 -> oldest is pruned
      const t1 = new Date(2026, 10, 23, 10, 0, 1);
      const t2 = new Date(2026, 10, 23, 10, 0, 2);
      const t3 = new Date(2026, 10, 23, 10, 0, 3);
      const r1 = await service.runBackup({ scope: 'active', now: t1 });
      expect(r1.created).toHaveLength(1);
      expect(r1.pruned).toHaveLength(0);
      const firstFileName = formatBackupFileName('primary', t1);
      expect(r1.created[0].fileName).toBe(firstFileName);

      // Add a post AFTER backup 1, then take backups 2 & 3
      pm.getActiveContext().db.createItem({ type: 'post', title: 'After backup 1', commentary: 'Later' });
      await service.runBackup({ scope: 'active', now: t2 });
      const r3 = await service.runBackup({ scope: 'active', now: t3 });
      expect(r3.pruned).toEqual([firstFileName]);
      expect(service.listBackups()).toHaveLength(2);

      // 4. Scheduled single backup runs once and auto-disables
      const schedTime = new Date(2026, 10, 23, 11, 0, 0);
      service.saveSettings({
        schedule: {
          enabled: true,
          mode: 'single',
          singleAt: '2026-11-23T11:00',
          time: '03:00',
          weekday: 0,
          dayOfMonth: 1,
          scope: 'all',
        },
      });
      const ran = await service.tick(new Date(schedTime.getTime() + 5000));
      expect(ran).toBe(true);
      const afterSched = service.loadSettings();
      expect(afterSched.schedule.enabled).toBe(false);
      expect(afterSched.schedule.lastRunStatus).toBe('ok');

      // 5. Safe restore from backup 3 (one of the 2 retained backups after scheduled run) + safety snapshot created
      const backup3Path = path.join(backupDir, formatBackupFileName('primary', t3));
      pm.getActiveContext().db.createItem({ type: 'post', title: 'Will be rolled back', commentary: 'Temp' });
      expect(pm.getActiveContext().db.getItems().filter((i) => i.type === 'post')).toHaveLength(3);

      const restored = service.restoreBackup(backup3Path, 'default');
      expect(fs.existsSync(restored.safetySnapshotPath)).toBe(true);
      expect(pm.getActiveContext().db.getItems().filter((i) => i.type === 'post')).toHaveLength(2);
      expect(restored.mediaAudit.missingMediaCount).toBe(0);

      // 6. Reject corrupt backup file on restore
      const badFile = path.join(backupDir, 'corrupt.sqlite');
      fs.writeFileSync(badFile, 'not a sqlite database', 'utf8');
      expect(() => service.restoreBackup(badFile, 'default')).toThrow(/integrity check/i);

      // 7. Prune helper standalone check
      expect(pruneOldBackups(backupDir, 'nonexistent', 2)).toEqual([]);
    } finally {
      pm.close();
    }
  });
});
