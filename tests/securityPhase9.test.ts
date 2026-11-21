import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { StudioDatabase } from '../electron/db/database';
import { MediaLibrary } from '../electron/services/mediaLibrary';
import { safeOutputPath, StaticSiteGenerator } from '../electron/services/siteGenerator';
import { finishLocalExport, isSafeSitePath, planSync } from '../electron/services/publishSync';
import { PersonaManager } from '../electron/services/personaManager';
import { WebringMcpServer } from '../electron/mcp/mcpServer';
import { isAllowedMediaReference, isSafeLocalMediaUrl, parseWebringUri } from '../src/shared/schema';

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

const removeDir = (dir: string) => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows may still hold the database file
  }
};

describe('Security Phase 9: media addresses can only name Media Library files', () => {
  it('accepts plain library paths and rejects anything that could leave the folder', () => {
    for (const ok of ['media/saved/abc123.gif', 'media/albums/album-1/p-web.jpg', 'media/profile/avatar-abc.jpg']) {
      expect(isSafeLocalMediaUrl(ok)).toBe(true);
    }
    for (const bad of [
      'media/saved/x.gif?/../../../../outside/pwned.gif',
      'media/saved/x.gif#/../../evil',
      'media/%2e%2e/%2e%2e/evil',
      'media/saved/..\\..\\evil',
      'media/../evil',
      'media//etc/passwd',
      'media/.hidden/x',
      'media/',
      'MEDIA/saved/x.gif',
      '/etc/passwd',
      'C:\\Windows\\x',
    ]) {
      expect(isSafeLocalMediaUrl(bad)).toBe(false);
    }
    // Web images and empty values are other paths' business
    expect(isAllowedMediaReference('https://cdn.example/x.jpg')).toBe(true);
    expect(isAllowedMediaReference('')).toBe(true);
    expect(isAllowedMediaReference('MEDIA/saved/x.gif?/../../x')).toBe(false);
  });

  it('a webring:// link can pre-fill only a web image', () => {
    const crafted = parseWebringUri(
      `webring://interact?action=share&targetUrl=https%3A%2F%2Fa.test%2Fp&mediaUrl=${encodeURIComponent('media/saved/x.gif?/../../../x')}`
    );
    expect(crafted?.mediaUrl).toBeUndefined();
    const web = parseWebringUri('webring://interact?action=share&targetUrl=https%3A%2F%2Fa.test%2Fp&mediaUrl=https%3A%2F%2Fa.test%2Fi.jpg');
    expect(web?.mediaUrl).toBe('https://a.test/i.jpg');
  });

  it('safeOutputPath and isSafeSitePath refuse escapes', () => {
    const out = path.join(os.tmpdir(), 'webring-p9-out');
    expect(safeOutputPath(out, 'media/saved/a.gif')).toBe(path.resolve(out, 'media/saved/a.gif'));
    expect(() => safeOutputPath(out, 'media/saved/a.gif?/../../../../x')).toThrow(/outside the export folder/);
    expect(() => safeOutputPath(out, path.resolve(os.tmpdir(), 'x'))).toThrow(/outside the export folder/);
    expect(isSafeSitePath('api/items.json')).toBe(true);
    for (const bad of ['../victim.txt', 'media/a/../../../x', '/abs', 'C:/x', 'a\\b', 'a?b', '']) expect(isSafeSitePath(bad)).toBe(false);
    const plan = planSync(new Map(), new Map([['../victim.txt', 'h'], ['old.json', 'h']]));
    expect(plan.remove).toEqual(['old.json']);
  });
});

describe('Security Phase 9: export never writes or deletes outside its folder', () => {
  let tmp: string;
  let dataDir: string;
  let mediaDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webring-p9-'));
    dataDir = path.join(tmp, 'data');
    mediaDir = path.join(tmp, 'media-store');
  });

  afterEach(() => removeDir(tmp));

  it('refuses to store a crafted media address', () => {
    const db = new StudioDatabase(dataDir, 'p9.sqlite');
    try {
      expect(() => db.createItem({ type: 'post', title: 'x', mediaUrl: 'media/saved/a.gif?/../../../../x' })).toThrow(
        /image address isn't valid/
      );
      expect(() => db.updateProfile({ avatarUrl: 'media/../x' })).toThrow(/profile picture address isn't valid/);
      expect(() => db.createAlbum({ title: 'A', coverUrl: 'media/x#/../../y' })).toThrow(/album cover address isn't valid/);
      expect(db.createItem({ type: 'post', title: 'ok', mediaUrl: 'media/saved/abc.gif' }).mediaUrl).toBe('media/saved/abc.gif');
    } finally {
      db.close();
    }
  });

  it('a crafted address already in the database is skipped and reported, and nothing lands outside', async () => {
    const library = new MediaLibrary(mediaDir);
    const saved = await library.importSavedImage(GIF, 'image/gif');
    const out = path.join(tmp, 'site');
    const victim = path.join(tmp, 'outside', 'pwned.gif');
    const poisoned = `${saved}?/../../../../outside/pwned.gif`;

    // Plant the value as an older build could have stored it (migration 5 has already run)
    const db = new StudioDatabase(dataDir, 'p9.sqlite');
    db.updateProfile({ siteUrl: 'https://me.p9.test', displayName: 'Me' });
    const item = db.createItem({ type: 'post', title: 'Poisoned', mediaUrl: saved });
    db.close();
    const raw = new DatabaseSync(path.join(dataDir, 'p9.sqlite'));
    raw.prepare('UPDATE items SET media_url = ? WHERE id = ?').run(poisoned, item.id);
    raw.close();

    const db2 = new StudioDatabase(dataDir, 'p9.sqlite');
    try {
      const result = new StaticSiteGenerator(db2, mediaDir).generateToDirectory(out);
      expect(result.missingMedia).toContain(poisoned);
      expect(fs.existsSync(victim)).toBe(false);
      expect(fs.existsSync(path.join(tmp, 'outside'))).toBe(false);
    } finally {
      db2.close();
    }
  });

  it('migration 5 clears unsafe stored addresses and keeps safe ones', () => {
    const db = new StudioDatabase(dataDir, 'p9.sqlite');
    const good = db.createItem({ type: 'post', title: 'Good', mediaUrl: 'media/saved/abc.gif' });
    const bad = db.createItem({ type: 'post', title: 'Bad', mediaUrl: 'media/saved/abc.gif' });
    db.close();
    const raw = new DatabaseSync(path.join(dataDir, 'p9.sqlite'));
    raw.prepare('UPDATE items SET media_url = ? WHERE id = ?').run('media/saved/abc.gif?/../../x', bad.id);
    raw.exec('PRAGMA user_version = 4');
    raw.close();

    const db2 = new StudioDatabase(dataDir, 'p9.sqlite');
    try {
      expect(db2.getSchemaVersion()).toBeGreaterThanOrEqual(5);
      const byId = new Map(db2.getItems().map((i) => [i.id, i.mediaUrl]));
      expect(byId.get(good.id)).toBe('media/saved/abc.gif');
      expect(byId.get(bad.id)).toBe('');
    } finally {
      db2.close();
    }
  });

  it('a ledger row naming a path outside the folder is dropped, not deleted', () => {
    const out = path.join(tmp, 'site');
    fs.mkdirSync(out, { recursive: true });
    const victim = path.join(tmp, 'victim.txt');
    fs.writeFileSync(victim, 'keep me');
    const db = new StudioDatabase(dataDir, 'p9.sqlite');
    try {
      const destination = `local:${path.resolve(out)}`;
      db.setPublishLedgerEntry(destination, '../victim.txt', 'abc');
      finishLocalExport(db, out, []);
      expect(fs.readFileSync(victim, 'utf8')).toBe('keep me');
      expect(db.getPublishLedger(destination).has('../victim.txt')).toBe(false);
    } finally {
      db.close();
    }
  });

  it('a saved image kept byte for byte must really be that type', async () => {
    const library = new MediaLibrary(mediaDir);
    await expect(library.importSavedImage(Buffer.from('@echo off\r\ncalc\r\n'), 'image/gif')).rejects.toThrow('Not a valid image.');
    await expect(library.importSavedImage(GIF, 'image/gif')).resolves.toMatch(/^media\/saved\/[0-9a-f]+\.gif$/);
    expect(library.resolveLocalUrl('media/saved/x.gif?/../../../x')).toBeNull();
  });

  it('an agent cannot create a post with a crafted address', async () => {
    const manager = new PersonaManager(path.join(tmp, 'personas'));
    try {
      const mcp = new WebringMcpServer(manager, path.join(tmp, 'personas'));
      mcp.setReadOnlyMode(false);
      const res = await mcp.executeToolCall(
        'webring_create_post',
        { title: 'x', commentary: 'x', mediaUrl: 'media/saved/a.gif?/../../../../x' },
        { enforcePolicy: true }
      );
      expect(res.isError).toBe(true);
      expect(manager.getActiveContext().db.getItems().some((i) => i.mediaUrl.includes('?'))).toBe(false);
    } finally {
      manager.closeAll();
    }
  });
});
