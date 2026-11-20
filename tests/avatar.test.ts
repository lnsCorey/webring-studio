import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import { AVATAR_PAGE_SCRIPT, friendAvatarSrc, localAvatarDataUri, safeAvatarUrl } from '../src/shared/avatar';
import { StudioDatabase } from '../electron/db/database';
import { StaticSiteGenerator } from '../electron/services/siteGenerator';

const SITE = 'https://friend.example';

describe('Security Phase 6: avatars only from the friend’s own site', () => {
  it('accepts an https avatar on the same origin, and rejects everything else', () => {
    expect(safeAvatarUrl(`${SITE}/media/me.jpg`, SITE)).toBe(`${SITE}/media/me.jpg`);
    expect(safeAvatarUrl(`${SITE}/media/me.jpg`, `${SITE}/blog`)).toBe(`${SITE}/media/me.jpg`);
    for (const bad of [
      'http://friend.example/media/me.jpg',
      'https://tracker.example/pixel.png',
      'https://friend.example.evil.net/me.jpg',
      'https://friend.example:8443/me.jpg',
      'javascript:alert(1)',
      'data:image/svg+xml,<svg onload=alert(1)>',
      '//friend.example/me.jpg',
      'media/me.jpg',
      '',
    ]) {
      expect(safeAvatarUrl(bad, SITE), bad).toBeNull();
    }
    expect(safeAvatarUrl(`${SITE}/me.jpg`, 'not a url')).toBeNull();
    expect(friendAvatarSrc('https://tracker.example/pixel.png', SITE)).toBe(localAvatarDataUri(SITE));
  });

  it('makes the same placeholder for the same site, with the first letter of the hostname', () => {
    const a = localAvatarDataUri('https://www.alice.example');
    expect(a).toBe(localAvatarDataUri('https://www.alice.example'));
    expect(a).not.toBe(localAvatarDataUri('https://bob.example'));
    expect(decodeURIComponent(a)).toMatch(/^data:image\/svg\+xml;charset=utf-8,<svg .*>A<\/text><\/svg>$/);
    // Nothing from the seed reaches the SVG except one letter or digit
    expect(decodeURIComponent(localAvatarDataUri('<script>'))).toContain('>?</text>');
  });

  it('runs the same logic on the published page as in the app', () => {
    const sandbox: Record<string, unknown> = { URL, encodeURIComponent };
    vm.runInNewContext(AVATAR_PAGE_SCRIPT, sandbox);
    const pageSafe = sandbox.safeAvatarUrl as typeof safeAvatarUrl;
    const pageLocal = sandbox.localAvatarDataUri as typeof localAvatarDataUri;
    for (const [avatar, site] of [
      [`${SITE}/a.png`, SITE],
      ['https://other.example/a.png', SITE],
      ['http://friend.example/a.png', SITE],
      ['javascript:alert(1)', SITE],
      ['', SITE],
    ]) {
      expect(pageSafe(avatar, site), avatar).toBe(safeAvatarUrl(avatar, site));
    }
    for (const seed of [SITE, 'https://www.zeta.example/x', 'plain name', '', '1.2.3.4']) {
      expect(pageLocal(seed), seed).toBe(localAvatarDataUri(seed));
    }
  });

  it('has no third-party avatar service anywhere in the app or engine source', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx|js|html|css)$/.test(entry.name) && /dicebear/i.test(fs.readFileSync(full, 'utf8'))) {
          offenders.push(full);
        }
      }
    };
    walk(path.join(__dirname, '../src'));
    walk(path.join(__dirname, '../electron'));
    expect(offenders).toEqual([]);
  });

  it('the published page renders friends through the safe avatar check', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webring-p6-avatar-'));
    const db = new StudioDatabase(dir, 'avatar.sqlite');
    try {
      db.updateProfile({ siteUrl: 'https://me.example', displayName: 'Me', publishSettings: { publishFriendsList: true } });
      db.addOrUpdateFriend({
        siteUrl: SITE,
        displayName: 'Friend',
        avatarUrl: 'https://tracker.example/pixel.png',
        visibility: 'public',
      });
      const out = path.join(dir, 'out');
      new StaticSiteGenerator(db).generateToDirectory(out);
      const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
      expect(html).toContain('safeAvatarUrl(friend.avatarUrl, friend.siteUrl) || localAvatarDataUri(friend.siteUrl)');
      expect(html).toContain('function localAvatarDataUri(seed)');
      expect(html).not.toMatch(/dicebear/i);
    } finally {
      db.close();
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows may still hold the database file
      }
    }
  });
});
