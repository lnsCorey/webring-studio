import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { StudioDatabase } from '../electron/db/database';
import { KeyCipher, SecretStorageUnavailableError } from '../electron/security/keyVault';
import { parseProxyUrl, ProxyUnavailableError, redactProxyUrl, requireUsableProxy } from '../electron/security/proxyAgent';
import { planWindowProxy } from '../electron/security/windowProxy';
import { PersonaManager } from '../electron/services/personaManager';
import { runSyncAll } from '../electron/services/jobs';
import { WebringMcpServer } from '../electron/mcp/mcpServer';

/** A keychain stand-in that can be switched off, like safeStorage on a desktop without one. */
function toggleCipher() {
  let available = true;
  const cipher: KeyCipher = {
    isAvailable: () => available,
    encrypt: (plainText) => Buffer.from(plainText, 'utf8').reverse(),
    decrypt: (cipherText) => {
      if (!available) throw new Error('keychain locked');
      return Buffer.from(cipherText).reverse().toString('utf8');
    },
  };
  return { cipher, setAvailable: (value: boolean) => (available = value) };
}

const storedProxyJson = (dbFile: string): { enabled?: boolean; proxyUrl?: string } => {
  const raw = new DatabaseSync(dbFile);
  try {
    const row = raw.prepare("SELECT value FROM local_settings WHERE key = 'proxySettingsJson'").get() as { value: string } | undefined;
    return row ? JSON.parse(row.value) : {};
  } finally {
    raw.close();
  }
};

describe('Security Phase 6: the proxy fails closed, and secrets need consent without a keychain', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webring-p6-proxy-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may still hold a database file
    }
  });

  it('a proxy that cannot be unlocked stops sync before anything connects, once, with ProxyUnavailableError', async () => {
    const { cipher, setAvailable } = toggleCipher();
    const manager = new PersonaManager(dir, { keyCipher: cipher });
    try {
      const ctx = manager.getActiveContext();
      ctx.db.updateProfile({ siteUrl: 'https://me.proxy.test', displayName: 'Me' });
      ctx.db.addOrUpdateFriend({ siteUrl: 'https://friend.proxy.test', displayName: 'Friend' });
      ctx.db.setProxySettings({ enabled: true, proxyUrl: 'socks5h://tor:secret@127.0.0.1:9050' });
      expect(ctx.db.getProxySettings()).toEqual({ enabled: true, proxyUrl: 'socks5h://tor:secret@127.0.0.1:9050' });

      setAvailable(false);
      expect(ctx.db.getProxySettings()).toEqual({ enabled: true, proxyUrl: '', unavailable: true });
      expect(() => requireUsableProxy(ctx.db.getProxySettings())).toThrow(ProxyUnavailableError);

      // Every outbound connection (http, https, SOCKS, a proxy) opens a socket: none may be opened
      const socketConnect = vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (this: net.Socket) {
        throw new Error('A connection was attempted');
      });
      vi.stubGlobal('fetch', () => {
        throw new Error('fetch was called');
      });

      await expect(runSyncAll(ctx)).rejects.toBeInstanceOf(ProxyUnavailableError);
      expect(() => ctx.ringCrawler.assertCanSync()).toThrow(ProxyUnavailableError);
      await expect(ctx.ringCrawler.crawlAllFriends()).rejects.toBeInstanceOf(ProxyUnavailableError);
      const single = await ctx.ringCrawler.crawlFriendSite('https://friend.proxy.test');
      expect(single).toMatchObject({ success: false });
      expect(single.error).toMatch(/paused all network activity/);
      await expect(ctx.webringHubService.add('https://hub.proxy.test')).rejects.toBeInstanceOf(ProxyUnavailableError);

      // The app's windows are blocked too, never sent direct
      expect(planWindowProxy(ctx.db.getProxySettings())).toMatchObject({
        key: 'blocked',
        config: { mode: 'fixed_servers', proxyRules: 'socks5://127.0.0.1:9' },
      });

      expect(socketConnect).not.toHaveBeenCalled();

      // Re-entering the proxy is the way out; toggling without it is refused
      expect(() => ctx.db.setProxySettings({ enabled: false })).toThrow(/Re-enter it/);
    } finally {
      manager.closeAll();
    }
  });

  it('refuses to store a new password, token or proxy login without the keychain unless allowed', async () => {
    const db = new StudioDatabase(dir, 'nokeychain.sqlite');
    try {
      expect(db.isKeyVaultAvailable()).toBe(false);
      expect(() => db.updateProfile({ publishSettings: { password: 'hunter2' } })).toThrow(SecretStorageUnavailableError);
      expect(() => db.updateProfile({ publishSettings: { githubToken: 'ghp_x' } })).toThrow(SecretStorageUnavailableError);
      expect(db.getPublishCredentials()).toEqual({ password: '', githubToken: '' });

      // Other settings, and the masked placeholder from the form, still save
      db.updateProfile({ publishSettings: { host: 'sftp.example', password: '••••••••' } });
      expect(db.getProfile().publishSettings.host).toBe('sftp.example');

      db.updateProfile({ publishSettings: { password: 'hunter2' } }, { allowPlaintext: true });
      expect(db.getPublishCredentials().password).toBe('hunter2');

      // A proxy without a login isn't a secret; one with a login is
      expect(db.setProxySettings({ enabled: true, proxyUrl: 'socks5h://127.0.0.1:9050' }).enabled).toBe(true);
      expect(() => db.setProxySettings({ proxyUrl: 'socks5h://me:pw@127.0.0.1:9050' })).toThrow(SecretStorageUnavailableError);
      expect(db.setProxySettings({ proxyUrl: 'socks5h://me:pw@127.0.0.1:9050' }, { allowPlaintext: true }).proxyUrl).toBe(
        'socks5h://me:pw@127.0.0.1:9050'
      );
    } finally {
      db.close();
    }

    // The MCP never stores one unencrypted (the command-line MCP has no keychain)
    const manager = new PersonaManager(path.join(dir, 'cli'));
    try {
      const mcp = new WebringMcpServer(manager, dir);
      const res = await mcp.executeToolCall('webring_set_proxy', { enabled: true, proxyUrl: 'socks5h://me:topsecret@127.0.0.1:9050' });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/can't be stored from the command-line MCP without OS encryption; use the Studio app/);
      expect(JSON.stringify(mcp.getActivityLog())).not.toContain('topsecret');
    } finally {
      manager.closeAll();
    }
  });

  it('migration 4 seals a proxy stored in plain text once the keychain is available', () => {
    const plain = new StudioDatabase(dir, 'reseal.sqlite');
    plain.setProxySettings({ enabled: true, proxyUrl: 'socks5h://127.0.0.1:9050' });
    plain.close();
    const file = path.join(dir, 'reseal.sqlite');
    expect(storedProxyJson(file).proxyUrl).toBe('socks5h://127.0.0.1:9050');
    const raw = new DatabaseSync(file);
    raw.exec('PRAGMA user_version = 3');
    raw.close();

    const { cipher } = toggleCipher();
    const sealed = new StudioDatabase(dir, 'reseal.sqlite', { keyCipher: cipher });
    try {
      expect(sealed.getSchemaVersion()).toBeGreaterThanOrEqual(4);
      expect(storedProxyJson(file).proxyUrl).toMatch(/^enc:v1:/);
      expect(sealed.getProxySettings()).toEqual({ enabled: true, proxyUrl: 'socks5h://127.0.0.1:9050' });
    } finally {
      sealed.close();
    }
  });

  it('never puts a proxy password in an error message', () => {
    for (const bad of [
      'socks5://user:hunter2@host:99999',
      'socks5://user:hunter2@',
      'socks5://user:hun/ter2@host:99999',
      'not a url user:hunter2@host',
    ]) {
      let message = '';
      try {
        parseProxyUrl(bad);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message, bad).not.toBe('');
      expect(message, bad).not.toContain('hunter2');
      expect(message, bad).not.toContain('hun/ter2');
    }
    expect(redactProxyUrl('socks5h://me:pw@127.0.0.1:9050')).toBe('socks5h://***:***@127.0.0.1:9050');
    expect(redactProxyUrl('socks5h://127.0.0.1:9050')).toBe('socks5h://127.0.0.1:9050');
  });
});
